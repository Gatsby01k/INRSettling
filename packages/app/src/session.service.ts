/**
 * Session establishment and validation — SECURITY.md § 3.1.
 *
 * The rule the frozen document sets is that a second factor is mandatory for
 * every user in every workspace. This service is where that becomes true: the
 * only way to obtain a session is through `establishSession`, and it refuses
 * without a verified factor.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  DEVICE_MISMATCH_REVOCATION_REASON, evaluateSessionEstablishment, isSessionUsable,
  type MfaMethod, type PrincipalRef, type TenantScope,
} from '@inrsettle/domain'
import { eventSink } from './events.js'
import { rolesFor } from './membership.service.js'

export class AuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export async function verifiedMfaMethods(tx: Db, userId: string): Promise<MfaMethod[]> {
  const rows = await tx
    .select({ method: schema.userMfaMethods.method, verifiedAt: schema.userMfaMethods.verifiedAt })
    .from(schema.userMfaMethods)
    .where(eq(schema.userMfaMethods.userId, userId))
  return rows.filter((r) => r.verifiedAt !== null).map((r) => r.method)
}

export interface EstablishSessionInput {
  userId: string
  presentedMfaMethod?: MfaMethod
  deviceFingerprint?: string
  now?: Date
}

export type EstablishResult =
  | { ok: true; sessionId: string; expiresAt: Date; mfaMethod: MfaMethod }
  | { ok: false; code: string; message: string }

/**
 * Returns a result rather than throwing.
 *
 * A refusal writes an audit row, and throwing out of the caller's transaction
 * would roll that row back — the record of the refusal would be destroyed by
 * the refusal itself. So the outcome is returned, the transaction commits, and
 * the caller decides what to do with it.
 */
export async function establishSession(
  tx: Db, scope: TenantScope, input: EstablishSessionInput,
): Promise<EstablishResult> {
  const [user] = await tx
    .select({ id: schema.users.id, disabledAt: schema.users.disabledAt })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1)

  const [workspace] = await tx
    .select({ kyb: schema.workspaces.kybStatus })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, scope.workspaceId))
    .limit(1)

  // RLS makes `users` visible only through a membership in the current scope,
  // so an absent row means "not a member here", not "disabled". Reporting the
  // latter would be both wrong and a small information leak in the other
  // direction — it would imply the account exists.
  const roles = await rolesFor(tx, scope, input.userId)
  const decision = evaluateSessionEstablishment({
    userDisabled: !!user && user.disabledAt !== null,
    // A suspended workspace cannot establish new sessions.
    workspaceActive: !!workspace && workspace.kyb !== 'suspended',
    roles,
    verifiedMfaMethods: await verifiedMfaMethods(tx, input.userId),
    ...(input.presentedMfaMethod ? { presentedMfaMethod: input.presentedMfaMethod } : {}),
    environment: scope.environment,
  })

  if (!decision.allowed) {
    await eventSink(tx).audit(scope, {
      actor: { type: 'user', id: input.userId },
      action: 'session.refused',
      subjectType: 'user',
      subjectId: input.userId,
      after: { code: decision.code },
    })
    return { ok: false, code: decision.code, message: decision.message }
  }

  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + decision.ttlSeconds * 1000)
  const sessionId = newId('session')

  await tx.insert(schema.sessions).values({
    id: sessionId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    userId: input.userId,
    mfaMethod: decision.mfaMethod,
    deviceFingerprint: input.deviceFingerprint ?? null,
    expiresAt,
  })

  await eventSink(tx).audit(scope, {
    actor: { type: 'user', id: input.userId },
    action: 'session.established',
    subjectType: 'session',
    subjectId: sessionId,
    after: { mfaMethod: decision.mfaMethod, expiresAt: expiresAt.toISOString() },
  })

  return { ok: true, sessionId, expiresAt, mfaMethod: decision.mfaMethod }
}

/** Convenience for call sites that genuinely want an exception. */
export async function establishSessionOrThrow(
  tx: Db, scope: TenantScope, input: EstablishSessionInput,
): Promise<{ sessionId: string; expiresAt: Date; mfaMethod: MfaMethod }> {
  const r = await establishSession(tx, scope, input)
  if (!r.ok) throw new AuthError(r.message, r.code)
  return r
}

export interface ActivePrincipal {
  principal: PrincipalRef
  userId: string
  sessionId: string
}

export interface ResolveOptions {
  /** The device context presented with this request. */
  deviceFingerprint?: string | undefined
  now?: Date
}

export type ResolveResult =
  | ({ ok: true } & ActivePrincipal)
  | { ok: false; code: string; message: string }

/**
 * Resolve a session to a principal, or refuse.
 *
 * Expiry is evaluated server-side, and the session is **bound to the device
 * context it was established with** (SECURITY.md § 3.1). A session established
 * with a fingerprint may only be resolved by presenting the same one: a session
 * id replayed from somewhere else is refused *and revoked*, since a mismatch is
 * the signature of a stolen token rather than an ordinary error.
 *
 * Returns a result rather than throwing, for the same reason
 * `establishSession` does: a refusal here writes a revocation and an audit row,
 * and throwing out of the caller's transaction would roll both back — the
 * defensive action would be undone by the refusal that triggered it. Any path
 * that must record something before refusing has to return, not throw.
 */
export async function resolveSession(
  tx: Db, scope: TenantScope, sessionId: string, opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const now = opts.now ?? new Date()
  const [s] = await tx
    .select()
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.id, sessionId),
      eq(schema.sessions.workspaceId, scope.workspaceId),
      eq(schema.sessions.environment, scope.environment),
    ))
    .limit(1)

  if (!s) return { ok: false, code: 'session_not_found', message: 'No such session.' }
  if (!isSessionUsable({ revokedAt: s.revokedAt, expiresAt: s.expiresAt }, now)) {
    return s.revokedAt
      ? { ok: false, code: 'session_revoked', message: 'This session was revoked.' }
      : { ok: false, code: 'session_expired', message: 'This session has expired.' }
  }

  if (s.deviceFingerprint !== null && s.deviceFingerprint !== opts.deviceFingerprint) {
    await tx.update(schema.sessions)
      .set({ revokedAt: now, revokedReason: DEVICE_MISMATCH_REVOCATION_REASON })
      .where(eq(schema.sessions.id, sessionId))
    await eventSink(tx).audit(scope, {
      actor: { type: 'user', id: s.userId },
      action: 'session.device_mismatch',
      subjectType: 'session',
      subjectId: sessionId,
      after: { presented: opts.deviceFingerprint ?? null },
    })
    return {
      ok: false,
      code: 'session_device_mismatch',
      message: 'This session is bound to a different device.',
    }
  }

  await tx.update(schema.sessions)
    .set({ lastSeenAt: now })
    .where(eq(schema.sessions.id, sessionId))

  return { ok: true, principal: { type: 'user', id: s.userId }, userId: s.userId, sessionId }
}

/** Convenience for call sites that genuinely want an exception. */
export async function resolveSessionOrThrow(
  tx: Db, scope: TenantScope, sessionId: string, opts: ResolveOptions = {},
): Promise<ActivePrincipal> {
  const r = await resolveSession(tx, scope, sessionId, opts)
  if (!r.ok) throw new AuthError(r.message, r.code)
  return r
}

export async function revokeSession(
  tx: Db, scope: TenantScope, sessionId: string, reason: string,
): Promise<void> {
  await tx.update(schema.sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(
      eq(schema.sessions.id, sessionId),
      eq(schema.sessions.workspaceId, scope.workspaceId),
      eq(schema.sessions.environment, scope.environment),
      isNull(schema.sessions.revokedAt),
    ))
}

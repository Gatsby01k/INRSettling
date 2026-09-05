/**
 * Operator sessions — `SECURITY.md § 3.1`.
 *
 * > Session authentication for `app` and `ops`. Email identity with a second
 * > factor that is **mandatory, not optional**, for every user in every
 * > workspace… Sessions are short, **bound to a device fingerprint**,
 * > revocable from settings, and invalidated on role change. `ops` sessions are
 * > shorter still and **additionally network-restricted**.
 *
 * *Additionally* is the word that governs this file. An ops session carries
 * every restriction a customer session carries — MFA, a short life, device
 * binding — and then the network one on top. Each is made structural rather
 * than remembered:
 *
 * **No scope.** An operator session is not established inside a workspace,
 * because an operator does not belong to one. Every function here takes the
 * unscoped pool.
 *
 * **The network allow-list has no default.** `establishOperatorSession` requires
 * one and refuses an empty list. `SECURITY.md` names no ranges because the
 * ranges are a deployment fact; a default here would become the answer by
 * accident, and the accident is *every network is allowed*. Same reasoning as
 * `D-05b`'s TTL, and the same shape: configuration, supplied, validated.
 *
 * **Which policy admitted the address is written down.** Not just the address.
 * A year later, when the allow-list has changed twice, "was this session
 * legitimate" is answerable from the row rather than from someone's memory of
 * what the ranges used to be.
 *
 * **The device fingerprint is mandatory**, where `sessions.device_fingerprint`
 * is nullable. A customer may be admitted without one; an operator may not. On
 * a mismatch the session is **revoked**, not merely refused — the same
 * fail-closed semantics `resolveSession` uses, and for the same reason: a
 * session id presented from somewhere else is the signature of a stolen token
 * rather than an ordinary error, so the right response is to end it.
 *
 * **Every check runs on every request.** `resolveOperatorSession` takes a
 * *required* request context — address, fingerprint and policy — rather than
 * options it can do without. An optional address is an address that is
 * sometimes absent, and a network restriction that is skipped when the caller
 * forgot to pass one is not a restriction. The type refuses the call rather
 * than the code refusing the request.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema, withoutScope } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  OPS_SESSION_TTL_SECONDS,
  internalCapabilitiesFor,
  type InternalCapability, type MfaMethod,
} from '@inrsettle/domain'
import type { InternalRole, PrincipalRef } from '@inrsettle/contracts'

/* ── The network restriction ────────────────────────────────────────────── */

export interface NetworkPolicy {
  /** A name for this allow-list, recorded on the session it admits. */
  readonly name: string
  /** IPv4 or IPv6 CIDR blocks. An empty list is refused, not treated as "any". */
  readonly allowedCidrs: readonly string[]
}

export class EmptyNetworkPolicy extends Error {
  constructor() {
    super(
      'an operator network policy must name at least one CIDR block ' +
      '(SECURITY.md § 3.1) — an empty allow-list is not "allow everything"',
    )
    this.name = 'EmptyNetworkPolicy'
  }
}

/**
 * Does this address fall inside the allow-list?
 *
 * Asked of Postgres rather than implemented here. `inet` containment is a
 * database type with correct IPv4 and IPv6 semantics, including the ones people
 * get wrong by hand — `::ffff:10.0.0.1` is not inside `10.0.0.0/8` as text, a
 * `/0` is every address, and a hand-rolled octet comparison silently accepts a
 * malformed mask. Getting this wrong fails open, so it is not hand-rolled.
 */
export async function addressIsAllowed(
  db: Db, policy: NetworkPolicy, ip: string,
): Promise<boolean> {
  if (policy.allowedCidrs.length === 0) throw new EmptyNetworkPolicy()
  const rows = (await withoutScope(db, (conn) => conn.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM unnest(${sql.raw(`ARRAY[${policy.allowedCidrs
        .map((c) => `'${c.replace(/'/g, "''")}'`).join(',')}]::inet[]`)}) AS allowed
       WHERE ${ip}::inet <<= allowed
    ) AS ok`))) as unknown as { ok: boolean }[]
  return rows[0]?.ok === true
}

/* ── Establishing ───────────────────────────────────────────────────────── */

export interface EstablishOperatorSessionInput {
  readonly operatorId: string
  /** Mandatory. The column is NOT NULL, so a session without one cannot exist. */
  readonly mfaMethod: MfaMethod
  /** Mandatory too, and for the same reason (`SECURITY.md § 3.1`). */
  readonly deviceFingerprint: string
  readonly ip: string
  readonly userAgent?: string
  readonly policy: NetworkPolicy
  readonly now?: Date
}

export type EstablishOperatorSessionResult =
  | { ok: true; sessionId: string; expiresAt: Date }
  | {
      ok: false
      reason: 'unknown_operator' | 'operator_suspended' | 'network_not_allowed'
        | 'device_fingerprint_missing'
    }

export async function establishOperatorSession(
  db: Db, input: EstablishOperatorSessionInput,
): Promise<EstablishOperatorSessionResult> {
  if (input.policy.allowedCidrs.length === 0) throw new EmptyNetworkPolicy()

  // Refused before anything is written. An empty string would satisfy the type
  // and defeat the binding, so it is checked rather than assumed — the database
  // CHECK refuses it too, and this is the half that gives a usable answer.
  if (input.deviceFingerprint.trim().length === 0) {
    return { ok: false, reason: 'device_fingerprint_missing' }
  }

  // The network check runs next and still outside the write, so a refused
  // address leaves no session row and no partial state to reason about.
  if (!(await addressIsAllowed(db, input.policy, input.ip))) {
    return { ok: false, reason: 'network_not_allowed' }
  }

  const now = input.now ?? new Date()
  return withoutScope(db, async (conn) => {
    const [operator] = await conn.select().from(schema.internalOperators)
      .where(eq(schema.internalOperators.id, input.operatorId)).limit(1)
    if (!operator) return { ok: false, reason: 'unknown_operator' as const }
    if (operator.status !== 'active') return { ok: false, reason: 'operator_suspended' as const }

    const sessionId = newId('internalSession')
    const expiresAt = new Date(now.getTime() + OPS_SESSION_TTL_SECONDS * 1000)
    await conn.insert(schema.internalSessions).values({
      id: sessionId,
      operatorId: input.operatorId,
      mfaMethod: input.mfaMethod,
      deviceFingerprint: input.deviceFingerprint.trim(),
      ip: input.ip,
      networkPolicy: input.policy.name,
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      establishedAt: now,
      expiresAt,
    })
    return { ok: true as const, sessionId, expiresAt }
  })
}

/* ── Resolving ──────────────────────────────────────────────────────────── */

/**
 * Who is acting, and what they may do.
 *
 * `principal` is `{ type: 'operator', id }` — its own principal type, so an
 * audit record answers "was this the customer or was this us" by its type
 * rather than by whoever reads it recognising the id.
 */
export interface ActiveOperator {
  readonly operatorId: string
  readonly sessionId: string
  readonly principal: PrincipalRef
  readonly roles: readonly InternalRole[]
  readonly capabilities: ReadonlySet<InternalCapability>
  readonly displayName: string
  readonly email: string
}

export type ResolveOperatorResult =
  | { ok: true; operator: ActiveOperator }
  | {
      ok: false
      reason: 'session_not_found' | 'session_expired' | 'session_revoked'
        | 'operator_suspended' | 'network_not_allowed'
        | 'request_address_missing' | 'session_device_mismatch'
    }

/**
 * What a request must present, every time.
 *
 * Required, not optional. An optional address is one that is sometimes absent,
 * and a network restriction skipped when the caller forgot to pass one is not a
 * restriction — it is a restriction with a hole shaped like a forgetful caller.
 * Making the context required moves the failure from a silently permissive
 * request to a compile error.
 */
export interface OperatorRequestContext {
  /**
   * The address this request arrived from. Checked on **every** request, not
   * only at establishment: a session established inside the office and then
   * used from a laptop on a train is exactly what the restriction is for, and
   * checking once at login would let it through for the next half hour.
   */
  readonly ip: string
  /** The device this request came from. Must match the one the session is bound to. */
  readonly deviceFingerprint: string
  readonly policy: NetworkPolicy
  readonly now?: Date
}

/**
 * The reason recorded when a session is revoked for a device mismatch.
 *
 * Its own constant so the revocation is greppable and so an operator asking
 * "why did my session end" gets an answer rather than a blank column.
 */
export const OPS_DEVICE_MISMATCH_REASON = 'ops_session_device_mismatch'

export async function resolveOperatorSession(
  db: Db, sessionId: string, request: OperatorRequestContext,
): Promise<ResolveOperatorResult> {
  const now = request.now ?? new Date()

  // Fail closed on a missing address. The type already requires the field, so
  // this catches the one shape it cannot — an empty string arriving from a
  // deployment whose proxy did not set the header. Treating that as "no
  // restriction applies" is exactly the failure this check exists to prevent.
  if (request.ip.trim().length === 0) {
    return { ok: false, reason: 'request_address_missing' }
  }
  if (request.deviceFingerprint.trim().length === 0) {
    // Same reasoning: an absent fingerprint cannot match a bound one, so it is
    // a mismatch rather than an exemption.
    return { ok: false, reason: 'session_device_mismatch' }
  }
  if (!(await addressIsAllowed(db, request.policy, request.ip))) {
    return { ok: false, reason: 'network_not_allowed' }
  }

  return withoutScope(db, async (conn) => {
    const [session] = await conn.select().from(schema.internalSessions)
      .where(eq(schema.internalSessions.id, sessionId)).limit(1)
    if (!session) return { ok: false, reason: 'session_not_found' as const }
    if (session.revokedAt !== null) return { ok: false, reason: 'session_revoked' as const }
    if (session.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: 'session_expired' as const }
    }

    /*
     * The device binding, with the same fail-closed semantics `resolveSession`
     * uses for a customer: on a mismatch the session is **revoked**, not merely
     * refused.
     *
     * A session id presented from a different device is the signature of a
     * stolen token rather than an ordinary error, so refusing this one request
     * and leaving the session alive would hand the thief another twenty-nine
     * minutes of attempts. Ending it costs the legitimate operator one login.
     */
    if (session.deviceFingerprint !== request.deviceFingerprint.trim()) {
      await conn.update(schema.internalSessions)
        .set({ revokedAt: now, revokedReason: OPS_DEVICE_MISMATCH_REASON })
        .where(eq(schema.internalSessions.id, sessionId))
      return { ok: false, reason: 'session_device_mismatch' as const }
    }

    const [operator] = await conn.select().from(schema.internalOperators)
      .where(eq(schema.internalOperators.id, session.operatorId)).limit(1)
    if (!operator) return { ok: false, reason: 'session_not_found' as const }
    // Suspension takes effect on the next request rather than at the next
    // login. A staff member whose access is withdrawn has it withdrawn now.
    if (operator.status !== 'active') return { ok: false, reason: 'operator_suspended' as const }

    const roleRows = await conn.select().from(schema.internalOperatorRoles)
      .where(eq(schema.internalOperatorRoles.operatorId, operator.id))
    const roles = roleRows.map((r) => r.role)

    return {
      ok: true as const,
      operator: {
        operatorId: operator.id,
        sessionId: session.id,
        principal: { type: 'operator', id: operator.id },
        roles,
        capabilities: internalCapabilitiesFor(roles),
        displayName: operator.displayName,
        email: operator.email,
      },
    }
  })
}

export async function revokeOperatorSession(
  db: Db, sessionId: string, now = new Date(),
): Promise<boolean> {
  return withoutScope(db, async (conn) => {
    const updated = await conn.update(schema.internalSessions)
      .set({ revokedAt: now })
      .where(and(
        eq(schema.internalSessions.id, sessionId),
        isNull(schema.internalSessions.revokedAt),
      ))
      .returning({ id: schema.internalSessions.id })
    return updated.length > 0
  })
}

/* ── Operator administration ────────────────────────────────────────────── */

export interface CreateOperatorInput {
  readonly email: string
  readonly displayName: string
  readonly roles: readonly InternalRole[]
  /** The `ops_admin` doing the granting. Every role grant is attributed. */
  readonly grantedBy: string
}

export async function createOperator(db: Db, input: CreateOperatorInput): Promise<string> {
  return withoutScope(db, async (conn) => {
    const id = newId('internalOperator')
    await conn.insert(schema.internalOperators).values({
      id, email: input.email, displayName: input.displayName,
      status: 'active', createdBy: input.grantedBy,
    })
    for (const role of input.roles) {
      await conn.insert(schema.internalOperatorRoles)
        .values({ operatorId: id, role, grantedBy: input.grantedBy })
    }
    return id
  })
}

/**
 * Withdraw an operator's access.
 *
 * Suspension and session revocation in one transaction, because doing only the
 * first would leave every open session working until it expired — up to half an
 * hour of full cross-tenant read access for someone whose access was just
 * withdrawn.
 */
export async function suspendOperator(
  db: Db, operatorId: string, now = new Date(),
): Promise<boolean> {
  return withoutScope(db, (conn) => conn.transaction(async (tx) => {
    const updated = await tx.update(schema.internalOperators)
      .set({ status: 'suspended', disabledAt: now })
      .where(and(
        eq(schema.internalOperators.id, operatorId),
        eq(schema.internalOperators.status, 'active'),
      ))
      .returning({ id: schema.internalOperators.id })
    if (updated.length === 0) return false

    await tx.update(schema.internalSessions)
      .set({ revokedAt: now })
      .where(and(
        eq(schema.internalSessions.operatorId, operatorId),
        isNull(schema.internalSessions.revokedAt),
      ))
    return true
  }))
}

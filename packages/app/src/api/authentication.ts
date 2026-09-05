/**
 * Authenticating a public-API request — `SECURITY.md § 3.3`, `§ 2`.
 *
 * The awkward shape of this file is the point. A bearer key's **workspace and
 * environment are properties of the key**, so they are not known until the key
 * is read; but `api_keys` is RLS-forced on the workspace, and the runtime role
 * has no `BYPASSRLS`. The scope cannot be set until the key is read, and the key
 * cannot be read until the scope is set.
 *
 * So authentication happens in two steps, and the second one is what makes the
 * first safe:
 *
 *  1. `resolveApiKey` calls the `resolve_api_key` definer function on a
 *     connection with **no scope set** (the function refuses to run in one), and
 *     learns which workspace the key claims to belong to. Advisory only.
 *
 *  2. `confirmKeyInScope` runs inside the now-scoped transaction and asks the
 *     ordinary, RLS-filtered table whether that key is there and still live.
 *     One statement, and it settles two things at once: revocation is immediate
 *     (the definer answer is never cached past this check), and the scope the
 *     API set really is the key's own — because under the tenant policy the row
 *     is visible only if `workspace_id` and `environment` match what was set.
 *
 * Without step 2 the whole design would rest on a claim that RLS never checks.
 */
import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db, Environment } from '@inrsettle/db'
import { schema, withoutScope } from '@inrsettle/db'
import {
  environmentForKey, insufficientScope, invalidApiKey,
  type ApiError, type Capability, type PrincipalRef, type TenantScope,
} from '@inrsettle/domain'
import { hashSecret } from '../api-key.service.js'

export interface AuthenticatedKey {
  readonly keyId: string
  readonly workspaceId: string
  readonly environment: Environment
  readonly scopes: readonly string[]
  /** How this principal is attributed in events and audit rows. */
  readonly principal: PrincipalRef
}

/**
 * Deliberately a discriminated union rather than a record with a `revoked` flag.
 *
 * A revoked key must not be able to hand a caller a workspace and an environment
 * that a `if (!revoked)` somebody forgot would turn into a live scope. Here there
 * is no scope to take unless the branch says `ok`. The revoked branch still
 * carries the workspace, because a revoked key being presented is a genuine
 * compromise signal and it has to be auditable *somewhere* — and the only place
 * an audit row can be written is that key's own workspace.
 */
export type KeyResolution =
  | { readonly ok: true; readonly key: AuthenticatedKey }
  | { readonly ok: false; readonly reason: 'malformed' | 'unknown' }
  | {
      readonly ok: false
      readonly reason: 'revoked'
      readonly keyId: string
      readonly workspaceId: string
      readonly environment: Environment
    }

/**
 * The base64url body a key generator produces: 24 random bytes.
 *
 * Checked before any database work, so a flood of garbage tokens costs a regex
 * rather than a connection from the pool. Rate limiting is published *per API
 * key* (`API_CONTRACT.md § 11`), which by definition cannot apply to a request
 * whose key does not resolve — so the cheap syntactic filter is the only thing
 * standing between an anonymous client and the resolve path. Limiting
 * unauthenticated traffic by source address belongs at the edge, in front of
 * this process, and is recorded as such in the stage notes.
 */
const KEY_BODY = /^[A-Za-z0-9_-]{32}$/

interface ResolveRow {
  key_id: string
  workspace_id: string
  environment: Environment
  scopes: string[]
  revoked: boolean
}

/**
 * Step 1. Learn the scope. No transaction — a single `STABLE` function call does
 * not need one, and an unauthenticated request should not cost a `BEGIN` and a
 * `COMMIT`.
 */
export async function resolveApiKey(db: Db, plaintext: string): Promise<KeyResolution> {
  const environment = environmentForKey(plaintext)
  if (environment === null) return { ok: false, reason: 'malformed' }
  if (!KEY_BODY.test(plaintext.slice(`sk_${environment === 'live' ? 'live' : 'test'}_`.length))) {
    return { ok: false, reason: 'malformed' }
  }

  const hash = hashSecret(plaintext)
  const rows = (await withoutScope(db, (conn) =>
    conn.execute(sql`SELECT * FROM resolve_api_key(${hash})`),
  )) as unknown as ResolveRow[]

  const row = rows[0]
  if (row === undefined) return { ok: false, reason: 'unknown' }

  // The presented prefix against the stored environment. This is defence in
  // depth rather than the primary binding — the prefix is inside the hashed
  // plaintext, so a mismatch cannot arise from a normal key — but the CHECK
  // constraint ties `environment` to the `prefix` *column*, not to the digest,
  // so a direct write to the table could otherwise flip a sandbox key to live.
  if (row.environment !== environment) return { ok: false, reason: 'unknown' }

  if (row.revoked) {
    return {
      ok: false, reason: 'revoked',
      keyId: row.key_id, workspaceId: row.workspace_id, environment: row.environment,
    }
  }
  return {
    ok: true,
    key: {
      keyId: row.key_id,
      workspaceId: row.workspace_id,
      environment: row.environment,
      scopes: row.scopes,
      principal: { type: 'api_key', id: row.key_id },
    },
  }
}

/**
 * Step 2. Inside the scoped transaction, confirm the key is really this
 * workspace's and really still live.
 *
 * A plain `SELECT`, never `FOR UPDATE`. Locking the key row would serialise
 * every concurrent request presenting it behind whichever one is slowest —
 * which for `POST /v1/settlements/{id}/authorize` means queueing behind the
 * settlement row lock too, and two lock objects taken in two orders is a
 * deadlock that aborts a financial transaction.
 */
export async function confirmKeyInScope(
  tx: Db, scope: TenantScope, keyId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(and(
      eq(schema.apiKeys.id, keyId),
      eq(schema.apiKeys.workspaceId, scope.workspaceId),
      eq(schema.apiKeys.environment, scope.environment),
      isNull(schema.apiKeys.revokedAt),
    ))
    .limit(1)
  return row !== undefined
}

/**
 * `last_used_at`, out of band.
 *
 * Never inside the request transaction. An `UPDATE` there takes a row lock held
 * to commit, so every concurrent request presenting one key would queue behind
 * the slowest of them for its whole duration — a diagnostic column becoming a
 * per-key throughput ceiling, and a second lock in the deadlock pair above.
 *
 * Coarsened to a minute for the same reason it is out of band: this column
 * answers "is this key still in use", and a value that is a minute stale answers
 * it exactly as well as one that is current.
 */
export const LAST_USED_RESOLUTION_SECONDS = 60

export async function touchKeyLastUsed(
  db: Db, scope: TenantScope, keyId: string,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_tenant_scope(${scope.workspaceId}, ${scope.environment})`)
      await tx.execute(sql`
        UPDATE api_keys SET last_used_at = now()
        WHERE id = ${keyId}
          AND (last_used_at IS NULL
               OR last_used_at < now() - make_interval(secs => ${LAST_USED_RESOLUTION_SECONDS}))`)
    })
  } catch {
    // Bookkeeping. A failure here must never affect a response the customer has
    // already been given.
  }
}

/** `settlement:authorize` and friends. The scope set comes from the key row. */
export function requireScope(
  key: AuthenticatedKey, capability: Capability,
): ApiError | null {
  return key.scopes.includes(capability) ? null : insufficientScope(capability)
}

export function keyRejection(): ApiError {
  return invalidApiKey()
}

/** Exposed for the tests that assert a key's digest covers its prefix. */
export function digestOf(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

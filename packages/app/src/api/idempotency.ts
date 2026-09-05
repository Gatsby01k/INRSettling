/**
 * Idempotency — `API_CONTRACT.md § 4`, `SECURITY.md § 5`.
 *
 * > A replay with the same key **and** the same body returns the original
 * > response with `Idempotency-Replayed: true`. A replay with the same key and a
 * > **different** body returns `409 idempotency_key_reuse`. […] A request that
 * > arrives while the first is still in flight returns `409
 * > idempotency_in_progress`.
 *
 * ## The one idea
 *
 * **The claim, the operation and the stored response commit in one
 * transaction.** Everything else follows from that sentence:
 *
 * - There is no lease and no reclaim path, so there is no way for a reclaim to
 *   run a payment a second time.
 * - A process that dies mid-operation rolls the claim back with the work, so
 *   there is never an "in progress" row describing something that never
 *   happened — and therefore nothing to sweep for correctness.
 * - A network failure *after* the commit but before the response reaches the
 *   client is the case this exists for, and it is exact: the retry finds the
 *   committed claim and replays the committed response.
 *
 * Mutual exclusion is the unique index, not a lock we take. A second request
 * holding the same key blocks on the index slot until the first transaction
 * ends, and then either sees its committed row (replay) or takes the slot
 * (proceeds) — verified behaviour, not an assumption.
 *
 * ## Three things that look like details and are not
 *
 * **The claim's `endpoint` is the concrete target.** `POST /…/authorize` is sent
 * with no body, so on that endpoint the fingerprint is a constant. Under a route
 * template, one key reused across two settlements would replay the first's
 * response and the second would silently never be authorized — a payment lost,
 * reported as a success. The `subject_id` assertion below is the second lock on
 * the same door.
 *
 * **The `lock_timeout` is scoped to the claim insert alone.** Left set for the
 * transaction it would also cover the settlement row lock that `INV-36` relies
 * on to order cancellation against dispatch — converting a deliberate wait into
 * a failure, and reporting it as an idempotency conflict.
 *
 * **The fallback lookup never filters on `expires_at`.** An expired row still
 * holds the index slot, so a liveness filter produces a state where the insert
 * says "already claimed" and the select says "no such claim".
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  ApiError, FINGERPRINT_VERSION, fingerprintPreimage,
  type CanonicalValue, type TenantScope,
} from '@inrsettle/domain'
import { createHash } from 'node:crypto'

/**
 * Short. The answer "somebody else is doing this right now" does not improve by
 * waiting for it, and every second spent waiting is a pooled connection held by
 * a request whose outcome is already decided.
 */
export const CLAIM_LOCK_TIMEOUT_MS = 750

export interface ClaimRequest {
  readonly method: string
  /** The concrete path, ids resolved. */
  readonly path: string
  readonly apiVersion: string
  readonly idempotencyKey: string
  readonly body: CanonicalValue | null
  readonly requestId: string
  /** The object the request names, when the path names one. */
  readonly subjectId?: string
}

export function requestFingerprint(req: ClaimRequest): string {
  return createHash('sha256')
    .update(fingerprintPreimage({
      method: req.method, path: req.path, apiVersion: req.apiVersion, body: req.body,
    }), 'utf8')
    .digest('hex')
}

export interface StoredResponse {
  readonly status: number
  readonly body: string
}

export type ClaimOutcome<T> =
  | { readonly kind: 'performed'; readonly value: T }
  | { readonly kind: 'replayed'; readonly response: StoredResponse }

export const idempotencyKeyReuse = (endpoint: string): ApiError =>
  new ApiError({
    type: 'conflict_error',
    code: 'idempotency_key_reuse',
    message: 'This Idempotency-Key was already used with a different request.',
    detail:
      `An earlier request to ${endpoint} used this key with a different body. ` +
      'Use a new key for a new request, or resend the original body to replay the original response.',
    param: 'Idempotency-Key',
  })

export const idempotencyInProgress = (detail?: string): ApiError =>
  new ApiError({
    type: 'conflict_error',
    code: 'idempotency_in_progress',
    message: 'An earlier request with this Idempotency-Key is still running.',
    detail: detail ?? 'Retry with the same key after a short backoff; the original response will be replayed.',
    param: 'Idempotency-Key',
  })

const claimInconsistent = (): ApiError =>
  new ApiError({
    type: 'api_error',
    code: 'internal_error',
    message: 'This request failed inside INRSettle. It is our fault, not yours.',
    detail:
      'An idempotency claim could neither be created nor found, which should not be ' +
      'possible. Nothing was executed, so nothing was charged and nothing moved. ' +
      'Send us the request_id on this response.',
  })

/** SQLSTATEs the claim insert can raise while waiting for another transaction. */
const CONTENTION_CODES = new Set([
  '55P03', // lock_timeout — another transaction holds the index slot
  '57014', // statement_timeout, if one is set below the lock timeout
  '40001', // serialization failure, were the transaction not READ COMMITTED
])

function sqlState(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined
}

/**
 * Run `operation` at most once for this key.
 *
 * `tx` must be the operation's own transaction: the whole guarantee is that the
 * claim and the work commit together. `operation` returns both its business
 * result and the response that should be replayed for it.
 *
 * A refusal is thrown as an `ApiError`, which aborts the transaction — correct,
 * because a refusal means nothing should have happened.
 */
export async function withIdempotencyClaim<T>(
  tx: Db,
  scope: TenantScope,
  req: ClaimRequest,
  operation: () => Promise<{ value: T; response: StoredResponse; subjectId?: string }>,
): Promise<ClaimOutcome<T>> {
  const endpoint = `${req.method.toUpperCase()} ${req.path}`
  const fingerprint = requestFingerprint(req)

  let inserted: { id: string }[]
  try {
    // Scoped to this statement only — see the header.
    await tx.execute(sql`select set_config('lock_timeout', ${`${CLAIM_LOCK_TIMEOUT_MS}ms`}, true)`)
    inserted = (await tx.execute(sql`
      INSERT INTO idempotency_claims
        (id, workspace_id, environment, endpoint, idempotency_key,
         request_fingerprint, fingerprint_version, request_id, subject_id)
      VALUES (${newId('idempotencyClaim')}, ${scope.workspaceId}, ${scope.environment}::environment,
              ${endpoint}, ${req.idempotencyKey}, ${fingerprint}, ${FINGERPRINT_VERSION},
              ${req.requestId}, ${req.subjectId ?? null})
      ON CONFLICT (workspace_id, environment, endpoint, idempotency_key) DO NOTHING
      RETURNING id`)) as unknown as { id: string }[]
  } catch (e) {
    // No cleanup here: the transaction is already aborted, so every further
    // statement on it raises 25P02 and the 409 cannot be enriched from it
    // either. Losing the timeout setting with the transaction is exactly right.
    if (CONTENTION_CODES.has(sqlState(e) ?? '')) throw idempotencyInProgress()
    throw e
  }

  // Back to the default (0 = wait) before any domain work, so the settlement
  // row lock behaves as INV-36 requires rather than inheriting a deadline.
  await tx.execute(sql`select set_config('lock_timeout', '0', true)`)

  if (inserted.length > 0) {
    const result = await operation()
    await tx.execute(sql`
      UPDATE idempotency_claims
         SET response_status = ${result.response.status},
             response_body   = ${result.response.body},
             subject_id      = COALESCE(subject_id, ${result.subjectId ?? null}),
             completed_at    = clock_timestamp()
       WHERE workspace_id = ${scope.workspaceId}
         AND environment  = ${scope.environment}::environment
         AND endpoint     = ${endpoint}
         AND idempotency_key = ${req.idempotencyKey}`)
    return { kind: 'performed', value: result.value }
  }

  const [existing] = await tx
    .select()
    .from(schema.idempotencyClaims)
    .where(and(
      eq(schema.idempotencyClaims.workspaceId, scope.workspaceId),
      eq(schema.idempotencyClaims.environment, scope.environment),
      eq(schema.idempotencyClaims.endpoint, endpoint),
      eq(schema.idempotencyClaims.idempotencyKey, req.idempotencyKey),
    ))
    .limit(1)

  // Neither inserted nor found. `ON CONFLICT DO NOTHING` names its arbiter, so
  // this is not a collision on some other constraint — it should be
  // unreachable. It is a 500 rather than a fall-through to the operation,
  // because the fall-through on a payments endpoint is a duplicate.
  if (existing === undefined) throw claimInconsistent()

  // A fingerprint computed under different rules is not comparable, so a
  // deploy that changed canonicalisation must not turn every live key into a
  // conflict. The key still matched, and the key is the client's promise.
  const comparable = existing.fingerprintVersion === FINGERPRINT_VERSION
  if (comparable && existing.requestFingerprint !== fingerprint) {
    throw idempotencyKeyReuse(endpoint)
  }

  // Belt and braces on the concrete-endpoint rule: even if `endpoint` were one
  // day built from a route template, a claim can never answer for a different
  // object than the one this request names.
  if (
    req.subjectId !== undefined &&
    existing.subjectId !== null &&
    existing.subjectId !== req.subjectId
  ) {
    throw idempotencyKeyReuse(endpoint)
  }

  if (existing.responseStatus === null || existing.responseBody === null) {
    throw idempotencyInProgress(
      existing.subjectId === null
        ? undefined
        : `The earlier request created ${existing.subjectId}; you can read it directly while this finishes.`,
    )
  }

  return {
    kind: 'replayed',
    response: { status: existing.responseStatus, body: existing.responseBody },
  }
}

/**
 * Retention — `§ 4`: *"Keys are retained 24 hours."*
 *
 * Not needed for correctness (nothing above consults `expires_at`), which is
 * why it is a plain maintenance function the worker calls on a timer rather than
 * a registered job class: `ARCHITECTURE.md § 7`'s list is frozen, and adding to
 * it to describe a `DELETE` would be extending a frozen list to say something it
 * already covers.
 *
 * It is needed for two other reasons: the table grows without it, and a stored
 * response body is customer data that was promised a 24-hour life.
 *
 * **Only `expires_at` decides.** A "clean up stuck rows" variant keyed on
 * `completed_at IS NULL` would delete an in-flight batch claim and permit a
 * duplicate import.
 */
export async function sweepExpiredIdempotencyClaims(
  tx: Db, scope: TenantScope,
): Promise<number> {
  const deleted = (await tx.execute(sql`
    DELETE FROM idempotency_claims
     WHERE workspace_id = ${scope.workspaceId}
       AND environment  = ${scope.environment}::environment
       AND expires_at < now()
    RETURNING id`)) as unknown as { id: string }[]
  return deleted.length
}

/**
 * The `preflight.run` job — `ARCHITECTURE.md § 7`, `§ 3`.
 *
 * > All state progression is asynchronous and lives in `worker`. **A request
 * > never drives a settlement through more than one transition**; it records
 * > intent and enqueues.
 *
 * This is the job that sentence implies for `POST /v1/settlements`. The request
 * commits `T01` and stops; this runs `T02`, then `T03` or `T04`, and attaches
 * the quote the client named at creation if there was one — each in its own
 * transaction, because the `INV-32` pairing trigger counts status events at
 * commit and refuses a transaction that wrote more than one.
 *
 * So the architectural rule and the database constraint say the same thing, and
 * the constraint is the one that would have found out first.
 *
 * Idempotent, like every job (`§ 7`): a settlement already past preflight is
 * left exactly as it is, so a redelivered job is a read and nothing else.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import { enqueue } from '@inrsettle/jobs'
import type { PreflightRuleSet, PrincipalRef, TenantScope } from '@inrsettle/domain'
import { attachQuote, runSettlementPreflight } from './settlement.service.js'

export const PREFLIGHT_RUN_JOB = 'preflight.run'

export interface PreflightJobPayload {
  readonly settlementId: string
  /** Attached after preflight, if preflight left the settlement `READY`. */
  readonly quoteId?: string | undefined
}

export const preflightJobKey = (settlementId: string): string =>
  `${PREFLIGHT_RUN_JOB}:${settlementId}`

/**
 * Enqueue inside the transaction that created the settlement.
 *
 * `enqueue` takes the transaction, never a pool, so a settlement cannot exist
 * without its preflight job and a rolled-back creation leaves no job behind.
 */
export async function enqueuePreflight(
  tx: Db, scope: TenantScope, input: PreflightJobPayload,
): Promise<void> {
  await enqueue(
    tx, PREFLIGHT_RUN_JOB,
    {
      settlementId: input.settlementId,
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      ...(input.quoteId === undefined ? {} : { quoteId: input.quoteId }),
    },
    { jobKey: preflightJobKey(input.settlementId) },
  )
}

export type PreflightJobResult =
  | { readonly ok: true; readonly status: 'READY' | 'ACTION_REQUIRED'; readonly quoteAttached: boolean }
  | { readonly ok: false; readonly reason: string }

export async function runPreflightJob(
  db: Db,
  scope: TenantScope,
  deps: { ruleSet: PreflightRuleSet; hasActiveLiquidityFacility: boolean; actor: PrincipalRef },
  input: PreflightJobPayload,
): Promise<PreflightJobResult> {
  const [settlement] = await withTenant(db, scope, (tx) =>
    tx.select({ status: schema.settlements.status })
      .from(schema.settlements)
      .where(eq(schema.settlements.id, input.settlementId))
      .limit(1),
  )
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }

  // Already past preflight. A redelivered job must not re-run a machine that
  // has moved on — it asserts its expected pre-state and abandons (`§ 7`).
  if (settlement.status !== 'DRAFT' && settlement.status !== 'PREFLIGHTING') {
    return {
      ok: true,
      status: settlement.status === 'ACTION_REQUIRED' ? 'ACTION_REQUIRED' : 'READY',
      quoteAttached: false,
    }
  }

  const preflight = await runSettlementPreflight(db, scope, {
    settlementId: input.settlementId,
    ruleSet: deps.ruleSet,
    hasActiveLiquidityFacility: deps.hasActiveLiquidityFacility,
    actor: deps.actor,
  })
  if (!preflight.ok) {
    return { ok: false, reason: preflight.outcome.ok ? 'unknown' : preflight.outcome.reason }
  }

  // A quote is attachable only to a settlement nobody is waiting on. Attaching
  // one to an ACTION_REQUIRED settlement would lock economics against an
  // instruction the customer still has to change.
  if (input.quoteId === undefined || preflight.status !== 'READY') {
    return { ok: true, status: preflight.status, quoteAttached: false }
  }

  const attached = await withTenant(db, scope, (tx) =>
    attachQuote(tx, scope, {
      settlementId: input.settlementId, quoteId: input.quoteId!, actor: deps.actor,
    }),
  )
  return { ok: true, status: preflight.status, quoteAttached: attached.ok }
}

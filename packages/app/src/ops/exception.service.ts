/**
 * Resolving an exception — `STATE_MACHINES.md` T22, T23, T24; `PRODUCT.md § 14`.
 *
 * > | T22 | `EXCEPTION` | `resolve_resume` | `exception_entered_from` | attributed resolution recorded |
 * > | T23 | `EXCEPTION` | `resolve_fail`   | `FAILED`    | attributed decision; no value delivered |
 * > | T24 | `EXCEPTION` | `resolve_cancel` | `CANCELLED` | attributed decision; **pre-PONR only** |
 *
 * This is the one thing Internal Operations can *do* to a settlement, and the
 * shape of it is the whole answer to "how does ops fix a stuck payment".
 *
 * ## Why there is no fourth option
 *
 * The obvious missing action is "mark this one settled, I have confirmed the
 * credit by phone". `SECURITY.md § 6` forbids it for every principal, and the
 * reason is not squeamishness: a settlement is `SETTLED` when six finality
 * conditions hold, and a human who has confirmed one of them has not confirmed
 * the other five. So the ops action is `resolve_resume` — it puts the machine
 * back where it stalled and lets the evaluator decide, with whatever evidence
 * has since arrived. If the evidence is not there, the settlement stalls again,
 * which is the correct outcome and a visible one.
 *
 * This is not enforced here by omission alone. `applyTransition` will not accept
 * a trigger that is not in the frozen table, `SETTLED` is reachable only through
 * `reconciled_matched` from `RECONCILING`, and `inrsettle_ops` holds no write
 * privilege on any table — so an operator resolving an exception is doing it
 * through the ordinary application role, under every trigger and constraint a
 * customer action passes through.
 *
 * ## The resume is the interesting one
 *
 * T22's destination is **data**: `exception_entered_from`, recorded when the
 * exception opened and frozen by a database trigger while it is open. Nobody —
 * not this service, not the operator — chooses where a resume goes. Migration
 * `0005` refuses a resume to anywhere else, and refuses a post-point-of-no-return
 * exception resuming to a pre-dispatch state (`INV-36`). The operator decides
 * *whether* to resume; the machine decides *to where*.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db, TenantScope } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import type { ExceptionCode, SettlementStatus } from '@inrsettle/domain'
import { applyTransition, type TransitionOutcome } from '../settlement-transition.service.js'
import { compensateCancellation } from '../settlement-liquidity.service.js'
import { eventSink } from '../events.js'
import {
  requireCapability, writeOperatorRecord, type OperatorContext,
} from './access.service.js'

/* ── What is open ───────────────────────────────────────────────────────── */

export interface OpenException {
  readonly id: string
  readonly settlementId: string
  readonly code: ExceptionCode
  readonly enteredFrom: SettlementStatus
  readonly openedAt: Date
  /** Present only when the provider input that raised it was unmapped. */
  readonly providerRawCode: string | null
  readonly providerRawMessage: string | null
  readonly providerEventId: string | null
  readonly classification: string | null
}

export async function openExceptionFor(
  tx: Db, settlementId: string,
): Promise<OpenException | null> {
  const [row] = await tx.select().from(schema.settlementExceptions)
    .where(and(
      eq(schema.settlementExceptions.settlementId, settlementId),
      isNull(schema.settlementExceptions.resolvedAt),
    ))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    settlementId: row.settlementId,
    code: row.code as ExceptionCode,
    enteredFrom: row.enteredFrom as SettlementStatus,
    openedAt: row.openedAt,
    providerRawCode: row.providerRawCode,
    providerRawMessage: row.providerRawMessage,
    providerEventId: row.providerEventId,
    classification: row.classification,
  }
}

/* ── Resolving ──────────────────────────────────────────────────────────── */

export type Resolution = 'resume' | 'fail' | 'cancel'

const TRIGGER = {
  resume: 'resolve_resume',
  fail: 'resolve_fail',
  cancel: 'resolve_cancel',
} as const

export interface ResolveExceptionInput {
  readonly settlementId: string
  readonly resolution: Resolution
}

export type ResolveExceptionResult =
  | {
      ok: true
      resolution: Resolution
      exceptionId: string
      from: SettlementStatus
      to: SettlementStatus | null
      compensation: 'reservation_released' | 'repayment_requested' | 'none'
    }
  | {
      ok: false
      reason:
        | 'settlement_not_found' | 'no_open_exception' | 'past_point_of_no_return'
        | 'value_may_have_been_delivered' | 'compensation_failed'
      detail?: unknown
    }
  | { ok: false; reason: 'transition_refused'; outcome: TransitionOutcome }

/**
 * Resolve the open exception on a settlement, as an operator.
 *
 * Named for who is acting. `settlement.service.ts` has a lower-level
 * `resolveException` that applies the transition and nothing else; this is the
 * Internal Operations entry point, and it adds the three things an operator
 * action needs and a machine-driven one does not: the capability check, the
 * mandatory reason, and the attribution record.
 *
 * One transaction, on the **application** pool, inside `withTenant` — so
 * `INV-32`'s pairing trigger, the settled-row immutability guard and the resume
 * integrity trigger all apply exactly as they do to a customer action. There is
 * no ops write path; there is only this, using the same door.
 *
 * The operator record is written in the same transaction as the transition, so
 * a resolution and its attribution cannot come apart. That is stricter than the
 * read path — where the audit is committed first and separately, because a read
 * cannot be rolled back — and the asymmetry is deliberate: a write that rolls
 * back did not happen, so its record should roll back too.
 */
export async function resolveExceptionAsOperator(
  appDb: Db,
  scope: TenantScope,
  ctx: OperatorContext,
  input: ResolveExceptionInput,
): Promise<ResolveExceptionResult> {
  requireCapability(ctx, 'ops:exception_resolve')

  return withTenant(appDb, scope, async (tx) => {
    // Locked first. Everything below reads state that a concurrent job — a
    // provider callback, the reconciliation poller — could be changing.
    const locked = (await tx.execute(sql`
      SELECT id, status, point_of_no_return_at, exception_entered_from,
             payout_attempt_id, version
        FROM settlements WHERE id = ${input.settlementId} FOR UPDATE`)) as unknown as {
      id: string
      status: SettlementStatus
      point_of_no_return_at: Date | null
      exception_entered_from: SettlementStatus | null
      payout_attempt_id: string | null
      version: number
    }[]
    const settlement = locked[0]
    if (!settlement) return { ok: false as const, reason: 'settlement_not_found' as const }

    const open = await openExceptionFor(tx, input.settlementId)
    if (!open) return { ok: false as const, reason: 'no_open_exception' as const }

    /*
     * The guards, answered here under the lock rather than asserted.
     *
     * `no_value_delivered` (T23) is the one that deserves care. A settlement
     * whose payout attempt reached a provider may have delivered value even if
     * we never saw the confirmation — `PAYOUT_STATUS_UNKNOWN` is exactly that
     * situation — and calling it `FAILED` would tell the customer no money
     * moved when it might have. So the answer is no if the attempt crossed the
     * point of no return, and ops is left with `resume`, which is the honest
     * action: go and find out.
     */
    const pastPonr = settlement.point_of_no_return_at !== null
    const noValueDelivered = !pastPonr

    if (input.resolution === 'fail' && !noValueDelivered) {
      return { ok: false as const, reason: 'value_may_have_been_delivered' as const }
    }
    if (input.resolution === 'cancel' && pastPonr) {
      return { ok: false as const, reason: 'past_point_of_no_return' as const }
    }

    // The compensation the frozen table calls a `companionChoice`, decided by
    // where the reservation actually is rather than by what the operator picked.
    // `INV-22`: a consumed reservation has nothing to give back, so capacity
    // returns through a repayment, and doing both credits the facility twice.
    let compensation: 'reservation_released' | 'repayment_requested' | 'none' = 'none'
    if (input.resolution !== 'resume') {
      const compensated = await compensateCancellation(tx, scope, {
        settlementId: input.settlementId, actor: ctx.operator.principal,
      })
      if (!compensated.ok) {
        return {
          ok: false as const, reason: 'compensation_failed' as const, detail: compensated.reason,
        }
      }
      compensation = compensated.compensation
    }

    const outcome = await applyTransition(tx, scope, {
      settlementId: input.settlementId,
      trigger: TRIGGER[input.resolution],
      actor: ctx.operator.principal,
      guards: {
        // Attributed *and* reasoned. `requireCapability` has already refused an
        // empty or too-short reason, so this is true by construction — and it
        // is written as a computed answer rather than a literal so that a future
        // caller that skipped the check answers `false` rather than `true`.
        resolution_attributed:
          ctx.operator.principal.id.length > 0 && ctx.reason.trim().length > 0,
        ...(input.resolution === 'fail' ? { no_value_delivered: noValueDelivered } : {}),
        ...(input.resolution === 'cancel' ? { before_point_of_no_return: !pastPonr } : {}),
      },
      expectedVersion: settlement.version,
      companions: input.resolution === 'resume' || compensation === 'none'
        ? []
        : [{
            type: compensation === 'repayment_requested'
              ? 'facility.repayment_requested'
              : 'facility.reservation_released',
            subjectType: 'settlement',
            subjectId: input.settlementId,
          }],
      statusEventPayload: {
        exception_code: open.code,
        resolution: input.resolution,
        resolved_by: ctx.operator.principal.id,
      },
      reason: ctx.reason,
    })

    if (!outcome.ok) return { ok: false as const, reason: 'transition_refused' as const, outcome }

    // Close the exception row itself. `resolved_by` and `resolution_reason` are
    // both NOT NULL under the `resolution_is_attributed` CHECK in migration
    // 0005, so an unattributed resolution is refused by the database and not
    // only by this function.
    await tx.update(schema.settlementExceptions)
      .set({
        resolvedAt: new Date(),
        resolvedBy: ctx.operator.principal.id,
        resolutionReason: ctx.reason,
      })
      .where(eq(schema.settlementExceptions.id, open.id))

    await eventSink(tx).audit(scope, {
      actor: ctx.operator.principal,
      action: `ops.exception_${input.resolution}`,
      subjectType: 'settlement',
      subjectId: input.settlementId,
      before: { status: settlement.status, exceptionCode: open.code },
      after: { status: outcome.to, compensation },
      reason: ctx.reason,
    })

    // In the same transaction as the transition, unlike a read: a write that
    // rolls back did not happen, so its record should roll back with it.
    await writeOperatorRecord(tx, scope, ctx, 'write', {
      subjectType: 'settlement', subjectId: input.settlementId,
    })

    return {
      ok: true as const,
      resolution: input.resolution,
      exceptionId: open.id,
      from: outcome.from,
      to: outcome.to,
      compensation,
    }
  })
}

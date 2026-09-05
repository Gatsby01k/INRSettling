/**
 * The `SettlementReturn` aggregate — Stage 6. `N01`–`N07`, `INV-39`–`INV-42`,
 * `INV-48`–`INV-50`, `STATE_MACHINES.md § 8.4`–`§ 8.6`.
 *
 * A credit came back. `§ 8.5` states the consequence plainly, and it is the
 * thing this whole file is arranged around:
 *
 * > *"The settlement stays `SETTLED`, because it was."*
 *
 * So nothing here calls `applyTransition`. There is no code path from a return
 * to the settlement machine, and that absence is the design: `INV-38` makes
 * `SETTLED` terminal, `INV-42` requires the settlement row and its receipt hash
 * to be byte-identical before and after, and the way to guarantee both is to
 * have no function that could write to either.
 *
 * The known tension is accepted deliberately, and `§ 8.5` says why: projecting a
 * return onto `CANCELLED` *"destroys the distinction between never delivered and
 * delivered then returned, and those have different consequences for the
 * customer's own books."*
 *
 * ## The three hard parts
 *
 * **`INV-40` — an authoritative check, not the inbound event alone.** A webhook
 * saying "returned" opens the return; it does not confirm it. Confirmation
 * requires asking the provider ourselves. `checkReturnWithProvider` makes the
 * call *outside* any transaction, for the same reason `submitDispatchedPayout`
 * does: a network call inside a row lock is the mistake `INV-36(b)` names.
 *
 * **`INV-49` — the cap, under the payout attempt's row lock.** The total is
 * recomputed inside the transaction that increments it, and a breach routes to
 * `MANUAL_REVIEW` rather than being refused into silence. The database `CHECK`
 * holds anyway; it is the layer that catches a code path that forgets the lock.
 *
 * **`INV-50` — the second dedupe key.** One real-world return is one row,
 * however many channels report it. A second sighting *"updates nothing and
 * creates nothing; it is recorded against the existing return as an additional
 * observation."*
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import { money } from '@inrsettle/money'
import {
  RETURN_TRANSITIONS,
  UNMAPPED_RETURN_REASON,
  checkReturnCap,
  evaluateReturnTransition,
  payoutIdempotencyKey,
  triageReturnArrival,
  verdictOnOpening,
  type ObservationSource,
  type PayoutProvider,
  type PrincipalRef,
  type ReturnReasonCode,
  type ReturnStatus,
  type TenantScope,
} from '@inrsettle/domain'
import { requestRepayment } from './liquidity.service.js'
import { eventSink } from './events.js'
import { databaseNow } from './quote.service.js'
import { issueReturnNotice } from './receipt.service.js'

export type ReturnResult =
  | {
      ok: true
      returnId: string
      status: ReturnStatus
      transition: ReturnTransitionName
      /** A second sighting of a return we already hold — `INV-50`. */
      duplicate?: boolean
      repaymentId?: string
      noticeId?: string
      noticeContentHash?: string
      /** Set where the return was routed to `MANUAL_REVIEW` and why. */
      escalation?: readonly string[]
      alarm?: 'return_not_upheld' | 'return_cap_breach' | 'unmapped_return_reason'
    }
  | { ok: false; reason: string; detail?: unknown }

type ReturnTransitionName = (typeof RETURN_TRANSITIONS)[number]['id']

interface ReturnRow {
  id: string
  settlement_id: string
  payout_attempt_id: string
  status: ReturnStatus
  amount_minor: string | number | bigint
  amount_currency: string
  reason_code: ReturnReasonCode
  reason_message: string
  provider_return_reference: string
  observed_at: Date
  repayment_id: string | null
}

const RETURN_COLUMNS = sql`
  id, settlement_id, payout_attempt_id, status, amount_minor, amount_currency,
  reason_code, reason_message, provider_return_reference, observed_at, repayment_id`

/**
 * Render a detail object for an audit reason, bigints included.
 *
 * `JSON.stringify` throws on a `bigint`, and every amount in this file is one.
 * A cap breach is exactly the path where the throw would land — and it is the
 * path that must not throw, because it is the one carrying the alarm.
 */
function describe(detail: Record<string, unknown>): string {
  return JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}

async function lockReturn(tx: Db, returnId: string): Promise<ReturnRow | null> {
  const rows = (await tx.execute(sql`
    SELECT ${RETURN_COLUMNS} FROM settlement_returns WHERE id = ${returnId} FOR UPDATE`)) as
    unknown as ReturnRow[]
  return rows[0] ?? null
}

export async function readReturn(tx: Db, returnId: string): Promise<ReturnRow | null> {
  const rows = (await tx.execute(sql`
    SELECT ${RETURN_COLUMNS} FROM settlement_returns WHERE id = ${returnId}`)) as unknown as ReturnRow[]
  return rows[0] ?? null
}

export async function listReturns(tx: Db, settlementId: string): Promise<ReturnRow[]> {
  return (await tx.execute(sql`
    SELECT ${RETURN_COLUMNS} FROM settlement_returns
    WHERE settlement_id = ${settlementId} ORDER BY observed_at, id`)) as unknown as ReturnRow[]
}

async function recordObservation(
  tx: Db,
  scope: TenantScope,
  input: {
    returnId: string
    source: ObservationSource
    providerEventId?: string | undefined
    observedAmountMinor?: bigint | undefined
    observedAmountCurrency?: string | undefined
    openedTheReturn: boolean
    payload?: Record<string, unknown> | undefined
  },
): Promise<void> {
  await tx.insert(schema.returnObservations).values({
    id: newId('returnObservation'),
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    returnId: input.returnId,
    source: input.source,
    providerEventId: input.providerEventId ?? null,
    observedAmountMinor: input.observedAmountMinor ?? null,
    observedAmountCurrency: input.observedAmountCurrency ?? null,
    openedTheReturn: input.openedTheReturn,
    payload: (input.payload ?? null) as never,
  })
}

/* ── N01 — open ─────────────────────────────────────────────────────────── */

export interface OpenReturnInput {
  readonly settlementId: string
  readonly actor: PrincipalRef
  /** `INV-39`. Two values, and neither of them is a person's assertion. */
  readonly source: ObservationSource
  readonly amountMinor: bigint
  readonly currency: string
  readonly reasonCode: ReturnReasonCode
  readonly reasonMessage: string
  readonly providerRawReason?: string | undefined
  /** `INV-50`'s key, with the attempt. Required; see the migration's comment. */
  readonly providerReturnReference: string
  readonly providerEventId?: string | undefined
  /** When the rail says the return happened, not when we heard about it. */
  readonly occurredAt?: Date | undefined
  /**
   * The rail's `return_observation_window`. `D-04` is open on the duration, so
   * this is supplied from configuration and `null` — no partner number yet — is
   * a legitimate value that makes every arrival ordinary. Inventing a threshold
   * here would send real returns to `MANUAL_REVIEW` on a number nobody agreed.
   */
  readonly windowSeconds?: number | null | undefined
  readonly payload?: Record<string, unknown> | undefined
}

/**
 * Open a return, or record a second sighting of one we already hold.
 *
 * The settlement must be `SETTLED`: `§ 8.4` is about *"a real, later,
 * independent fact"*, and a "return" of a payout that never reached finality is
 * not that — it is a payout that failed, which is `T17` and the exception
 * taxonomy's job. Refusing here keeps the two apart.
 */
export async function openReturn(
  tx: Db,
  scope: TenantScope,
  input: OpenReturnInput,
): Promise<ReturnResult> {
  const settlements = (await tx.execute(sql`
    SELECT s.status, s.payout_attempt_id, pa.credited_minor, pa.amount_currency, pa.credited_at
    FROM settlements s
    LEFT JOIN payout_attempts pa ON pa.id = s.payout_attempt_id
    WHERE s.id = ${input.settlementId}`)) as unknown as {
    status: string
    payout_attempt_id: string | null
    credited_minor: string | number | bigint | null
    amount_currency: string | null
    credited_at: Date | null
  }[]
  const settlement = settlements[0]
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }
  if (settlement.status !== 'SETTLED') {
    return { ok: false, reason: 'settlement_not_settled', detail: { status: settlement.status } }
  }
  if (settlement.payout_attempt_id === null) return { ok: false, reason: 'no_payout_attempt' }
  if (input.amountMinor <= 0n) return { ok: false, reason: 'amount_must_be_positive' }
  if (input.providerReturnReference.trim().length === 0) {
    return {
      ok: false,
      reason: 'provider_return_reference_required',
      detail: {
        why:
          'INV-50 deduplicates on (payout_attempt_id, provider_return_reference); ' +
          'a return the provider will not identify cannot be deduplicated at all',
      },
    }
  }

  // INV-50, the second key. Checked before inserting so a second channel is
  // answered rather than refused by a constraint violation the caller has to
  // interpret. The unique index is still the guarantee under concurrency.
  const existing = (await tx.execute(sql`
    SELECT ${RETURN_COLUMNS} FROM settlement_returns
    WHERE payout_attempt_id = ${settlement.payout_attempt_id}
      AND provider_return_reference = ${input.providerReturnReference}`)) as unknown as ReturnRow[]
  if (existing[0]) {
    // "A second sighting updates nothing and creates nothing; it is recorded
    // against the existing return as an additional observation."
    await recordObservation(tx, scope, {
      returnId: existing[0].id,
      source: input.source,
      providerEventId: input.providerEventId,
      observedAmountMinor: input.amountMinor,
      observedAmountCurrency: input.currency,
      openedTheReturn: false,
      payload: input.payload,
    })
    return {
      ok: true,
      returnId: existing[0].id,
      status: existing[0].status,
      transition: 'N01',
      duplicate: true,
    }
  }

  const evaluated = evaluateReturnTransition(null, 'open')
  if (!evaluated.ok) return { ok: false, reason: 'invalid_transition', detail: evaluated }

  // § 8.6 triage. Recorded as evidence rather than recomputed later: D-04 is
  // open, and a return judged under today's window should not be silently
  // re-read under tomorrow's.
  const observedAt = input.occurredAt ?? (await databaseNow(tx))
  const triage = triageReturnArrival({
    creditedAt: settlement.credited_at ? new Date(settlement.credited_at) : observedAt,
    returnObservedAt: observedAt,
    windowSeconds: input.windowSeconds ?? null,
  })
  const opening = verdictOnOpening({ reasonCode: input.reasonCode, triage })

  const returnId = newId('settlementReturn')
  await tx.insert(schema.settlementReturns).values({
    id: returnId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    settlementId: input.settlementId,
    payoutAttemptId: settlement.payout_attempt_id,
    // N01 always produces OBSERVED; N04 escalates it in the same commit where
    // the opening verdict says so, so the machine's own table stays the only
    // description of how a return may move.
    status: 'OBSERVED',
    amountMinor: input.amountMinor,
    amountCurrency: input.currency,
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
    providerRawReason: input.providerRawReason ?? null,
    openedBySource: input.source,
    providerEventId: input.providerEventId ?? null,
    providerReturnReference: input.providerReturnReference,
    observedAt,
    windowSecondsAtOpen: input.windowSeconds ?? null,
    arrivalElapsedSeconds: triage.elapsedSeconds,
    arrivedWithinWindow: triage.within,
  })

  await recordObservation(tx, scope, {
    returnId,
    source: input.source,
    providerEventId: input.providerEventId,
    observedAmountMinor: input.amountMinor,
    observedAmountCurrency: input.currency,
    openedTheReturn: true,
    payload: input.payload,
  })

  const events = eventSink(tx)
  await events.event(scope, {
    type: 'settlement.return_observed',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    actor: input.actor,
    payload: {
      return_id: returnId,
      amount_minor: String(input.amountMinor),
      currency: input.currency,
      reason_code: input.reasonCode,
    },
    deliver: true,
  })
  await events.audit(scope, {
    actor: input.actor,
    action: 'settlement.return_observed',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    after: {
      return_id: returnId,
      transition: 'N01',
      source: input.source,
      provider_return_reference: input.providerReturnReference,
      arrived_within_window: triage.within,
      arrival_elapsed_seconds: triage.elapsedSeconds,
    },
  })

  if (opening.escalateImmediately) {
    const escalated = await escalateReturn(tx, scope, {
      returnId,
      actor: input.actor,
      reasons: opening.reasons,
    })
    if (!escalated.ok) return escalated
    return {
      ok: true,
      returnId,
      status: 'MANUAL_REVIEW',
      transition: 'N04',
      escalation: opening.reasons,
      ...(input.reasonCode === UNMAPPED_RETURN_REASON
        ? { alarm: 'unmapped_return_reason' as const }
        : {}),
    }
  }

  return { ok: true, returnId, status: 'OBSERVED', transition: 'N01' }
}

/* ── N04 — escalate ─────────────────────────────────────────────────────── */

export async function escalateReturn(
  tx: Db,
  scope: TenantScope,
  input: { returnId: string; actor: PrincipalRef; reasons: readonly string[] },
): Promise<ReturnResult> {
  const current = await lockReturn(tx, input.returnId)
  if (!current) return { ok: false, reason: 'return_not_found' }

  const evaluated = evaluateReturnTransition(current.status, 'escalate')
  if (!evaluated.ok) {
    return { ok: false, reason: 'invalid_transition', detail: { from: current.status } }
  }

  await tx
    .update(schema.settlementReturns)
    .set({ status: 'MANUAL_REVIEW' })
    .where(eq(schema.settlementReturns.id, input.returnId))

  await eventSink(tx).audit(scope, {
    actor: input.actor,
    action: 'settlement.return_escalated',
    subjectType: 'settlement',
    subjectId: current.settlement_id,
    before: { status: current.status },
    after: { return_id: input.returnId, transition: 'N04', status: 'MANUAL_REVIEW' },
    reason: input.reasons.join('; '),
  })

  return { ok: true, returnId: input.returnId, status: 'MANUAL_REVIEW', transition: 'N04', escalation: input.reasons }
}

/* ── INV-40 — the authoritative check ───────────────────────────────────── */

export type ReturnCheck =
  | { readonly upheld: true; readonly reportedMinor: bigint | null; readonly source: ObservationSource }
  | { readonly upheld: false; readonly why: string }

/**
 * Ask the provider whether the return it told us about is real.
 *
 * > `INV-40` — *"`OBSERVED → CONFIRMED` requires an authoritative check against
 * > the provider, not the inbound event alone. A return that does not survive
 * > that check is `REJECTED` and raises an alarm: a false return report is a
 * > serious provider signal."*
 *
 * Takes the connection **pool**, not a transaction, so the network call cannot
 * be made while holding the payout attempt's row lock — the same type-level
 * refusal `submitDispatchedPayout` uses, and for the same reason.
 */
export async function checkReturnWithProvider(
  db: Db,
  scope: TenantScope,
  provider: PayoutProvider,
  input: { returnId: string },
): Promise<ReturnCheck | { upheld: false; why: string }> {
  const rows = await withTenant(db, scope, (tx) =>
    tx.execute(sql`
      SELECT r.amount_minor, pa.settlement_id, pa.attempt_number
      FROM settlement_returns r
      JOIN payout_attempts pa ON pa.id = r.payout_attempt_id
      WHERE r.id = ${input.returnId}`),
  )
  const row = (rows as unknown as {
    amount_minor: string | number | bigint
    settlement_id: string
    attempt_number: number
  }[])[0]
  if (!row) return { upheld: false, why: 'the return no longer exists' }

  const answer = await provider.getPayout(payoutIdempotencyKey(row.settlement_id, row.attempt_number))
  if (!answer.ok) return { upheld: false, why: `the status pull failed: ${answer.error}` }
  if (answer.status !== 'RETURNED') {
    // The provider told us about a return and now does not report one. That is
    // the case INV-40 calls a serious provider signal, and it is the reason the
    // check exists at all.
    return {
      upheld: false,
      why: `the provider now reports ${answer.status}, not RETURNED`,
    }
  }

  const reported = answer.returnedMinor ?? null
  if (reported !== null && reported < BigInt(row.amount_minor)) {
    return {
      upheld: false,
      why: `the provider reports ${reported} returned in total, less than this return's ${row.amount_minor}`,
    }
  }
  return { upheld: true, reportedMinor: reported, source: 'authoritative_status_pull' }
}

/* ── N02 / N06 — confirm, under the cap ─────────────────────────────────── */

/**
 * How much of the drawdown a return sends back — the technical half of `D-17`.
 *
 * The facility lent funding currency; the return came back in INR. Something
 * has to bridge the two, and the honest bridge is the one that invents nothing:
 * **the fraction of the delivery that came back is the fraction of the drawdown
 * that is repaid.** No FX rate is applied — not the original one, not today's —
 * because choosing between them *is* `D-17`, and `D-17` is open.
 *
 * Floor rather than round, so cumulative repayments can never exceed the
 * drawdown. A full return is exact by construction: `drawn × delivered /
 * delivered` is `drawn`, with no residue. A partial return can leave sub-unit
 * dust in the facility, which is the safe direction — the alternative rounds
 * *up* and repays value that was never drawn.
 */
export function proRataRepayment(input: {
  drawnMinor: bigint
  deliveredMinor: bigint
  returnedMinor: bigint
}): bigint {
  if (input.deliveredMinor <= 0n) return 0n
  return (input.drawnMinor * input.returnedMinor) / input.deliveredMinor
}

/**
 * Confirm a return — `N02`, or `N06` from `MANUAL_REVIEW`.
 *
 * The ordering inside this transaction is the invariant:
 *
 * 1. lock the **payout attempt**, not the return, because the cap is per
 *    attempt and two returns against one attempt must serialize against each
 *    other rather than against themselves;
 * 2. recompute the confirmed total inside that lock;
 * 3. refuse — into `MANUAL_REVIEW`, with an alarm — if it would breach;
 * 4. increment `returned_total_minor`, which the database `CHECK` re-verifies;
 * 5. request the repayment (`Y01`), which posts **no** ledger entry and moves
 *    **no** availability (`INV-41`);
 * 6. issue the return notice, a separate artifact that leaves the receipt alone.
 */
export async function confirmReturn(
  tx: Db,
  scope: TenantScope,
  input: {
    returnId: string
    actor: PrincipalRef
    check: ReturnCheck
    /** `N06` only: the attributed decision that reopened it. */
    note?: string
  },
): Promise<ReturnResult> {
  const current = await lockReturn(tx, input.returnId)
  if (!current) return { ok: false, reason: 'return_not_found' }

  if (current.status === 'CONFIRMED' || current.status === 'REPAID') {
    return { ok: true, returnId: current.id, status: current.status, transition: 'N02', duplicate: true }
  }
  if (!input.check.upheld) {
    return { ok: false, reason: 'check_did_not_uphold', detail: { why: input.check.why } }
  }

  const trigger = current.status === 'MANUAL_REVIEW' ? 'resolve_upheld' : 'upheld'
  const evaluated = evaluateReturnTransition(current.status, trigger)
  if (!evaluated.ok) {
    return { ok: false, reason: 'invalid_transition', detail: { from: current.status, trigger } }
  }
  if (evaluated.transition.requiresAttribution && (input.note ?? '').trim().length === 0) {
    return { ok: false, reason: 'resolution_note_required' }
  }

  // (1) The attempt's row lock, and the delivered amount to cap against.
  const attempts = (await tx.execute(sql`
    SELECT id, credited_minor, amount_currency, returned_total_minor, settlement_id
    FROM payout_attempts WHERE id = ${current.payout_attempt_id} FOR UPDATE`)) as unknown as {
    id: string
    credited_minor: string | number | bigint | null
    amount_currency: string | null
    returned_total_minor: string | number | bigint
    settlement_id: string
  }[]
  const attempt = attempts[0]
  if (!attempt) return { ok: false, reason: 'payout_attempt_not_found' }

  // (2) Recomputed from the rows inside the lock, not read from the counter.
  // The counter is what the database CHECK guards; the sum is what decides. If
  // they ever disagree, the sum is right and the disagreement is the finding.
  const totals = (await tx.execute(sql`
    SELECT COALESCE(sum(amount_minor), 0) AS confirmed
    FROM settlement_returns
    WHERE payout_attempt_id = ${current.payout_attempt_id}
      AND status IN ('CONFIRMED', 'REPAID')`)) as unknown as { confirmed: string | number | bigint }[]
  const confirmedSoFarMinor = BigInt(totals[0]?.confirmed ?? 0)

  const cap = checkReturnCap({
    delivered: {
      deliveredMinor: attempt.credited_minor === null ? null : BigInt(attempt.credited_minor),
      currency: attempt.amount_currency ?? current.amount_currency,
    },
    confirmedSoFarMinor,
    amount: money(current.amount_currency as never, BigInt(current.amount_minor)),
  })

  // (3) A breach goes to a human. INV-49: "it means either a provider defect or
  // a deduplication failure, and both need a human." Refusing it into silence
  // would lose the signal, which is the more valuable half of the finding.
  if (!cap.ok) {
    const escalated = await escalateReturn(tx, scope, {
      returnId: current.id,
      actor: input.actor,
      reasons: [`the cumulative return cap would be breached: ${cap.reason}`, describe(cap.detail)],
    })
    if (!escalated.ok) return escalated
    return {
      ok: true,
      returnId: current.id,
      status: 'MANUAL_REVIEW',
      transition: 'N04',
      ...(escalated.escalation ? { escalation: escalated.escalation } : {}),
      alarm: 'return_cap_breach',
    }
  }

  const now = await databaseNow(tx)

  // (4) The counter the database CHECK verifies. If this line and the sum above
  // ever disagree, the CHECK is what stops the disagreement becoming money.
  await tx.execute(sql`
    UPDATE payout_attempts SET returned_total_minor = ${cap.newTotalMinor}
    WHERE id = ${attempt.id}`)

  await tx
    .update(schema.settlementReturns)
    .set({
      status: 'CONFIRMED',
      confirmedAt: now,
      ...(input.note === undefined ? {} : { resolvedBy: input.actor.id, resolutionNote: input.note }),
    })
    .where(eq(schema.settlementReturns.id, current.id))

  await recordObservation(tx, scope, {
    returnId: current.id,
    source: input.check.source,
    observedAmountMinor: input.check.reportedMinor ?? undefined,
    observedAmountCurrency: input.check.reportedMinor === null ? undefined : current.amount_currency,
    openedTheReturn: false,
  })

  // (5) INV-41: confirming *requests* a repayment. It posts no ledger entry and
  // changes no availability — `drawn` falls on Y03/Y06 and on nothing else.
  const funding = (await tx.execute(sql`
    SELECT d.id, d.facility_id, d.amount_minor, d.amount_currency
    FROM drawdowns d
    WHERE d.settlement_id = ${current.settlement_id} AND d.status = 'CONFIRMED'
    LIMIT 1`)) as unknown as {
    id: string
    facility_id: string
    amount_minor: string | number | bigint
    amount_currency: string
  }[]
  const drawdown = funding[0]
  if (!drawdown) return { ok: false, reason: 'no_confirmed_drawdown' }

  const repayMinor = proRataRepayment({
    drawnMinor: BigInt(drawdown.amount_minor),
    deliveredMinor: BigInt(attempt.credited_minor!),
    returnedMinor: BigInt(current.amount_minor),
  })
  if (repayMinor <= 0n) {
    return {
      ok: false,
      reason: 'pro_rata_repayment_is_zero',
      detail: {
        why: 'the returned fraction of the delivery rounds to nothing against the drawdown',
      },
    }
  }

  const repayment = await requestRepayment(tx, scope, {
    facilityId: drawdown.facility_id,
    amount: money(drawdown.amount_currency as never, repayMinor),
    source: 'SETTLEMENT_RETURN',
    settlementId: current.settlement_id,
    returnId: current.id,
    actor: input.actor,
  })
  if (!repayment.ok) return { ok: false, reason: 'repayment_request_failed', detail: repayment }

  await tx
    .update(schema.settlementReturns)
    .set({ repaymentId: repayment.repaymentId })
    .where(eq(schema.settlementReturns.id, current.id))

  // (6) A separate artifact. The receipt is read for its hash and never written.
  const notice = await issueReturnNotice(tx, scope, {
    returnId: current.id,
    settlementId: current.settlement_id,
    actor: input.actor,
    amountMinor: BigInt(current.amount_minor),
    currency: current.amount_currency,
    reasonCode: current.reason_code,
    reasonMessage: current.reason_message,
    returnStatusAtIssue: 'CONFIRMED',
    providerReturnReference: current.provider_return_reference,
  })
  if (!notice.ok) return { ok: false, reason: 'return_notice_failed', detail: notice }

  const events = eventSink(tx)
  await events.event(scope, {
    type: 'settlement.return_confirmed',
    subjectType: 'settlement',
    subjectId: current.settlement_id,
    actor: input.actor,
    payload: {
      return_id: current.id,
      amount_minor: String(current.amount_minor),
      currency: current.amount_currency,
      reason_code: current.reason_code,
      notice_id: notice.artifactId,
      notice_content_hash: notice.contentHash,
      repayment_id: repayment.repaymentId,
    },
    deliver: true,
  })
  await events.audit(scope, {
    actor: input.actor,
    action: 'settlement.return_confirmed',
    subjectType: 'settlement',
    subjectId: current.settlement_id,
    before: { status: current.status, returned_total_minor: String(attempt.returned_total_minor) },
    after: {
      return_id: current.id,
      transition: evaluated.transition.id,
      returned_total_minor: String(cap.newTotalMinor),
      headroom_minor: String(cap.headroomMinor),
      repayment_id: repayment.repaymentId,
      notice_id: notice.artifactId,
    },
    ...(input.note ? { reason: input.note } : {}),
  })

  return {
    ok: true,
    returnId: current.id,
    status: 'CONFIRMED',
    transition: evaluated.transition.id,
    repaymentId: repayment.repaymentId,
    noticeId: notice.artifactId,
    noticeContentHash: notice.contentHash,
  }
}

/* ── N03 / N07 — not upheld ─────────────────────────────────────────────── */

/**
 * Reject a return the authoritative check did not substantiate — and alarm.
 *
 * `INV-40` is explicit that this is not a quiet outcome: *"a false return report
 * is a serious provider signal."* So the alarm is part of the return value
 * rather than a log line, and the audit record carries the provider's claim
 * beside what the check found.
 */
export async function rejectReturn(
  tx: Db,
  scope: TenantScope,
  input: { returnId: string; actor: PrincipalRef; why: string; note?: string },
): Promise<ReturnResult> {
  const current = await lockReturn(tx, input.returnId)
  if (!current) return { ok: false, reason: 'return_not_found' }

  const trigger = current.status === 'MANUAL_REVIEW' ? 'resolve_not_upheld' : 'not_upheld'
  const evaluated = evaluateReturnTransition(current.status, trigger)
  if (!evaluated.ok) {
    return { ok: false, reason: 'invalid_transition', detail: { from: current.status, trigger } }
  }
  if (evaluated.transition.requiresAttribution && (input.note ?? '').trim().length === 0) {
    return { ok: false, reason: 'resolution_note_required' }
  }

  await tx
    .update(schema.settlementReturns)
    .set({
      status: 'REJECTED',
      ...(input.note === undefined ? {} : { resolvedBy: input.actor.id, resolutionNote: input.note }),
    })
    .where(eq(schema.settlementReturns.id, current.id))

  const events = eventSink(tx)
  await events.event(scope, {
    type: 'settlement.return_rejected',
    subjectType: 'settlement',
    subjectId: current.settlement_id,
    actor: input.actor,
    payload: { return_id: current.id, why: input.why },
    deliver: true,
  })
  await events.audit(scope, {
    actor: input.actor,
    action: 'settlement.return_rejected',
    subjectType: 'settlement',
    subjectId: current.settlement_id,
    before: { status: current.status },
    after: {
      return_id: current.id,
      transition: evaluated.transition.id,
      provider_claimed_minor: String(current.amount_minor),
      check_found: input.why,
    },
    reason: input.note ?? 'the authoritative check did not substantiate the reported return',
  })

  return {
    ok: true,
    returnId: current.id,
    status: 'REJECTED',
    transition: evaluated.transition.id,
    alarm: 'return_not_upheld',
  }
}

/* ── N05 — repaid ───────────────────────────────────────────────────────── */

/**
 * Move a confirmed return to `REPAID` once its repayment has `CONFIRMED`.
 *
 * The repayment's status is read rather than asserted, because `INV-41` ties
 * this transition to `Y03`/`Y06` specifically: *"The compensating double-entry
 * is posted when — and only when — that repayment reaches `CONFIRMED`."* A
 * caller who could declare the repayment done would be able to mark a return
 * repaid against money that never came back.
 */
export async function markReturnRepaid(
  tx: Db,
  scope: TenantScope,
  input: { returnId: string; actor: PrincipalRef },
): Promise<ReturnResult> {
  const current = await lockReturn(tx, input.returnId)
  if (!current) return { ok: false, reason: 'return_not_found' }
  if (current.status === 'REPAID') {
    return { ok: true, returnId: current.id, status: 'REPAID', transition: 'N05', duplicate: true }
  }

  const evaluated = evaluateReturnTransition(current.status, 'repaid')
  if (!evaluated.ok) {
    return { ok: false, reason: 'invalid_transition', detail: { from: current.status } }
  }
  if (current.repayment_id === null) return { ok: false, reason: 'no_repayment_requested' }

  const rows = (await tx.execute(sql`
    SELECT status FROM repayments WHERE id = ${current.repayment_id}`)) as unknown as
    { status: string }[]
  if (rows[0]?.status !== 'CONFIRMED') {
    return {
      ok: false,
      reason: 'repayment_not_confirmed',
      detail: { status: rows[0]?.status ?? null },
    }
  }

  const now = await databaseNow(tx)
  await tx
    .update(schema.settlementReturns)
    .set({ status: 'REPAID', repaidAt: now })
    .where(eq(schema.settlementReturns.id, current.id))

  const events = eventSink(tx)
  await events.event(scope, {
    type: 'settlement.return_repaid',
    subjectType: 'settlement',
    subjectId: current.settlement_id,
    actor: input.actor,
    payload: { return_id: current.id, repayment_id: current.repayment_id },
    deliver: true,
  })
  await events.audit(scope, {
    actor: input.actor,
    action: 'settlement.return_repaid',
    subjectType: 'settlement',
    subjectId: current.settlement_id,
    after: { return_id: current.id, transition: 'N05', repayment_id: current.repayment_id },
  })

  return { ok: true, returnId: current.id, status: 'REPAID', transition: 'N05' }
}

/* ── The return watcher — N04 on a check SLA ────────────────────────────── */

/**
 * Escalate returns left `OBSERVED` past their check SLA.
 *
 * `§ 9` gives the return watcher exactly one action and one transition, and this
 * is it. No clock is injected, for the third time in this codebase and the same
 * reason each time: elapsed time is a fact, not a caller's assertion.
 */
export async function sweepReturnChecks(
  tx: Db,
  scope: TenantScope,
  input: { actor: PrincipalRef; checkSlaSeconds: number; limit?: number },
): Promise<readonly ReturnResult[]> {
  if (input.checkSlaSeconds <= 0) return [{ ok: false, reason: 'check_sla_must_be_positive' }]

  const now = await databaseNow(tx)
  const cutoff = new Date(now.getTime() - input.checkSlaSeconds * 1000).toISOString()
  const due = (await tx.execute(sql`
    SELECT id FROM settlement_returns
    WHERE status = 'OBSERVED' AND observed_at < ${cutoff}::timestamptz
    ORDER BY observed_at LIMIT ${input.limit ?? 50}`)) as unknown as { id: string }[]

  const results: ReturnResult[] = []
  for (const row of due) {
    results.push(
      await escalateReturn(tx, scope, {
        returnId: row.id,
        actor: input.actor,
        reasons: [`no authoritative check completed within ${input.checkSlaSeconds}s of observation`],
      }),
    )
  }
  return results
}

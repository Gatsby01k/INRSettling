/**
 * The funding leg — T09–T14, T27, T28, wired to a real facility.
 *
 * Stage 3 declared `active_liquidity_facility`, `facility_active`,
 * `sufficient_availability` and `active_reservation_exists` as `later_stage`
 * guards: required, never defaulted, and answered by an explicit test harness.
 * This file is the stage that owes those answers, and it answers them by
 * reading the facility rather than by being told.
 *
 * Two rules govern the ordering here.
 *
 * **The liquidity effect and the transition that claims it share a transaction,
 * and the liquidity effect goes first.** If the reservation fails there is no
 * transition to undo; if the transition fails the reservation rolls back with
 * it. The other order produces a settlement in `LIQUIDITY_RESERVED` with no
 * reservation, which is a lie the machine has no way to detect later.
 *
 * **But two status transitions never share a transaction.** `INV-32` permits
 * exactly one status event per transaction, so T09 and T10 are two — which is
 * not a limitation to work around but the reason `LIQUIDITY_RESERVING` exists
 * as a state. It is the durable marker that a reservation was started, so a
 * crash between the two leaves something recoverable rather than a settlement
 * that silently never tried. Functions spanning two transitions therefore take
 * the connection pool rather than a transaction, and a caller who passes a
 * transaction gets a type error instead of a runtime invariant violation.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import { money, type CurrencyCode, type Money } from '@inrsettle/money'
import {
  drawdownFingerprint,
  evaluateDrawdownTransition,
  type DrawdownTrigger,
  type PrincipalRef,
  type TenantScope,
} from '@inrsettle/domain'
import { applyTransition } from './settlement-transition.service.js'
import {
  consumeReservation,
  readFacility,
  releaseReservation,
  requestRepayment,
  reserveLiquidity,
} from './liquidity.service.js'
import { databaseNow } from './quote.service.js'

export type FundingResult =
  | {
      ok: true
      transition: string
      reservationId?: string
      drawdownId?: string
      /** True when a replayed provider callback changed nothing. */
      idempotent?: boolean
    }
  | { ok: false; reason: string; detail?: unknown }

/**
 * What a provider says it actually funded.
 *
 * Amount and currency are required. `facilityId` is optional only because some
 * providers do not echo it; when supplied it is checked, and a mismatch is
 * refused like any other.
 */
export interface DrawdownEvidence {
  readonly amountMinor: bigint
  readonly currency: string
  readonly facilityId?: string
  readonly providerReference?: string
}

type EvidenceMatch =
  | { ok: true }
  | { ok: false; reason: string; detail?: unknown }

/**
 * Match provider evidence against the drawdown we asked for.
 *
 * **Fail closed, in every direction.** Under-funding, over-funding, the wrong
 * currency and the wrong facility are all refused, and none of them consumes
 * the reservation or posts a ledger movement. Nothing here decides what to *do*
 * about a partial drawdown — that is a commercial and operational policy nobody
 * has written yet, and inventing one inside a matcher is how a policy gets made
 * by accident. What this guarantees is that a settlement is never quietly
 * marked `DRAWDOWN_CONFIRMED` on evidence that does not say the money arrived.
 */
function matchesDrawdown(
  drawdown: { amount_minor: string | number | bigint; amount_currency: string; facility_id: string },
  evidence: DrawdownEvidence | undefined,
): EvidenceMatch {
  if (!evidence) return { ok: false, reason: 'evidence_required' }

  const expected = BigInt(drawdown.amount_minor)

  if (evidence.currency !== drawdown.amount_currency) {
    // Checked before the amount: `1000000` of the wrong currency is not a
    // partial or an excess, and reporting it as one would be a worse answer
    // than reporting nothing.
    return {
      ok: false,
      reason: 'currency_mismatch',
      detail: { expected: drawdown.amount_currency, received: evidence.currency },
    }
  }

  if (evidence.facilityId !== undefined && evidence.facilityId !== drawdown.facility_id) {
    return {
      ok: false,
      reason: 'facility_mismatch',
      detail: { expected: drawdown.facility_id, received: evidence.facilityId },
    }
  }

  if (evidence.amountMinor !== expected) {
    // One reason code, two directions, and the detail says which. They are the
    // same failure — the provider did not fund what we asked for — and
    // splitting them into `partial` and `excess` would invite a caller to
    // handle one of them, which is exactly the policy this must not invent.
    return {
      ok: false,
      reason: 'amount_mismatch',
      detail: {
        expected: expected.toString(),
        received: evidence.amountMinor.toString(),
        direction: evidence.amountMinor < expected ? 'under' : 'over',
      },
    }
  }

  return { ok: true }
}

interface SettlementFundingRow {
  id: string
  status: string
  cancellation_requested_at: Date | null
  recipient_amount_minor: string | number | bigint
  funding_currency: string
}

async function lockSettlement(tx: Db, settlementId: string): Promise<SettlementFundingRow | null> {
  const rows = (await tx.execute(sql`
    SELECT id, status, cancellation_requested_at, recipient_amount_minor, funding_currency
    FROM settlements WHERE id = ${settlementId} FOR UPDATE`)) as unknown as SettlementFundingRow[]
  return rows[0] ?? null
}

/**
 * T09 — AUTHORIZED → LIQUIDITY_RESERVING. Its own transaction, necessarily.
 *
 * `INV-32` permits exactly one status event per transaction, so T09 and T10
 * cannot share one — and that constraint is not an inconvenience, it is the
 * reason `LIQUIDITY_RESERVING` exists as a state at all. It is the durable
 * marker that a reservation was *started*, so a crash between the two leaves a
 * settlement that can be recovered rather than one that silently never tried.
 */
async function beginReservation(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; facilityId: string; actor: PrincipalRef },
): Promise<FundingResult> {
  const settlement = await lockSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }

  const facility = await readFacility(tx, input.facilityId)
  if (!facility) return { ok: false, reason: 'facility_not_found' }

  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'begin_reservation',
    actor: input.actor,
    guards: {
      // Answered from the facility row, not from a caller's assertion.
      facility_active: facility.status === 'ACTIVE',
      no_cancellation_pending: settlement.cancellation_requested_at === null,
    },
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }
  return { ok: true, transition: outcome.transition }
}

/** T10 or T11 — take the reservation, then say which way it went. */
async function completeReservation(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    facilityId: string
    fundingAmount: Money
    ttlSeconds: number
    actor: PrincipalRef
  },
): Promise<FundingResult> {
  const facility = await readFacility(tx, input.facilityId)
  if (!facility) return { ok: false, reason: 'facility_not_found' }

  // The reservation is taken *before* the transition that claims it exists. The
  // other order produces a settlement in LIQUIDITY_RESERVED with no
  // reservation, which is a lie the machine has no way to detect later.
  const reserved = await reserveLiquidity(tx, scope, {
    facilityId: input.facilityId,
    settlementId: input.settlementId,
    amount: input.fundingAmount,
    ttlSeconds: input.ttlSeconds,
    actor: input.actor,
  })

  if (!reserved.ok) {
    // T11. A refusal returns a value rather than throwing, so nothing has been
    // written and this transaction is still free to write its one status event.
    const failed = await applyTransition(tx, scope, {
      settlementId: input.settlementId,
      trigger: 'reservation_failed',
      actor: input.actor,
      guards: {},
      exceptionCode:
        reserved.reason === 'facility_not_active' ? 'FACILITY_SUSPENDED' : 'LIQUIDITY_UNAVAILABLE',
    })
    return {
      ok: false,
      reason: reserved.reason,
      detail: { exceptionOpened: failed.ok, transition: failed.ok ? failed.transition : undefined },
    }
  }

  const succeeded = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'reservation_succeeded',
    actor: input.actor,
    guards: { sufficient_availability: true, facility_active: facility.status === 'ACTIVE' },
    statusEventPayload: { reservation_id: reserved.reservationId },
  })
  if (!succeeded.ok) return { ok: false, reason: succeeded.reason, detail: succeeded }

  return { ok: true, transition: succeeded.transition, reservationId: reserved.reservationId }
}

/**
 * T09 then T10/T11 — the reservation leg, in the two transactions it needs.
 *
 * Takes a `Db` rather than a `Db` transaction for exactly the reason
 * `runSettlementPreflight` does: it spans two status transitions, and a caller
 * that handed it one transaction would be asking for something `INV-32`
 * forbids. Passing a transaction here is a type error, which is the right place
 * for that mistake to surface.
 *
 * `fundingAmount` is supplied by the caller from the authorized terms and is
 * never recomputed here. Recomputing it would be a repricing at funding time,
 * which `D-08a` closes: a settlement funds the economics it was authorized on.
 */
export async function reserveForSettlement(
  db: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    facilityId: string
    fundingAmount: Money
    /** From configuration. `D-05` is open on the duration; nothing defaults it. */
    ttlSeconds: number
    actor: PrincipalRef
  },
): Promise<FundingResult> {
  const began = await withTenant(db, scope, (tx) =>
    beginReservation(tx, scope, {
      settlementId: input.settlementId,
      facilityId: input.facilityId,
      actor: input.actor,
    }),
  )
  if (!began.ok) return began
  return withTenant(db, scope, (tx) => completeReservation(tx, scope, input))
}

/**
 * T12 — request the drawdown.
 *
 * A checkpoint, in the frozen sense: a cancellation request that arrived while
 * the reservation was held takes effect *here*, before real funding moves,
 * rather than racing it.
 */
export async function requestDrawdown(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<FundingResult> {
  const settlement = await lockSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }

  const reservations = (await tx.execute(sql`
    SELECT id, facility_id, amount_minor, amount_currency
    FROM liquidity_reservations
    WHERE settlement_id = ${input.settlementId} AND status = 'ACTIVE'
    FOR UPDATE`)) as unknown as {
    id: string
    facility_id: string
    amount_minor: string | number | bigint
    amount_currency: string
  }[]
  const reservation = reservations[0]

  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'request_drawdown',
    actor: input.actor,
    guards: {
      // Answered from the database, which is the point of this stage.
      active_reservation_exists: reservation !== undefined,
      no_cancellation_pending: settlement.cancellation_requested_at === null,
    },
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }
  if (!reservation) return { ok: false, reason: 'no_active_reservation' }

  const drawdownId = newId('drawdown')
  await tx.insert(schema.drawdowns).values({
    id: drawdownId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    facilityId: reservation.facility_id,
    settlementId: input.settlementId,
    reservationId: reservation.id,
    amountMinor: BigInt(reservation.amount_minor),
    amountCurrency: reservation.amount_currency,
    status: 'REQUESTED',
    requestFingerprint: drawdownFingerprint(drawdownId),
    requestedBy: input.actor.id,
  })

  return { ok: true, transition: outcome.transition, drawdownId }
}

/**
 * T13/T14/T29 — the drawdown answers.
 *
 * A confirmation consumes the reservation (V02); a failure releases it (V03);
 * a timeout does **neither**, because a drawdown we are unsure about may have
 * moved money and releasing its reservation would free capacity that is
 * actually drawn. That asymmetry is the whole reason `UNKNOWN` exists.
 */
export async function resolveDrawdown(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    trigger: Extract<DrawdownTrigger, 'confirmed' | 'failed' | 'sla_elapsed' | 'pull_resolved_confirmed' | 'pull_resolved_failed'>
    actor: PrincipalRef
    providerReference?: string
    /** Whether the provider event was verified. Never defaulted to true. */
    providerEventVerified: boolean
    /**
     * What the provider says it funded. **Required to confirm.**
     *
     * A confirmation is not a word, it is a claim about an amount. Without
     * this, "confirmed" alone consumed the reservation and posted the funding
     * movement — so a provider event for the wrong amount, or in the wrong
     * currency, or against a different facility, would have moved the ledger by
     * the amount we *expected* rather than the amount that actually arrived.
     */
    evidence?: DrawdownEvidence
  },
): Promise<FundingResult> {
  await lockSettlement(tx, input.settlementId)

  const rows = (await tx.execute(sql`
    SELECT id, status, facility_id, amount_minor, amount_currency, provider_reference
    FROM drawdowns
    WHERE settlement_id = ${input.settlementId}
    ORDER BY requested_at DESC LIMIT 1 FOR UPDATE`)) as unknown as {
    id: string
    status: 'REQUESTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'
    facility_id: string
    amount_minor: string | number | bigint
    amount_currency: string
    provider_reference: string | null
  }[]
  const drawdown = rows[0]
  if (!drawdown) return { ok: false, reason: 'drawdown_not_found' }

  const confirming =
    input.trigger === 'confirmed' || input.trigger === 'pull_resolved_confirmed'
  const failing = input.trigger === 'failed' || input.trigger === 'pull_resolved_failed'

  // **Every refusal happens before any write.**
  //
  // This ordering was a bug, and a bad one. `provider_event_verified` used to
  // be checked only where it belongs conceptually — as a guard on T13, inside
  // `applyTransition` — but by then this function had already updated the
  // drawdown row and consumed the reservation. The transition was correctly
  // refused and the function correctly returned `ok: false`; the caller's
  // transaction then *committed*, because returning a refusal is not throwing.
  // An unverified provider event left a CONSUMED reservation and a CONFIRMED
  // drawdown behind a failed call.
  //
  // The guard is still passed to the machine below, which is where it is
  // normative. This is the earlier, cheaper copy that keeps the mutation from
  // happening at all.
  if ((confirming || failing) && !input.providerEventVerified) {
    return { ok: false, reason: 'guard_failed', detail: { guard: 'provider_event_verified' } }
  }

  // Evidence is checked before the transition is evaluated too, so a mismatched
  // confirmation never reaches the machine at all — not even to be refused by
  // it. The refusal is about the money, and it should read that way.
  if (confirming) {
    const match = matchesDrawdown(drawdown, input.evidence)
    if (!match.ok) return { ok: false, reason: match.reason, detail: match.detail }
  }

  // A duplicate confirmation carrying the *same* evidence is a replayed
  // provider callback, and `STATE_MACHINES.md § 10` requires those to produce
  // one state change and one status event however many times they arrive. It is
  // answered here, before the machine, because the machine correctly has no
  // CONFIRMED → CONFIRMED row: idempotence is a property of the delivery
  // channel, not a transition.
  if (confirming && drawdown.status === 'CONFIRMED') {
    return { ok: true, transition: 'W02', drawdownId: drawdown.id, idempotent: true }
  }

  const evaluated = evaluateDrawdownTransition(drawdown.status, input.trigger)
  if (!evaluated.ok) {
    return { ok: false, reason: 'invalid_transition', detail: { from: drawdown.status, trigger: input.trigger } }
  }

  const now = await databaseNow(tx)
  const patch: Record<string, unknown> = { status: evaluated.to }
  if (evaluated.to === 'CONFIRMED') patch['confirmedAt'] = now
  if (evaluated.to === 'FAILED') patch['failedAt'] = now
  if (input.providerReference) patch['providerReference'] = input.providerReference
  await tx.update(schema.drawdowns).set(patch as never).where(eq(schema.drawdowns.id, drawdown.id))

  if (evaluated.to === 'CONFIRMED') {
    const consumed = await consumeReservation(tx, scope, {
      settlementId: input.settlementId,
      actor: input.actor,
    })
    if (!consumed.ok) return { ok: false, reason: consumed.reason }

    const outcome = await applyTransition(tx, scope, {
      settlementId: input.settlementId,
      trigger: 'drawdown_confirmed',
      actor: input.actor,
      guards: { provider_event_verified: input.providerEventVerified },
      companions: [
        {
          type: 'facility.drawdown_confirmed',
          subjectType: 'settlement',
          subjectId: input.settlementId,
        },
      ],
    })
    if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }
    return { ok: true, transition: outcome.transition, drawdownId: drawdown.id }
  }

  if (evaluated.to === 'FAILED') {
    const released = await releaseReservation(tx, scope, {
      settlementId: input.settlementId,
      reason: 'drawdown_failed',
      actor: input.actor,
    })
    if (!released.ok) return { ok: false, reason: released.reason }

    const outcome = await applyTransition(tx, scope, {
      settlementId: input.settlementId,
      trigger: 'drawdown_failed',
      actor: input.actor,
      guards: { provider_event_verified: input.providerEventVerified },
      exceptionCode: 'DRAWDOWN_FAILED',
      companions: [
        {
          type: 'facility.reservation_released',
          subjectType: 'settlement',
          subjectId: input.settlementId,
        },
      ],
    })
    if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }
    return { ok: true, transition: outcome.transition, drawdownId: drawdown.id }
  }

  // UNKNOWN (T29). The reservation stays exactly where it is: still ACTIVE,
  // still holding the value, because the money may have moved. Resolving it
  // takes an authoritative status pull, never a resubmission.
  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'drawdown_timeout',
    actor: input.actor,
    guards: { drawdown_sla_elapsed: true },
    exceptionCode: 'DRAWDOWN_STATUS_UNKNOWN',
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }
  return { ok: true, transition: outcome.transition, drawdownId: drawdown.id }
}

/**
 * The compensation a cancellation owes, decided by where the settlement is.
 *
 * `INV-22`: from `LIQUIDITY_RESERVED` the reservation is released; from
 * `DRAWDOWN_CONFIRMED` it is **not** — the reservation is consumed and has
 * nothing to give back, so capacity returns through a repayment instead. Doing
 * both, or the wrong one, credits the facility twice.
 *
 * `D-16` (post-funding cancellation policy) is **not** decided here. Whether
 * cancelling after a confirmed drawdown is always allowed, fee-bearing or
 * rate-limited is a commercial question; this function implements the
 * mechanical consequence of a cancellation that has already been permitted.
 */
export async function compensateCancellation(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<
  | { ok: true; compensation: 'reservation_released' | 'repayment_requested' | 'none'; repaymentId?: string }
  | { ok: false; reason: string }
> {
  const settlement = await lockSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }

  const rows = (await tx.execute(sql`
    SELECT id, facility_id, amount_minor, amount_currency, status
    FROM liquidity_reservations WHERE settlement_id = ${input.settlementId}
    ORDER BY created_at DESC LIMIT 1`)) as unknown as {
    id: string
    facility_id: string
    amount_minor: string | number | bigint
    amount_currency: string
    status: string
  }[]
  const reservation = rows[0]
  if (!reservation) return { ok: true, compensation: 'none' }

  if (reservation.status === 'ACTIVE') {
    const released = await releaseReservation(tx, scope, {
      settlementId: input.settlementId,
      reason: 'settlement_cancelled',
      actor: input.actor,
    })
    if (!released.ok) return { ok: false, reason: released.reason }
    return { ok: true, compensation: 'reservation_released' }
  }

  if (reservation.status === 'CONSUMED') {
    const amount = money(
      reservation.amount_currency as CurrencyCode,
      BigInt(reservation.amount_minor),
    )
    const repayment = await requestRepayment(tx, scope, {
      facilityId: reservation.facility_id,
      amount,
      source: 'CANCELLATION_AFTER_DRAWDOWN',
      settlementId: input.settlementId,
      actor: input.actor,
    })
    if (!repayment.ok) return { ok: false, reason: repayment.reason }
    // Note what has *not* happened: availability has not moved. It moves when
    // the repayment confirms, and not before (`INV-46`).
    return { ok: true, compensation: 'repayment_requested', repaymentId: repayment.repaymentId }
  }

  // Already released or expired: nothing is owed.
  return { ok: true, compensation: 'none' }
}

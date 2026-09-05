/**
 * Settlement operations — preflight, quoting, authorization, cancellation, and
 * the dispatch boundary.
 *
 * Every one of these ends in `applyTransition`. None of them writes
 * `settlements.status` itself, and none of them decides what the machine
 * allows: they gather the guard answers under the row lock and hand them to the
 * frozen table.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import { money, type CurrencyCode, type Money } from '@inrsettle/money'
import type { WorkspaceRole } from '@inrsettle/contracts'
import {
  capabilitiesFor,
  denialFor,
  evaluateSeparationOfDuties,
  allocateAttemptNumber,
  canonicalInstructionObject,
  freezeInstruction,
  payoutIdempotencyKey,
  isVersionVerified,
  type ExceptionCode,
  type PayoutRail,
  type PreflightRuleSet,
  type PrincipalRef,
  type SettlementStatus,
  type TenantScope,
} from '@inrsettle/domain'
import { eventSink } from './events.js'
import { applyTransition, companion, type TransitionOutcome } from './settlement-transition.service.js'
import { databaseNow, getQuote, transitionQuote } from './quote.service.js'
import { getBeneficiary } from './beneficiary.service.js'
import { runPreflightFor } from './preflight.service.js'
import { getSeparationOfDuties } from './security-policy.service.js'

type SettlementRow = typeof schema.settlements.$inferSelect

export async function getSettlement(tx: Db, id: string): Promise<SettlementRow | null> {
  const [row] = await tx.select().from(schema.settlements).where(eq(schema.settlements.id, id)).limit(1)
  return row ?? null
}

export async function listSettlements(tx: Db, limit = 50): Promise<SettlementRow[]> {
  return tx.select().from(schema.settlements).orderBy(desc(schema.settlements.createdAt)).limit(limit)
}

/* ── Preflight (T02 → T03 / T04) ───────────────────────────────────────── */

export interface PreflightSettlementInput {
  settlementId: string
  ruleSet: PreflightRuleSet
  hasActiveLiquidityFacility: boolean
  documents?: readonly string[]
  actor: PrincipalRef
}

/**
 * T02 — enter PREFLIGHTING.
 *
 * Split from the completion step on purpose, and the reason is `INV-32` rather
 * than taste: exactly one status event per transaction means two transitions
 * are two transactions. That is also the honest model — `PREFLIGHTING` is a
 * state a customer can observe, not an implementation detail of "run
 * preflight", and collapsing the pair would make it unobservable.
 */
export async function startPreflight(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<TransitionOutcome> {
  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }
  return applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'run_preflight',
    actor: input.actor,
    guards: {
      beneficiary_amount_purpose_present:
        settlement.beneficiaryId !== '' &&
        settlement.recipientAmountMinor > 0n &&
        settlement.purposeCode !== null,
    },
  })
}

/** T03 or T04 — leave PREFLIGHTING for READY or ACTION_REQUIRED. */
export async function completePreflight(
  tx: Db,
  scope: TenantScope,
  input: PreflightSettlementInput,
): Promise<
  | { ok: true; status: 'READY' | 'ACTION_REQUIRED'; requirementCodes: string[] }
  | { ok: false; outcome: TransitionOutcome }
> {
  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, outcome: { ok: false, reason: 'settlement_not_found' } }

  const preflight = await runPreflightFor(tx, scope, input.ruleSet, {
    beneficiaryId: settlement.beneficiaryId,
    ...(settlement.destinationId ? { destinationId: settlement.destinationId } : {}),
    amount: { currency: 'INR', minorUnits: settlement.recipientAmountMinor },
    purposeCode: settlement.purposeCode,
    ...(input.documents ? { documents: input.documents } : {}),
    hasActiveLiquidityFacility: input.hasActiveLiquidityFacility,
  })
  if (!preflight.ok) return { ok: false, outcome: { ok: false, reason: 'settlement_not_found' } }

  const blocking = preflight.outcome.requirements.filter((r) => r.severity === 'blocking')
  const passed = blocking.length === 0

  const finished = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: passed ? 'preflight_passed' : 'preflight_blocked',
    actor: input.actor,
    guards: { no_blocking_requirements: passed, has_blocking_requirements: !passed },
    companions: [
      companion.preflightCompleted(input.settlementId, {
        rule_set_version: preflight.outcome.ruleSetVersion,
        fingerprint: preflight.outcome.fingerprint,
        blocking: blocking.map((r) => r.code),
      }),
    ],
  })
  if (!finished.ok) return { ok: false, outcome: finished }

  return {
    ok: true,
    status: passed ? 'READY' : 'ACTION_REQUIRED',
    requirementCodes: blocking.map((r) => r.code),
  }
}

/**
 * The convenience wrapper. Takes the **database handle**, not a transaction,
 * because it must open two: one per status change.
 */
export async function runSettlementPreflight(
  db: Db,
  scope: TenantScope,
  input: PreflightSettlementInput,
): Promise<
  | { ok: true; status: 'READY' | 'ACTION_REQUIRED'; requirementCodes: string[] }
  | { ok: false; outcome: TransitionOutcome }
> {
  const started = await withTenant(db, scope, (tx) =>
    startPreflight(tx, scope, { settlementId: input.settlementId, actor: input.actor }),
  )
  if (!started.ok) return { ok: false, outcome: started }
  return withTenant(db, scope, (tx) => completePreflight(tx, scope, input))
}

/* ── Quoting (T06 / T07) ───────────────────────────────────────────────── */

export async function attachQuote(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; quoteId: string; actor: PrincipalRef },
): Promise<TransitionOutcome> {
  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }
  const quote = await getQuote(tx, input.quoteId)
  const now = await databaseNow(tx)

  const attachable =
    quote !== null &&
    quote.workspaceId === settlement.workspaceId &&
    quote.environment === settlement.environment &&
    quote.status === 'ACTIVE' &&
    quote.consumedBySettlementId === null &&
    now.getTime() <= quote.expiresAt.getTime() &&
    quote.recipientAmount.minorUnits === settlement.recipientAmountMinor &&
    quote.fundingAmount.currency === settlement.fundingCurrency

  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'attach_quote',
    actor: input.actor,
    guards: { quote_attachable: attachable },
    patch: attachable ? { quoteId: input.quoteId } : {},
    companions: attachable ? [companion.quoteLocked(input.quoteId)] : [],
  })
  if (outcome.ok) await transitionQuote(tx, scope, { quoteId: input.quoteId, trigger: 'lock', actor: input.actor })
  return outcome
}

/** T07 — a locked quote that expired returns the settlement to READY. */
export async function expireAttachedQuote(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<TransitionOutcome> {
  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement?.quoteId) return { ok: false, reason: 'settlement_not_found' }
  const quote = await getQuote(tx, settlement.quoteId)
  const now = await databaseNow(tx)
  const expired = quote !== null && now.getTime() > quote.expiresAt.getTime()

  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'quote_expired',
    actor: input.actor,
    guards: { quote_expired_by_server_clock: expired },
    // The settlement drops the quote; it does not silently re-price.
    patch: expired ? { quoteId: null } : {},
    companions: expired ? [companion.quoteExpired(settlement.quoteId)] : [],
  })
  if (outcome.ok) {
    await transitionQuote(tx, scope, { quoteId: settlement.quoteId, trigger: 'expire', actor: input.actor })
  }
  return outcome
}

/* ── Authorization (T08) ───────────────────────────────────────────────── */

export interface AuthorizeInput {
  settlementId: string
  actor: PrincipalRef
  actorRoles: readonly WorkspaceRole[]
  ruleSet: PreflightRuleSet
  /**
   * Stage 4 owns liquidity. Stage 3 requires the answer and never defaults it —
   * `D-10` is closed and live authorization requires a facility.
   */
  hasActiveLiquidityFacility: boolean
  /**
   * Documents attached to the settlement. Preflight must see the same evidence
   * at authorization that it saw when it last passed, or "preflight still
   * passing" would be checking a different question.
   */
  documents?: readonly string[]
  expectedVersion?: number
}

export type AuthorizeResult =
  | { ok: true; version: number; authorizedTermsHash: string }
  | { ok: false; reason: string; detail?: unknown }

/**
 * Authorize a settlement.
 *
 * Authorization is **not** irreversibility (`INV-35`). It freezes the
 * instruction and permits execution to begin; the settlement stays cancellable
 * until `point_of_no_return_at` is stamped.
 *
 * Everything the frozen table names is checked here, under the row lock, and
 * the result is frozen by value before the transition is applied.
 */
export async function authorizeSettlement(
  tx: Db,
  scope: TenantScope,
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }
  if (!settlement.quoteId) return { ok: false, reason: 'no_quote_attached' }

  const quote = await getQuote(tx, settlement.quoteId)
  const now = await databaseNow(tx)

  // INV-15 — expiry against the database clock, never a client-supplied time.
  const quoteValid =
    quote !== null &&
    quote.workspaceId === settlement.workspaceId &&
    quote.environment === settlement.environment &&
    (quote.status === 'ACTIVE' || quote.status === 'LOCKED') &&
    quote.consumedBySettlementId === null &&
    now.getTime() <= quote.expiresAt.getTime() &&
    quote.recipientAmount.minorUnits === settlement.recipientAmountMinor

  // INV-11 — the beneficiary is verified and, more importantly, the *exact
  // destination version* is verified. The version is what gets frozen.
  const beneficiary = await getBeneficiary(tx, scope, settlement.beneficiaryId)
  const destination =
    beneficiary?.destinations.find((d) =>
      settlement.destinationId ? d.id === settlement.destinationId : d.id === beneficiary.defaultDestinationId,
    ) ?? beneficiary?.destinations.find((d) => d.disabledAt === null)
  const version = destination?.currentVersion ?? null

  const destinationVerified =
    version !== null &&
    isVersionVerified({
      destinationVersionId: version.id,
      status: version.verificationStatus,
      method: null,
      nameMatchScore: version.nameMatchScore,
      verifiedAt: version.verifiedAt,
    })

  // Preflight must still pass *now*, not when it was last run.
  const preflight = await runPreflightFor(tx, scope, input.ruleSet, {
    beneficiaryId: settlement.beneficiaryId,
    ...(settlement.destinationId ? { destinationId: settlement.destinationId } : {}),
    amount: { currency: 'INR', minorUnits: settlement.recipientAmountMinor },
    purposeCode: settlement.purposeCode,
    ...(input.documents ? { documents: input.documents } : {}),
    hasActiveLiquidityFacility: input.hasActiveLiquidityFacility,
  })
  const preflightPassing = preflight.ok && preflight.outcome.status === 'ready'

  // Stage 1's capability model and separation-of-duties policy, unchanged.
  const capabilities = capabilitiesFor(input.actorRoles)
  if (!capabilities.has('settlement:authorize')) {
    return { ok: false, reason: 'missing_capability' }
  }

  // Stage 1's policy, unchanged and not re-implemented here.
  const sodEnabled = await getSeparationOfDuties(tx, scope)
  const decision = evaluateSeparationOfDuties({
    policy: { enabled: sodEnabled },
    createdBy: { type: 'user', id: settlement.createdBy },
    authorizedBy: input.actor,
  })

  if (!decision.allowed) {
    const denial = denialFor(decision)!
    // A refusal that is worth recording: someone tried to authorize money and
    // the policy said no.
    await eventSink(tx).audit(scope, {
      actor: input.actor,
      action: 'settlement.authorize_refused',
      subjectType: 'settlement',
      subjectId: input.settlementId,
      after: { code: denial.code },
      reason: denial.title,
    })
    return { ok: false, reason: denial.code, detail: denial }
  }

  if (!quoteValid || !destinationVerified || !preflightPassing) {
    // Fall through to the machine, which will refuse with the named guard —
    // one rejection path rather than two that can disagree.
    const refused = await applyTransition(tx, scope, {
      settlementId: input.settlementId,
      trigger: 'authorize',
      actor: input.actor,
      guards: {
        quote_valid_for_authorization: quoteValid,
        beneficiary_verified: beneficiary?.status === 'verified',
        destination_version_verified: destinationVerified,
        actor_may_authorize: true,
        preflight_still_passing: preflightPassing,
        active_liquidity_facility: input.hasActiveLiquidityFacility,
      },
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    })
    return { ok: false, reason: refused.ok ? 'unexpected' : refused.reason, detail: refused }
  }

  // Freeze by value. Nothing downstream reads the live beneficiary, the live
  // destination, or the quote row again.
  const frozen = freezeInstruction({
    beneficiaryId: settlement.beneficiaryId,
    destinationId: destination!.id,
    destinationVersionId: version!.id,
    purposeCode: settlement.purposeCode ?? '',
    quote: {
      id: quote!.id,
      direction: quote!.direction,
      recipientAmount: quote!.recipientAmount,
      fundingAmount: quote!.fundingAmount,
      fxRate: {
        pair: quote!.fxRate.pair,
        rateScaled: quote!.fxRate.rateScaled,
        scale: quote!.fxRate.scale,
        quotedAt: quote!.fxRate.quotedAt,
      },
      feeComponents: quote!.feeComponents,
      roundingResidual: quote!.roundingResidual,
      createdAt: quote!.createdAt,
      expiresAt: quote!.expiresAt,
    },
  })

  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'authorize',
    actor: input.actor,
    guards: {
      quote_valid_for_authorization: true,
      beneficiary_verified: beneficiary!.status === 'verified',
      destination_version_verified: true,
      actor_may_authorize: true,
      preflight_still_passing: true,
      active_liquidity_facility: input.hasActiveLiquidityFacility,
    },
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    patch: {
      destinationId: destination!.id,
      destinationVersionId: version!.id,
      // The hashed preimage itself, so the hash is verifiable from the row.
      authorizedTerms: canonicalInstructionObject(frozen.instruction) as never,
      authorizedTermsHash: frozen.hash,
      authorizedAt: now,
      authorizedBy: input.actor.id,
    },
    statusEventPayload: { authorized_terms_hash: frozen.hash },
    companions: [companion.quoteConsumed(quote!.id, input.settlementId)],
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }

  // INV-14 — the unique index is what actually enforces single consumption; a
  // second authorization against this quote fails here, in the database.
  const consumed = await transitionQuote(tx, scope, {
    quoteId: quote!.id,
    trigger: 'consume',
    actor: input.actor,
    consumedBySettlementId: input.settlementId,
  })
  if (!consumed.ok) return { ok: false, reason: consumed.reason }

  return { ok: true, version: outcome.version, authorizedTermsHash: frozen.hash }
}

/* ── Cancellation (T25 / T26 / T27) ────────────────────────────────────── */

/**
 * Cancel, or request cancellation.
 *
 * The distinction is the frozen one and it is not cosmetic. Before
 * authorization, cancelling is immediate (T25). After authorization the
 * customer is *requesting* cancellation (T26): the request is recorded under
 * the row lock, and it takes effect at the next checkpoint (T27). Turning a
 * post-authorization request into a direct status change would race whatever
 * funding call is in flight.
 */
export async function cancelSettlement(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef; actorRoles: readonly WorkspaceRole[]; reason?: string },
): Promise<TransitionOutcome | { ok: false; reason: 'past_point_of_no_return' }> {
  const capabilities = capabilitiesFor(input.actorRoles)
  const mayCancel = capabilities.has('settlement:cancel')

  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }

  const preAuthorization: SettlementStatus[] = ['DRAFT', 'READY', 'QUOTED', 'ACTION_REQUIRED']
  if (preAuthorization.includes(settlement.status)) {
    return applyTransition(tx, scope, {
      settlementId: input.settlementId,
      trigger: 'cancel',
      actor: input.actor,
      guards: { actor_may_cancel: mayCancel },
      companions: settlement.quoteId ? [companion.quoteExpired(settlement.quoteId)] : [],
      ...(input.reason ? { reason: input.reason } : {}),
    })
  }

  return requestCancellation(tx, scope, { ...input, mayCancel })
}

/**
 * T26 — the annotation.
 *
 * Takes the **same row lock** the dispatch transaction takes, which is what
 * gives the two a total order. If this commits first, dispatch sees the flag
 * and aborts. If dispatch commits first, this sees `point_of_no_return_at` and
 * is refused. There is no third outcome and no window between them.
 */
export async function requestCancellation(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef; mayCancel: boolean; reason?: string },
): Promise<TransitionOutcome | { ok: false; reason: 'past_point_of_no_return' }> {
  const locked = (await tx.execute(sql`
    SELECT id, status, point_of_no_return_at FROM settlements
    WHERE id = ${input.settlementId} FOR UPDATE`)) as unknown as {
    id: string
    status: SettlementStatus
    point_of_no_return_at: Date | null
  }[]
  const current = locked[0]
  if (!current) return { ok: false, reason: 'settlement_not_found' }

  if (current.point_of_no_return_at !== null) {
    await eventSink(tx).audit(scope, {
      actor: input.actor,
      action: 'settlement.cancellation_refused',
      subjectType: 'settlement',
      subjectId: input.settlementId,
      after: { reason: 'past_point_of_no_return' },
    })
    return { ok: false, reason: 'past_point_of_no_return' }
  }

  const now = await databaseNow(tx)
  return applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'request_cancellation',
    actor: input.actor,
    guards: { before_point_of_no_return: true, actor_may_cancel: input.mayCancel },
    patch: { cancellationRequestedAt: now, cancellationRequestedBy: input.actor.id },
    companions: [companion.cancellationRequested(input.settlementId)],
    ...(input.reason ? { reason: input.reason } : {}),
  })
}

/** T27 — the request takes effect at a checkpoint. */
export async function honourCancellation(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef; facilityCompensation?: 'release' | 'repayment' },
): Promise<TransitionOutcome> {
  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }

  // From DRAWDOWN_CONFIRMED it is a repayment, never a release (INV-22).
  const compensation =
    input.facilityCompensation ??
    (settlement.status === 'DRAWDOWN_CONFIRMED' ? 'repayment' : 'release')

  return applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'cancellation_honoured',
    actor: input.actor,
    guards: {
      cancellation_pending: settlement.cancellationRequestedAt !== null,
      at_checkpoint: true,
      before_point_of_no_return: settlement.pointOfNoReturnAt === null,
    },
    companions:
      settlement.status === 'AUTHORIZED'
        ? []
        : [
            {
              type: compensation === 'repayment' ? 'facility.repayment_requested' : 'facility.reservation_released',
              subjectType: 'settlement',
              subjectId: input.settlementId,
            },
          ],
  })
}

/* ── The dispatch boundary (T15) ───────────────────────────────────────── */

export type DispatchResult =
  | {
      ok: true
      payoutAttemptId: string
      attemptNumber: number
      idempotencyKey: string
      pointOfNoReturnAt: Date
      /** True when this call reused an in-flight attempt rather than creating one. */
      reused: boolean
    }
  | { ok: false; reason: string; detail?: unknown }

/**
 * The dispatch transaction — `INV-36`.
 *
 * Exactly one transaction, doing exactly this, in this order: serialize on the
 * settlement row, check the flags, cross the boundary, create the durable
 * attempt, write the event. **No outbound call happens inside it.** The
 * provider is called by a job enqueued after commit, because a network call
 * must never be made while holding a row lock and a transaction must never be
 * rolled back after a call that may have created a real payout.
 *
 * Stage 3 stops at the commit. There is no `PayoutProvider` here and no Stage 5
 * orchestration; what exists is the boundary and the durable identity, which is
 * what the rest of the machine needs to be exhaustive.
 */
export async function dispatchPayout(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    actor: PrincipalRef
    /** Stage 5 selects the rail. Stage 3 requires the answer, never defaults it. */
    railSelected: boolean
    /* Stage 5 — the execution facts, recorded on the attempt at dispatch. */
    rail?: PayoutRail
    slaSeconds?: number
    providerId?: string
    /** The recipient amount in INR minor units, as authorized. */
    fundingAmountMinor?: bigint
  },
): Promise<DispatchResult> {
  // (a) serialize — the same lock T26 takes.
  const locked = (await tx.execute(sql`
    SELECT id, status, cancellation_requested_at, point_of_no_return_at,
           destination_version_id, authorized_terms_hash
    FROM settlements WHERE id = ${input.settlementId} FOR UPDATE`)) as unknown as {
    id: string
    status: SettlementStatus
    cancellation_requested_at: Date | null
    point_of_no_return_at: Date | null
    destination_version_id: string | null
    authorized_terms_hash: string | null
  }[]
  const current = locked[0]
  if (!current) return { ok: false, reason: 'settlement_not_found' }

  // (b) the last check. If cancellation committed first, we see it here.
  if (current.cancellation_requested_at !== null) {
    return { ok: false, reason: 'cancellation_pending' }
  }
  if (!current.destination_version_id || !current.authorized_terms_hash) {
    return { ok: false, reason: 'not_authorized' }
  }

  // The frozen version must still be verified — read from the settlement, never
  // from destination.current_version_id.
  const [frozenVersion] = await tx
    .select()
    .from(schema.destinationVerifications)
    .where(
      and(
        eq(schema.destinationVerifications.destinationVersionId, current.destination_version_id),
        eq(schema.destinationVerifications.status, 'verified'),
      ),
    )
    .limit(1)

  // (b2) Which attempt is this? Read every attempt under the same row lock and
  //      let the domain decide (INV-24). Reading here rather than trusting a
  //      caller-supplied number is what makes "two concurrent non-terminal
  //      attempts are impossible" true before the unique index has to catch it.
  const existing = await tx
    .select({
      attemptNumber: schema.payoutAttempts.attemptNumber,
      status: schema.payoutAttempts.status,
    })
    .from(schema.payoutAttempts)
    .where(eq(schema.payoutAttempts.settlementId, input.settlementId))

  const allocation = allocateAttemptNumber(existing)
  if (!allocation.ok) {
    return { ok: false, reason: `attempt_${allocation.reason}`, detail: allocation }
  }

  // (b3) The boundary, checked *after* the allocation rather than before it.
  //
  //      The order matters and it took a bug to see why. Refusing every call
  //      once `point_of_no_return_at` is stamped reads as the safe thing to do,
  //      but the stamp and the first attempt are written in the same
  //      transaction — so "boundary crossed" is true for the retry of the very
  //      submission that crossed it. Refusing there would leave Stage 5 with a
  //      timed-out provider call and no way to ask what key it should present
  //      again, and the only way out of that is to invent one.
  if (current.point_of_no_return_at !== null) {
    // A retry of the in-flight submission: same number, same key, no new row,
    // and the boundary is emphatically not crossed twice.
    if (allocation.reason === 'reuse_in_flight') {
      const [attempt] = await tx
        .select()
        .from(schema.payoutAttempts)
        .where(
          and(
            eq(schema.payoutAttempts.settlementId, input.settlementId),
            eq(schema.payoutAttempts.attemptNumber, allocation.attemptNumber),
          ),
        )
        .limit(1)
      if (!attempt) return { ok: false, reason: 'attempt_state_inconsistent' }
      return {
        ok: true,
        payoutAttemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        idempotencyKey: attempt.idempotencyKey,
        // Re-wrapped because a raw `tx.execute` hands back the driver's own
        // representation of a timestamptz, which is not always a Date. The
        // declared type said Date and a caller believed it.
        pointOfNoReturnAt: new Date(current.point_of_no_return_at),
        reused: true,
      }
    }
    // The allocator would permit a further attempt — the previous one was
    // authoritatively rejected — but *starting* one is the Stage 5 retry path,
    // and T15 requires `before_point_of_no_return`. Stage 3 models the identity
    // and refuses to mint it, which is different from pretending it cannot exist.
    return { ok: false, reason: 'already_dispatched', detail: allocation }
  }

  // Past the boundary check with no stamp: this must be the first attempt, and
  // if it is not, something wrote a payout attempt outside this function.
  if (allocation.reason !== 'first_attempt') {
    return { ok: false, reason: 'attempt_state_inconsistent', detail: allocation }
  }

  const now = await databaseNow(tx)
  const attemptId = newId('payoutAttempt')
  const idempotencyKey = payoutIdempotencyKey(input.settlementId, allocation.attemptNumber)

  // (c) cross, and (d) create the durable key, and (e) the event — all through
  // the one writer, so the pairing rule holds here too.
  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'dispatch_payout',
    actor: input.actor,
    guards: {
      rail_selected: input.railSelected,
      destination_version_verified: frozenVersion !== undefined,
      no_cancellation_pending: true,
      before_point_of_no_return: true,
    },
    patch: { pointOfNoReturnAt: now, payoutAttemptId: attemptId },
    statusEventPayload: { payout_attempt_id: attemptId },
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }

  await tx.insert(schema.payoutAttempts).values({
    id: attemptId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    settlementId: input.settlementId,
    destinationVersionId: current.destination_version_id,
    attemptNumber: allocation.attemptNumber,
    idempotencyKey,
    dispatchedBy: input.actor.id,
    // Stage 5. The rail and its SLA are recorded *as dispatched*, because the
    // provider may change what it declares and an attempt should be judged
    // against the SLA it actually went out under.
    ...(input.rail ? { rail: input.rail } : {}),
    ...(input.slaSeconds !== undefined ? { slaSeconds: input.slaSeconds } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.fundingAmountMinor !== undefined
      ? { amountMinor: input.fundingAmountMinor, amountCurrency: 'INR' }
      : {}),
  })

  // (f) the outbox job that will call the provider *after* commit is Stage 5's.
  // Stage 3 deliberately enqueues nothing: there is no task to run yet, and
  // registering one would be implementing Stage 5 early.

  return {
    ok: true,
    payoutAttemptId: attemptId,
    attemptNumber: allocation.attemptNumber,
    idempotencyKey,
    pointOfNoReturnAt: now,
    reused: false,
  }
}

/* ── Exceptions (T11, T14, T17, T18, T21, T28, T29, T30 → T22/T23/T24) ─── */

export async function openException(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; trigger: 'reservation_failed' | 'drawdown_failed' | 'payout_rejected' | 'payout_timeout' | 'reconciled_mismatch' | 'reservation_expired' | 'drawdown_timeout' | 'reconciliation_stalled'; code: ExceptionCode; actor: PrincipalRef; guards: Record<string, boolean> },
): Promise<TransitionOutcome> {
  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }

  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: input.trigger,
    actor: input.actor,
    guards: input.guards,
    exceptionCode: input.code,
    companions:
      input.trigger === 'drawdown_failed'
        ? [{ type: 'facility.reservation_released', subjectType: 'settlement', subjectId: input.settlementId }]
        : input.trigger === 'reservation_expired'
          ? [{ type: 'facility.reservation_expired', subjectType: 'settlement', subjectId: input.settlementId }]
          : input.trigger === 'reconciled_mismatch'
            ? [{ type: 'settlement.reconciled', subjectType: 'settlement', subjectId: input.settlementId }]
            : [],
  })
  if (!outcome.ok) return outcome

  await tx.insert(schema.settlementExceptions).values({
    id: newId('settlementException'),
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    settlementId: input.settlementId,
    code: input.code,
    enteredFrom: settlement.status,
  })
  return outcome
}

export async function resolveException(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    resolution: 'resume' | 'fail' | 'cancel'
    actor: PrincipalRef
    reason: string
    facilityCompensation?: 'release' | 'repayment'
  },
): Promise<TransitionOutcome> {
  const settlement = await getSettlement(tx, input.settlementId)
  if (!settlement) return { ok: false, reason: 'settlement_not_found' }

  const trigger = (
    { resume: 'resolve_resume', fail: 'resolve_fail', cancel: 'resolve_cancel' } as const
  )[input.resolution]

  const companions =
    input.resolution === 'resume'
      ? []
      : [
          {
            type:
              (input.facilityCompensation ?? 'release') === 'repayment'
                ? ('facility.repayment_requested' as const)
                : ('facility.reservation_released' as const),
            subjectType: 'settlement',
            subjectId: input.settlementId,
          },
        ]

  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger,
    actor: input.actor,
    guards: {
      resolution_attributed: input.reason.trim().length > 0,
      /*
       * Was vacuous until Stage 9: the expression here read
       * `… ? true : true`, a ternary whose branches agree, so T23's
       * `no_value_delivered` guard answered yes for every settlement including
       * one whose payout had already been dispatched. That is the one thing
       * this guard exists to prevent — calling a settlement `FAILED` tells the
       * customer no money moved, and past the point of no return we do not
       * know that.
       *
       * A settlement whose attempt crossed the boundary may have delivered
       * value even if we never saw the confirmation; `PAYOUT_STATUS_UNKNOWN` is
       * exactly that situation. So the honest answer is no, and the caller is
       * left with `resume`, which means: go and find out.
       */
      no_value_delivered: settlement.pointOfNoReturnAt === null,
      before_point_of_no_return: settlement.pointOfNoReturnAt === null,
    },
    companions,
    reason: input.reason,
  })
  if (!outcome.ok) return outcome

  await tx
    .update(schema.settlementExceptions)
    .set({ resolvedAt: await databaseNow(tx), resolvedBy: input.actor.id, resolutionReason: input.reason })
    .where(
      and(
        eq(schema.settlementExceptions.settlementId, input.settlementId),
        sql`${schema.settlementExceptions.resolvedAt} IS NULL`,
      ),
    )
  return outcome
}

/** Rehydrate the recipient amount as `Money`. */
export function recipientAmountOf(row: SettlementRow): Money {
  return money(row.recipientAmountCurrency as CurrencyCode, row.recipientAmountMinor)
}

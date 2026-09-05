/**
 * Payout execution — Stage 5. `INV-24`, `INV-25`, `INV-33`, `INV-36`, `INV-43`.
 *
 * The one structural rule, from `INV-36(b)`: **no outbound call happens inside
 * the dispatch transaction.** Stage 3 built that transaction — it crosses the
 * point of no return, writes the durable attempt with its idempotency key, and
 * commits. This file is everything that happens *after* that commit, and it can
 * fail freely, because the durable record already exists and recovery is a
 * status pull rather than a retry.
 *
 * That separation is why `submitDispatchedPayout` takes a `Db` pool rather than
 * a transaction. Handing it a transaction would let a caller wrap a network
 * call in a row lock, which is the thing the invariant forbids, and a type
 * error is a better place to learn that than an incident.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  PayoutTimeout,
  interpretProviderCode,
  isWellFormedUtr,
  payoutIdempotencyKey,
  selectRail,
  type ExceptionCode,
  type PayoutProvider,
  type PayoutRail,
  type PrincipalRef,
  type ProviderMappingTable,
  type ProviderOutcome,
  type TenantScope,
} from '@inrsettle/domain'
import { applyTransition } from './settlement-transition.service.js'
import { eventSink } from './events.js'
import { databaseNow } from './quote.service.js'

export type PayoutResult =
  | {
      ok: true
      attemptNumber: number
      status: string
      providerReference?: string
      utr?: string
      /** What the rail said it credited, where it said anything at all. */
      creditedMinor?: bigint
      /**
       * The attempt was resolved but the *settlement* was not moved, because it
       * sits in `EXCEPTION` and the only way out of that is T22/T23 with an
       * attributed resolution. A status pull answers what the provider did; it
       * does not decide what an operator should do about it.
       */
      settlementAwaitingResolution?: boolean
    }
  | { ok: false; reason: string; detail?: unknown }

interface AttemptRow {
  id: string
  settlement_id: string
  attempt_number: number
  status: 'SUBMITTED' | 'ACCEPTED' | 'CREDITED' | 'REJECTED' | 'RETURNED' | 'UNKNOWN'
  idempotency_key: string
  destination_version_id: string
  amount_minor: string | number | bigint | null
  amount_currency: string | null
  rail: PayoutRail | null
  sla_seconds: number | null
  dispatched_at: Date
}

async function readAttempt(tx: Db, settlementId: string): Promise<AttemptRow | null> {
  const rows = (await tx.execute(sql`
    SELECT id, settlement_id, attempt_number, status, idempotency_key, destination_version_id,
           amount_minor, amount_currency, rail, sla_seconds, dispatched_at
    FROM payout_attempts
    WHERE settlement_id = ${settlementId}
    ORDER BY attempt_number DESC LIMIT 1`)) as unknown as AttemptRow[]
  return rows[0] ?? null
}

/* ── Rail selection at dispatch ─────────────────────────────────────────── */

/**
 * Choose the rail for a settlement from what the provider declares.
 *
 * Called inside the dispatch transaction, because T15's guard is
 * `rail_selected` and a dispatch with no rail has nothing to submit. It reads
 * the provider's declared capabilities rather than a table of Indian banking
 * rules — `D-13` is open, and the capabilities are how a partner's real answer
 * arrives without a code change.
 */
export async function chooseRail(
  provider: PayoutProvider,
  input: { destinationKind: 'bank_account' | 'vpa'; amountMinor: bigint },
): Promise<
  | { ok: true; rail: PayoutRail; slaSeconds: number }
  | { ok: false; reason: string; considered: readonly PayoutRail[] }
> {
  const capabilities = await provider.capabilities()
  const selection = selectRail({
    capabilities,
    destinationKind: input.destinationKind,
    amountMinor: input.amountMinor,
  })
  if (!selection.ok) return { ok: false, reason: selection.reason, considered: selection.considered }

  const declared = capabilities.rails.find((r) => r.rail === selection.rail)!
  return { ok: true, rail: selection.rail, slaSeconds: declared.terminalStatusSlaSeconds }
}

/* ── The outbound call (after the dispatch commit) ──────────────────────── */

export interface DestinationResolver {
  /** Resolves the *frozen* destination version by id, decrypted for the call. */
  (destinationVersionId: string): Promise<{
    kind: 'bank_account' | 'vpa'
    accountNumber?: string
    ifsc?: string
    vpa?: string
    accountHolderName: string
  } | null>
}

/**
 * Call the provider for an attempt that has already been dispatched.
 *
 * Runs after commit, as a job would. Three outcomes, and the third is the one
 * that matters:
 *
 * - a terminal answer (credited or rejected) is recorded and applied;
 * - a non-terminal acknowledgement is recorded and the SLA clock runs;
 * - **no answer at all** leaves the attempt exactly as it was. Not failed, not
 *   retried — a timed-out submission may have created a real payout in India,
 *   and `INV-36(c)` says so directly: *"A connection reset, a timeout, a 5xx,
 *   or a worker crash between commit and call all resolve through the
 *   authoritative status pull, never through cancellation, and never by a
 *   second dispatch transaction."*
 */
export async function submitDispatchedPayout(
  db: Db,
  scope: TenantScope,
  provider: PayoutProvider,
  resolveDestination: DestinationResolver,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<PayoutResult> {
  const attempt = await withTenant(db, scope, (tx) => readAttempt(tx, input.settlementId))
  if (!attempt) return { ok: false, reason: 'attempt_not_found' }
  if (attempt.status !== 'SUBMITTED') {
    // Already answered, already unknown, or already terminal. Submitting again
    // would present the same key — safe at a correct provider, but pointless
    // here and misleading in the audit trail.
    return { ok: false, reason: 'attempt_not_awaiting_submission', detail: { status: attempt.status } }
  }

  const destination = await resolveDestination(attempt.destination_version_id)
  if (!destination) return { ok: false, reason: 'destination_version_not_found' }

  // The key is derived, not read, so a corrupted column cannot change what we
  // present to the provider (`INV-25`).
  const idempotencyKey = payoutIdempotencyKey(attempt.settlement_id, attempt.attempt_number)

  let ack
  try {
    ack = await provider.submitPayout({
      settlementId: attempt.settlement_id,
      attemptNumber: attempt.attempt_number,
      idempotencyKey,
      rail: attempt.rail ?? 'NEFT',
      amountMinor: BigInt(attempt.amount_minor ?? 0n),
      currency: 'INR',
      destination: { destinationVersionId: attempt.destination_version_id, ...destination },
    })
  } catch (error) {
    if (error instanceof PayoutTimeout) {
      // Deliberately *no* state change. The attempt stays SUBMITTED and the SLA
      // sweeper will take it to UNKNOWN, from where the only move is a pull.
      await withTenant(db, scope, async (tx) => {
        await eventSink(tx).audit(scope, {
          actor: input.actor,
          action: 'payout.submit_timeout',
          subjectType: 'settlement',
          subjectId: attempt.settlement_id,
          after: { attempt_number: attempt.attempt_number, idempotency_key: idempotencyKey },
          reason: 'provider did not answer; status is unknown, not failed',
        })
      })
      return { ok: false, reason: 'provider_timeout', detail: { idempotencyKey } }
    }
    throw error
  }

  await withTenant(db, scope, async (tx) => {
    const now = await databaseNow(tx)
    await tx
      .update(schema.payoutAttempts)
      .set({
        providerReference: ack.providerReference,
        submittedAt: now,
        ...(ack.status === 'ACCEPTED' ? { status: 'ACCEPTED' as const } : {}),
        ...(ack.rawCode ? { rawCode: ack.rawCode } : {}),
      })
      .where(eq(schema.payoutAttempts.id, attempt.id))
  })

  return {
    ok: true,
    attemptNumber: attempt.attempt_number,
    status: ack.status,
    providerReference: ack.providerReference,
    ...(ack.utr ? { utr: ack.utr } : {}),
    ...(ack.creditedMinor === undefined ? {} : { creditedMinor: ack.creditedMinor }),
  }
}

/* ── Applying a provider outcome to the machine ─────────────────────────── */

export interface PayoutOutcomeInput {
  readonly settlementId: string
  readonly outcome: ProviderOutcome
  readonly actor: PrincipalRef
  /** True only when the transport authenticated the evidence. Never defaulted. */
  readonly trusted: boolean
  readonly utr?: string | undefined
  readonly rawCode?: string | undefined
  readonly exceptionCode?: ExceptionCode | undefined
  readonly providerReference?: string | undefined
  readonly mappingVersion?: string | undefined
  /**
   * What the rail says actually reached the beneficiary.
   *
   * Recorded, never checked against the instructed amount. A mismatch is a
   * reconciliation finding (`INV-26`), and refusing the credit here would be
   * worse than useless: the money has already moved, and a payout the system
   * declines to write down is a payout nobody can reconcile. Omitted where the
   * provider stated no figure — which is not the same as stating the full one.
   */
  readonly creditedMinor?: bigint | undefined
}

/**
 * Move the payout attempt and the settlement on one provider outcome.
 *
 * Idempotent by design: an outcome that has already been applied returns
 * `idempotent: true` and changes nothing. The frozen § 10 test requires *"every
 * provider callback replayed ten times produces one state change and one status
 * event"*, and redelivery is normal rather than exceptional — a provider that
 * never redelivered would be a provider that loses events.
 */
export async function applyPayoutOutcome(
  tx: Db,
  scope: TenantScope,
  input: PayoutOutcomeInput,
): Promise<PayoutResult & { idempotent?: boolean }> {
  // Untrusted evidence never moves the machine. It is stored and alarmed by the
  // ingestion path above this one; here it is simply refused.
  if (!input.trusted) return { ok: false, reason: 'untrusted_evidence' }

  const rows = (await tx.execute(sql`
    SELECT id, settlement_id, attempt_number, status, idempotency_key, destination_version_id,
           amount_minor, amount_currency, rail, sla_seconds, dispatched_at
    FROM payout_attempts WHERE settlement_id = ${input.settlementId}
    ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`)) as unknown as AttemptRow[]
  const attempt = rows[0]
  if (!attempt) return { ok: false, reason: 'attempt_not_found' }

  const now = await databaseNow(tx)

  // Where the settlement is decides whether a provider outcome may move it.
  // From PAYOUT_SUBMITTED, T16/T17 apply. From EXCEPTION — which is where T18
  // put it — nothing here may move it: leaving an exception is T22 or T23, and
  // both require an attributed human decision. The attempt is still updated,
  // because what the provider did is a fact regardless of who has looked at it.
  const settlementRows = (await tx.execute(sql`
    SELECT status FROM settlements WHERE id = ${input.settlementId}`)) as unknown as
    { status: string }[]
  const settlementStatus = settlementRows[0]?.status ?? null
  const inException = settlementStatus === 'EXCEPTION'

  if (input.outcome === 'credited') {
    // T16's frozen guard: "UTR present and well-formed". Checked here, before
    // anything moves, because the UTR is the customer's evidence that a payment
    // happened — a malformed one looks like proof and is not.
    if (!isWellFormedUtr(input.utr)) {
      return { ok: false, reason: 'utr_missing_or_malformed', detail: { utr: input.utr ?? null } }
    }
    if (attempt.status === 'CREDITED') {
      return { ok: true, attemptNumber: attempt.attempt_number, status: 'CREDITED', idempotent: true }
    }
    if (attempt.status !== 'SUBMITTED' && attempt.status !== 'ACCEPTED' && attempt.status !== 'UNKNOWN') {
      return { ok: false, reason: 'invalid_attempt_transition', detail: { from: attempt.status } }
    }

    await tx
      .update(schema.payoutAttempts)
      .set({
        status: 'CREDITED',
        utr: input.utr,
        creditedAt: now,
        resolvedAt: now,
        ...(input.creditedMinor === undefined ? {} : { creditedMinor: input.creditedMinor }),
        ...(input.providerReference ? { providerReference: input.providerReference } : {}),
        ...(input.rawCode ? { rawCode: input.rawCode } : {}),
        ...(input.mappingVersion ? { mappingVersion: input.mappingVersion } : {}),
      })
      .where(eq(schema.payoutAttempts.id, attempt.id))

    if (inException) {
      return {
        ok: true,
        attemptNumber: attempt.attempt_number,
        status: 'CREDITED',
        utr: input.utr,
        settlementAwaitingResolution: true,
      }
    }

    const outcome = await applyTransition(tx, scope, {
      settlementId: input.settlementId,
      trigger: 'payout_credited',
      actor: input.actor,
      guards: { trusted_provider_event: true, utr_present_and_well_formed: true },
      statusEventPayload: { utr: input.utr, attempt_number: attempt.attempt_number },
    })
    if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }
    return {
      ok: true,
      attemptNumber: attempt.attempt_number,
      status: 'CREDITED',
      utr: input.utr,
      ...(input.creditedMinor === undefined ? {} : { creditedMinor: input.creditedMinor }),
    }
  }

  if (input.outcome === 'rejected') {
    if (attempt.status === 'REJECTED') {
      return { ok: true, attemptNumber: attempt.attempt_number, status: 'REJECTED', idempotent: true }
    }
    if (attempt.status !== 'SUBMITTED' && attempt.status !== 'ACCEPTED' && attempt.status !== 'UNKNOWN') {
      return { ok: false, reason: 'invalid_attempt_transition', detail: { from: attempt.status } }
    }

    await tx
      .update(schema.payoutAttempts)
      .set({
        status: 'REJECTED',
        resolvedAt: now,
        ...(input.providerReference ? { providerReference: input.providerReference } : {}),
        ...(input.rawCode ? { rawCode: input.rawCode } : {}),
        ...(input.mappingVersion ? { mappingVersion: input.mappingVersion } : {}),
      })
      .where(eq(schema.payoutAttempts.id, attempt.id))

    if (inException) {
      return {
        ok: true,
        attemptNumber: attempt.attempt_number,
        status: 'REJECTED',
        settlementAwaitingResolution: true,
      }
    }

    const outcome = await applyTransition(tx, scope, {
      settlementId: input.settlementId,
      trigger: 'payout_rejected',
      actor: input.actor,
      guards: { trusted_provider_event: true },
      // Never invented: either the mapping table supplied it, or the caller
      // passed the INV-43 safe default. There is no third source.
      exceptionCode: input.exceptionCode ?? 'PAYOUT_REJECTED_PROVIDER',
      statusEventPayload: { attempt_number: attempt.attempt_number, raw_code: input.rawCode ?? null },
    })
    if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }
    return { ok: true, attemptNumber: attempt.attempt_number, status: 'REJECTED' }
  }

  if (input.outcome === 'accepted') {
    if (attempt.status === 'SUBMITTED') {
      await tx
        .update(schema.payoutAttempts)
        .set({
          status: 'ACCEPTED',
          ...(input.providerReference ? { providerReference: input.providerReference } : {}),
        })
        .where(eq(schema.payoutAttempts.id, attempt.id))
      return { ok: true, attemptNumber: attempt.attempt_number, status: 'ACCEPTED' }
    }
    // An acknowledgement arriving after a terminal answer is stale, not wrong.
    return { ok: true, attemptNumber: attempt.attempt_number, status: attempt.status, idempotent: true }
  }

  if (input.outcome === 'returned') {
    // P08. A fact about the rails-level execution that does **not** propagate
    // to the settlement's status — the settlement was settled and remains so.
    // The `SettlementReturn` aggregate this opens is Stage 6; Stage 5 records
    // the attempt-level fact and stops there.
    if (attempt.status !== 'CREDITED' && attempt.status !== 'RETURNED') {
      return { ok: false, reason: 'return_requires_credit', detail: { from: attempt.status } }
    }
    if (attempt.status === 'RETURNED') {
      return { ok: true, attemptNumber: attempt.attempt_number, status: 'RETURNED', idempotent: true }
    }
    await tx
      .update(schema.payoutAttempts)
      .set({ status: 'RETURNED', returnedAt: now, ...(input.rawCode ? { rawCode: input.rawCode } : {}) })
      .where(eq(schema.payoutAttempts.id, attempt.id))
    return { ok: true, attemptNumber: attempt.attempt_number, status: 'RETURNED' }
  }

  // `unknown` is not applied here. It is reached by the SLA sweeper below, or
  // it is what a pull is *for*; treating an inbound "we do not know" as a state
  // change would let a provider's silence move our machine.
  return { ok: false, reason: 'unknown_outcome_is_not_applied' }
}

/* ── T18 — the SLA sweeper ──────────────────────────────────────────────── */

/**
 * Take an in-flight attempt past its declared SLA to `UNKNOWN`.
 *
 * T18's frozen guard says *"Never auto-retry"*, and this is the function that
 * has to mean it. It moves the attempt to `UNKNOWN` and opens
 * `PAYOUT_STATUS_UNKNOWN`; it does not submit anything, and there is no code
 * path from here to `submitDispatchedPayout`.
 */
export async function sweepPayoutSla(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<PayoutResult> {
  const rows = (await tx.execute(sql`
    SELECT id, settlement_id, attempt_number, status, idempotency_key, destination_version_id,
           amount_minor, amount_currency, rail, sla_seconds, dispatched_at
    FROM payout_attempts WHERE settlement_id = ${input.settlementId}
    ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`)) as unknown as AttemptRow[]
  const attempt = rows[0]
  if (!attempt) return { ok: false, reason: 'attempt_not_found' }
  if (attempt.status !== 'SUBMITTED' && attempt.status !== 'ACCEPTED') {
    return { ok: false, reason: 'attempt_not_in_flight', detail: { status: attempt.status } }
  }

  const now = await databaseNow(tx)
  const elapsedSeconds = (now.getTime() - new Date(attempt.dispatched_at).getTime()) / 1000
  if (elapsedSeconds < (attempt.sla_seconds ?? Number.POSITIVE_INFINITY)) {
    return { ok: false, reason: 'sla_not_elapsed', detail: { elapsedSeconds } }
  }

  await tx
    .update(schema.payoutAttempts)
    .set({ status: 'UNKNOWN' })
    .where(and(eq(schema.payoutAttempts.id, attempt.id), eq(schema.payoutAttempts.status, attempt.status)))

  const outcome = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'payout_timeout',
    actor: input.actor,
    guards: { rail_sla_elapsed: true },
    exceptionCode: 'PAYOUT_STATUS_UNKNOWN',
    statusEventPayload: { attempt_number: attempt.attempt_number },
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome }
  return { ok: true, attemptNumber: attempt.attempt_number, status: 'UNKNOWN' }
}

/* ── The authoritative status pull ──────────────────────────────────────── */

/**
 * Resolve an `UNKNOWN` attempt by asking the provider — `INV-24`.
 *
 * > *"Retry after `UNKNOWN` requires a completed status reconciliation against
 * > the provider, never a blind resubmit."*
 *
 * The pull presents the attempt's own idempotency key, so it asks about exactly
 * the submission we made rather than about the settlement in general. Three
 * answers, and each has one correct consequence:
 *
 * - **credited** — the payout happened; apply it, and the earlier silence was
 *   only ever a communication failure.
 * - **rejected** — it did not happen; apply the rejection, and a further
 *   attempt becomes allocatable.
 * - **not_found** — the provider never received it. Also a rejection, and the
 *   safest of the three, because it is the only one that says with authority
 *   that no money moved.
 */
export async function pullPayoutStatus(
  db: Db,
  scope: TenantScope,
  provider: PayoutProvider,
  mapping: ProviderMappingTable,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<PayoutResult & { resolvedBy?: 'pull' }> {
  const attempt = await withTenant(db, scope, (tx) => readAttempt(tx, input.settlementId))
  if (!attempt) return { ok: false, reason: 'attempt_not_found' }

  const idempotencyKey = payoutIdempotencyKey(attempt.settlement_id, attempt.attempt_number)
  const answer = await provider.getPayout(idempotencyKey)
  if (!answer.ok) return { ok: false, reason: 'pull_failed', detail: answer.error }

  if (answer.status === 'not_found') {
    // Authoritative: the provider has no record, so no money moved.
    return withTenant(db, scope, async (tx) => {
      const applied = await applyPayoutOutcome(tx, scope, {
        settlementId: input.settlementId,
        outcome: 'rejected',
        actor: input.actor,
        trusted: true,
        rawCode: 'PULL_NOT_FOUND',
        exceptionCode: 'PAYOUT_REJECTED_PROVIDER',
        mappingVersion: mapping.version,
      })
      return { ...applied, resolvedBy: 'pull' as const }
    })
  }

  if (answer.status === 'SUBMITTED' || answer.status === 'ACCEPTED') {
    // Still in flight. Not an error, and emphatically not a reason to resubmit.
    return { ok: false, reason: 'still_in_flight', detail: { status: answer.status } }
  }

  const outcome: ProviderOutcome =
    answer.status === 'CREDITED' ? 'credited' : answer.status === 'RETURNED' ? 'returned' : 'rejected'
  const interpretation = answer.rawCode
    ? interpretProviderCode(mapping, answer.rawCode, outcome)
    : { mapped: true as const, outcome, mappingVersion: mapping.version }

  return withTenant(db, scope, async (tx) => {
    const applied = await applyPayoutOutcome(tx, scope, {
      settlementId: input.settlementId,
      outcome,
      actor: input.actor,
      trusted: true,
      utr: answer.utr,
      creditedMinor: answer.creditedMinor,
      rawCode: answer.rawCode,
      providerReference: answer.providerReference,
      exceptionCode: 'exceptionCode' in interpretation ? interpretation.exceptionCode : undefined,
      mappingVersion: interpretation.mappingVersion,
    })
    return { ...applied, resolvedBy: 'pull' as const }
  })
}

/* ── Retry — the thing Stage 3 deliberately deferred ────────────────────── */

/**
 * Allocate a further payout attempt after an authoritative rejection.
 *
 * Stage 3 built the identity model and then refused to use it, because *"the
 * retry policy depends on what the provider said, which is Stage 5's
 * knowledge."* This is Stage 5 supplying that knowledge, and the knowledge is
 * narrow: a retry is permitted only from an attempt the provider has
 * definitively rejected. `UNKNOWN` is not a rejection — it is the absence of an
 * answer — and `allocateAttemptNumber` refuses it at the domain, the partial
 * unique index refuses it at the database, and this function never asks.
 */
export async function retryPayout(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    actor: PrincipalRef
    rail: PayoutRail
    slaSeconds: number
    providerId: string
    reason: string
  },
): Promise<PayoutResult & { idempotencyKey?: string }> {
  const rows = (await tx.execute(sql`
    SELECT id, settlement_id, attempt_number, status, idempotency_key, destination_version_id,
           amount_minor, amount_currency, rail, sla_seconds, dispatched_at
    FROM payout_attempts WHERE settlement_id = ${input.settlementId}
    ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`)) as unknown as AttemptRow[]
  const previous = rows[0]
  if (!previous) return { ok: false, reason: 'attempt_not_found' }

  if (previous.status !== 'REJECTED') {
    return {
      ok: false,
      reason: 'retry_requires_authoritative_rejection',
      detail: { status: previous.status },
    }
  }

  const attemptNumber = previous.attempt_number + 1
  const idempotencyKey = payoutIdempotencyKey(input.settlementId, attemptNumber)
  const attemptId = newId('payoutAttempt')
  const now = await databaseNow(tx)

  await tx.insert(schema.payoutAttempts).values({
    id: attemptId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    settlementId: input.settlementId,
    destinationVersionId: previous.destination_version_id,
    attemptNumber,
    idempotencyKey,
    status: 'SUBMITTED',
    dispatchedBy: input.actor.id,
    dispatchedAt: now,
    providerId: input.providerId,
    rail: input.rail,
    amountMinor: previous.amount_minor === null ? null : BigInt(previous.amount_minor),
    amountCurrency: previous.amount_currency,
    slaSeconds: input.slaSeconds,
  })

  const events = eventSink(tx)
  await events.audit(scope, {
    actor: input.actor,
    action: 'payout.retry_allocated',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    before: { attempt_number: previous.attempt_number, status: previous.status },
    after: { attempt_number: attemptNumber, idempotency_key: idempotencyKey },
    reason: input.reason,
  })

  return { ok: true, attemptNumber, status: 'SUBMITTED', idempotencyKey }
}

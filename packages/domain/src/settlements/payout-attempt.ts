/**
 * Payout attempts — `DOMAIN.md § 6.7`, `STATE_MACHINES.md § 6.3`.
 *
 * `INV-24` — a settlement may have **several** attempts over its life, but at
 * most one that is not in a terminal state.
 *
 * `INV-25` — every submission carries a stable idempotency key derived from
 * `settlement_id + attempt_number`.
 *
 * The second invariant is the reason this file exists as its own model. An
 * earlier revision derived the key from `settlement_id + authorized_terms_hash`,
 * which is **constant for the life of a settlement**: two legitimate attempts
 * would have presented the same key, and a provider honouring idempotency would
 * have silently returned the first attempt's result for the second. That is a
 * payout that looks sent and never was.
 *
 * The inverse mistake is just as bad. Deriving the key from the terms hash also
 * means a *change* to the terms would mint a new key — so editing an
 * instruction would become a way to conjure a second real payout. `INV-16`
 * freezes the terms precisely so that cannot happen, and the key must not
 * reintroduce it through the back door. The attempt number is the only thing
 * that advances a payout identity, and it advances under `INV-24`'s rules.
 */

/* ── Status ────────────────────────────────────────────────────────────── */

export const PAYOUT_ATTEMPT_STATUSES = [
  'SUBMITTED',
  'ACCEPTED',
  'CREDITED',
  'REJECTED',
  'RETURNED',
  'UNKNOWN',
] as const

export type PayoutAttemptStatus = (typeof PAYOUT_ATTEMPT_STATUSES)[number]

/**
 * Terminal for the purposes of `INV-24`: the attempt has an authoritative
 * answer and is no longer in flight.
 *
 * `UNKNOWN` is deliberately **not** terminal. It is the state that means "we do
 * not know whether money moved", and treating it as finished is exactly the
 * mistake that produces a double payment — which is why `INV-24` requires a
 * completed status reconciliation before another attempt, never a blind
 * resubmit.
 */
export const TERMINAL_PAYOUT_ATTEMPT_STATUSES = ['CREDITED', 'REJECTED', 'RETURNED'] as const
export type TerminalPayoutAttemptStatus = (typeof TERMINAL_PAYOUT_ATTEMPT_STATUSES)[number]

export function isPayoutAttemptTerminal(status: PayoutAttemptStatus): boolean {
  return (TERMINAL_PAYOUT_ATTEMPT_STATUSES as readonly string[]).includes(status)
}

/** `SUBMITTED`, `ACCEPTED`, `UNKNOWN` — an attempt that may still be live. */
export function isPayoutAttemptInFlight(status: PayoutAttemptStatus): boolean {
  return !isPayoutAttemptTerminal(status)
}

/* ── The frozen P01–P08 table ──────────────────────────────────────────── */

export const PAYOUT_TRIGGERS = [
  'dispatch',
  'accepted',
  'credited',
  'rejected',
  'sla_elapsed',
  'pull_resolved_credited',
  'pull_resolved_rejected',
  'returned',
] as const
export type PayoutTrigger = (typeof PAYOUT_TRIGGERS)[number]

export const PAYOUT_TRANSITION_IDS = ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08'] as const
export type PayoutTransitionId = (typeof PAYOUT_TRANSITION_IDS)[number]

export interface PayoutTransition {
  readonly id: PayoutTransitionId
  readonly from: readonly PayoutAttemptStatus[]
  readonly trigger: PayoutTrigger
  readonly to: PayoutAttemptStatus
  readonly note: string
}

export const PAYOUT_TRANSITIONS: readonly PayoutTransition[] = [
  {
    id: 'P01',
    from: [],
    trigger: 'dispatch',
    to: 'SUBMITTED',
    note: 'Created inside the dispatch transaction (INV-36).',
  },
  { id: 'P02', from: ['SUBMITTED'], trigger: 'accepted', to: 'ACCEPTED', note: 'Trusted acknowledgement.' },
  {
    id: 'P03',
    from: ['SUBMITTED', 'ACCEPTED'],
    trigger: 'credited',
    to: 'CREDITED',
    note: 'Trusted event with a well-formed UTR.',
  },
  {
    id: 'P04',
    from: ['SUBMITTED', 'ACCEPTED'],
    trigger: 'rejected',
    to: 'REJECTED',
    note: 'Trusted rejection.',
  },
  {
    id: 'P05',
    from: ['SUBMITTED', 'ACCEPTED'],
    trigger: 'sla_elapsed',
    to: 'UNKNOWN',
    note: 'No terminal status within the rail SLA — payout status poller.',
  },
  {
    id: 'P06',
    from: ['UNKNOWN'],
    trigger: 'pull_resolved_credited',
    to: 'CREDITED',
    note: 'Authoritative status pull only, never a resubmit (INV-24).',
  },
  {
    id: 'P07',
    from: ['UNKNOWN'],
    trigger: 'pull_resolved_rejected',
    to: 'REJECTED',
    note: 'Authoritative status pull only.',
  },
  {
    id: 'P08',
    from: ['CREDITED'],
    trigger: 'returned',
    to: 'RETURNED',
    note: 'A confirmed SettlementReturn covering the full delivered amount.',
  },
]

export type PayoutTransitionResult =
  | { readonly ok: true; readonly id: PayoutTransitionId; readonly to: PayoutAttemptStatus }
  | { readonly ok: false; readonly error: 'invalid_transition' }

export function evaluatePayoutTransition(
  from: PayoutAttemptStatus | null,
  trigger: PayoutTrigger,
): PayoutTransitionResult {
  const found = PAYOUT_TRANSITIONS.find(
    (t) => t.trigger === trigger && (from === null ? t.from.length === 0 : t.from.includes(from)),
  )
  return found ? { ok: true, id: found.id, to: found.to } : { ok: false, error: 'invalid_transition' }
}

/* ── Idempotency identity (INV-25) ─────────────────────────────────────── */

export const PAYOUT_IDEMPOTENCY_VERSION = 'v1'

/**
 * The key presented to a payout provider.
 *
 * Derived from **exactly** the settlement id and the attempt number, and
 * nothing else. Deliberately readable rather than hashed: during an incident,
 * someone comparing our records against a provider's dashboard should be able
 * to read the key and know which attempt it names. There is no secret here to
 * protect — the key's job is to be the same string twice, not to be opaque.
 *
 * Because the terms hash is absent, re-freezing an instruction cannot mint a
 * new key, and because the attempt number is present, a legitimate second
 * attempt cannot collide with the first.
 */
export function payoutIdempotencyKey(settlementId: string, attemptNumber: number): string {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new RangeError(`attempt number must be a positive integer, got ${attemptNumber}`)
  }
  return `payout:${PAYOUT_IDEMPOTENCY_VERSION}:${settlementId}:${attemptNumber}`
}

/* ── Allocating the next attempt (INV-24) ──────────────────────────────── */

export interface AttemptSummary {
  readonly attemptNumber: number
  readonly status: PayoutAttemptStatus
}

export type AttemptAllocation =
  /** No attempt exists yet; this is the dispatch that creates attempt 1. */
  | { readonly ok: true; readonly attemptNumber: 1; readonly reason: 'first_attempt' }
  /** An in-flight attempt exists; a retry reuses its number and its key. */
  | { readonly ok: true; readonly attemptNumber: number; readonly reason: 'reuse_in_flight' }
  /** The previous attempt is authoritatively finished and permits another. */
  | { readonly ok: true; readonly attemptNumber: number; readonly reason: 'next_attempt' }
  | { readonly ok: false; readonly reason: 'in_flight_attempt_exists'; readonly attemptNumber: number }
  | { readonly ok: false; readonly reason: 'status_unknown'; readonly attemptNumber: number }
  | { readonly ok: false; readonly reason: 'already_credited'; readonly attemptNumber: number }
  | { readonly ok: false; readonly reason: 'returned_needs_replacement'; readonly attemptNumber: number }

/**
 * Whether a terminal attempt permits the settlement to try again.
 *
 * `REJECTED` does; the rail refused and nothing moved. `CREDITED` does not —
 * money reached the beneficiary, and a second attempt would pay twice.
 * `RETURNED` does not either: a credited-then-returned payout is handled by a
 * replacement settlement (`STATE_MACHINES.md § 7.1`), because the original
 * instruction is frozen and cannot be re-aimed.
 *
 * Note what this does *not* decide: whether a retry is the right *policy* after
 * a rejection. That belongs to Stage 5, which knows what the provider said.
 * Stage 3 only rules out the attempts that would be unsafe at any policy.
 */
export function terminalAttemptPermitsAnother(status: TerminalPayoutAttemptStatus): boolean {
  return status === 'REJECTED'
}

/**
 * Decide which attempt number a dispatch should use.
 *
 * `attempts` is every attempt on the settlement. Pure: the caller reads them
 * under the settlement row lock and this function makes the decision, so the
 * rule is testable without a database and identical wherever it is applied.
 */
export function allocateAttemptNumber(attempts: readonly AttemptSummary[]): AttemptAllocation {
  if (attempts.length === 0) return { ok: true, attemptNumber: 1, reason: 'first_attempt' }

  const inFlight = attempts.filter((a) => isPayoutAttemptInFlight(a.status))
  if (inFlight.length > 0) {
    // At most one, by INV-24 and by the partial unique index that enforces it.
    const attempt = inFlight.reduce((a, b) => (a.attemptNumber >= b.attemptNumber ? a : b))
    return attempt.status === 'UNKNOWN'
      ? // The critical refusal. UNKNOWN means we do not know whether money
        // moved; allocating attempt 2 here is how a double payment happens.
        { ok: false, reason: 'status_unknown', attemptNumber: attempt.attemptNumber }
      : // A retry of the *same* submission: same number, same key.
        { ok: true, attemptNumber: attempt.attemptNumber, reason: 'reuse_in_flight' }
  }

  const latest = attempts.reduce((a, b) => (a.attemptNumber >= b.attemptNumber ? a : b))
  const status = latest.status as TerminalPayoutAttemptStatus
  if (status === 'CREDITED') return { ok: false, reason: 'already_credited', attemptNumber: latest.attemptNumber }
  if (status === 'RETURNED') {
    return { ok: false, reason: 'returned_needs_replacement', attemptNumber: latest.attemptNumber }
  }
  if (!terminalAttemptPermitsAnother(status)) {
    return { ok: false, reason: 'in_flight_attempt_exists', attemptNumber: latest.attemptNumber }
  }
  return { ok: true, attemptNumber: latest.attemptNumber + 1, reason: 'next_attempt' }
}

/**
 * Repayment — `STATE_MACHINES.md § 6.5`, Y01–Y08, `INV-46`, `INV-47`.
 *
 * The frozen table opens with the sentence that is the whole design:
 *
 * > *Capacity comes back on exactly one transition, and it is not the one that
 * > creates the repayment.*
 *
 * Creating a repayment does nothing to `drawn`. Submitting one does nothing to
 * `drawn`. Only `CONFIRMED` moves it — Y03 from a trusted confirmation, or Y06
 * from an authoritative status pull. A `REQUESTED`, `SUBMITTED` or `UNKNOWN`
 * repayment is `repayment_in_flight`: visible to operations and **excluded from
 * availability**, because money a provider has not confirmed returning is not
 * capacity however confident anyone is that it is coming.
 *
 * `UNKNOWN` resolves by pull and never by resubmission (`INV-47`). A duplicate
 * repayment is a real financial error in the opposite direction from a duplicate
 * payout, and it is prevented the same way — which is why the port carries
 * `getRepayment(ref)` alongside `submitRepayment`.
 */

export const REPAYMENT_STATUSES = [
  'REQUESTED',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'UNKNOWN',
] as const
export type RepaymentStatus = (typeof REPAYMENT_STATUSES)[number]

/**
 * `FAILED` is terminal *for this attempt* but permits a re-request under a new
 * fingerprint (Y08); `CONFIRMED` is terminal outright. `UNKNOWN` is deliberately
 * not terminal, for the same reason it is not terminal on a payout attempt: it
 * means we do not know, and the only move from not-knowing is to ask.
 */
export const TERMINAL_REPAYMENT_STATUSES: readonly RepaymentStatus[] = ['CONFIRMED']

/**
 * The statuses that hold value the facility has not got back yet. Excluded from
 * the availability formula by `INV-19` and `INV-46`.
 */
export const IN_FLIGHT_REPAYMENT_STATUSES: readonly RepaymentStatus[] = [
  'REQUESTED',
  'SUBMITTED',
  'UNKNOWN',
]

export function isRepaymentInFlight(status: RepaymentStatus): boolean {
  return IN_FLIGHT_REPAYMENT_STATUSES.includes(status)
}

export const REPAYMENT_SOURCES = [
  'CANCELLATION_AFTER_DRAWDOWN',
  'SETTLEMENT_RETURN',
  'MANUAL',
  'SCHEDULED',
] as const
export type RepaymentSource = (typeof REPAYMENT_SOURCES)[number]

export const REPAYMENT_TRIGGERS = [
  'request',
  'submit',
  'confirmed',
  'rejected',
  'sla_elapsed',
  'pull_resolved_confirmed',
  'pull_resolved_failed',
  're_request',
] as const
export type RepaymentTrigger = (typeof REPAYMENT_TRIGGERS)[number]

export const REPAYMENT_TRANSITION_IDS = [
  'Y01', 'Y02', 'Y03', 'Y04', 'Y05', 'Y06', 'Y07', 'Y08',
] as const
export type RepaymentTransitionId = (typeof REPAYMENT_TRANSITION_IDS)[number]

export interface RepaymentTransition {
  readonly id: RepaymentTransitionId
  readonly from: readonly RepaymentStatus[]
  readonly trigger: RepaymentTrigger
  readonly to: RepaymentStatus
  readonly guard: string
  /** Whether this transition restores facility capacity. True for Y03 and Y06 only. */
  readonly restoresCapacity: boolean
  /** Whether reaching this state requires a fresh idempotency key (`INV-47`). */
  readonly requiresNewFingerprint?: true
}

export const REPAYMENT_TRANSITIONS: readonly RepaymentTransition[] = [
  {
    id: 'Y01',
    from: [],
    trigger: 'request',
    to: 'REQUESTED',
    guard: 'cancellation after confirmed drawdown (T27/T23/T24), or a confirmed return (N02)',
    restoresCapacity: false,
  },
  {
    id: 'Y02',
    from: ['REQUESTED'],
    trigger: 'submit',
    to: 'SUBMITTED',
    guard: 'provider call enqueued with a stable request_fingerprint',
    restoresCapacity: false,
  },
  {
    id: 'Y03',
    from: ['SUBMITTED'],
    trigger: 'confirmed',
    to: 'CONFIRMED',
    guard: 'trusted provider confirmation',
    restoresCapacity: true,
  },
  {
    id: 'Y04',
    from: ['SUBMITTED'],
    trigger: 'rejected',
    to: 'FAILED',
    guard: 'trusted rejection',
    restoresCapacity: false,
  },
  {
    id: 'Y05',
    from: ['SUBMITTED'],
    trigger: 'sla_elapsed',
    to: 'UNKNOWN',
    guard: 'no terminal status within SLA — repayment watcher',
    restoresCapacity: false,
  },
  {
    id: 'Y06',
    from: ['UNKNOWN'],
    trigger: 'pull_resolved_confirmed',
    to: 'CONFIRMED',
    guard: 'authoritative status pull only (INV-47)',
    restoresCapacity: true,
  },
  {
    id: 'Y07',
    from: ['UNKNOWN'],
    trigger: 'pull_resolved_failed',
    to: 'FAILED',
    guard: 'authoritative status pull only',
    restoresCapacity: false,
  },
  {
    id: 'Y08',
    from: ['FAILED'],
    trigger: 're_request',
    to: 'REQUESTED',
    guard: 'attributed operator decision; a new request_fingerprint',
    restoresCapacity: false,
    requiresNewFingerprint: true,
  },
]

export type RepaymentEvaluation =
  | {
      readonly ok: true
      readonly id: RepaymentTransitionId
      readonly to: RepaymentStatus
      readonly restoresCapacity: boolean
      readonly requiresNewFingerprint: boolean
    }
  | { readonly ok: false; readonly error: 'invalid_transition' }

export function evaluateRepaymentTransition(
  from: RepaymentStatus | null,
  trigger: RepaymentTrigger,
): RepaymentEvaluation {
  const match = REPAYMENT_TRANSITIONS.find(
    (t) => t.trigger === trigger && (from === null ? t.from.length === 0 : t.from.includes(from)),
  )
  if (!match) return { ok: false, error: 'invalid_transition' }
  return {
    ok: true,
    id: match.id,
    to: match.to,
    restoresCapacity: match.restoresCapacity,
    requiresNewFingerprint: match.requiresNewFingerprint === true,
  }
}

/**
 * The transitions that move `drawn`. Named as a function rather than left
 * implicit so `INV-46` is checkable in one assertion: exactly Y03 and Y06.
 */
export function capacityRestoringTransitions(): readonly RepaymentTransitionId[] {
  return REPAYMENT_TRANSITIONS.filter((t) => t.restoresCapacity).map((t) => t.id)
}

/**
 * The repayment's provider idempotency key.
 *
 * Same shape and same reasoning as the payout key (`INV-25`): derived from the
 * repayment's own identity, stable across retries of the same submission, and
 * different for a genuinely new attempt. Y08 is the only path that mints a new
 * one, because a re-request after a failure *is* a new submission — and the
 * `attempt` component is what makes that expressible without inventing a
 * second identifier.
 */
export const REPAYMENT_FINGERPRINT_VERSION = 'v1'

export function repaymentFingerprint(repaymentId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`repayment attempt must be a positive integer, got ${attempt}`)
  }
  return `repay:${REPAYMENT_FINGERPRINT_VERSION}:${repaymentId}:${attempt}`
}

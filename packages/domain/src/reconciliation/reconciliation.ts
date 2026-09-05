/**
 * Reconciliation — `DOMAIN.md § 6.8`, `STATE_MACHINES.md § 6.4`, R01–R07.
 *
 * The comparison engine, and it is deliberately the least clever thing in the
 * codebase. `INV-26` sets the tolerance at **zero**:
 *
 * > *"`MATCHED` requires `observed_amount == expected_amount` exactly. Any
 * > non-zero delta is `MISMATCH` and is never silently accepted, absorbed, or
 * > auto-resolved."*
 *
 * So there is no tolerance parameter here, not even one defaulted to zero. A
 * configurable tolerance is a number someone eventually widens on a Friday to
 * clear a queue, and the widening is invisible afterwards. The absence of the
 * parameter is the invariant: a mismatch cannot be tuned away, only decided
 * about by a named person (`INV-27`).
 *
 * What *is* configurable is nothing at all. What is supplied is the observation,
 * and where it came from.
 */
import type { Money } from '@inrsettle/money'

export const RECONCILIATION_STATUSES = ['PENDING', 'MATCHED', 'MISMATCH', 'MANUAL_REVIEW'] as const
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number]

export const RECONCILIATION_TRIGGERS = [
  'begin',
  'observed_matching',
  'observed_differing',
  'observation_overdue',
  'escalate',
  'resolve_matched',
  'resolve_unresolvable',
] as const
export type ReconciliationTrigger = (typeof RECONCILIATION_TRIGGERS)[number]

export const RECONCILIATION_TRANSITION_IDS = [
  'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07',
] as const
export type ReconciliationTransitionId = (typeof RECONCILIATION_TRANSITION_IDS)[number]

export interface ReconciliationTransition {
  readonly id: ReconciliationTransitionId
  readonly from: readonly ReconciliationStatus[]
  readonly trigger: ReconciliationTrigger
  readonly to: ReconciliationStatus
  readonly guard: string
  /**
   * Whether reaching this state requires an attributed operator decision.
   * `INV-27`: a mismatch is *"resolved only by an explicit, attributed operator
   * decision"*, so the requirement is data on the row rather than a convention
   * in a service.
   */
  readonly requiresAttribution?: true
  /**
   * `R06` only. `INV-27` also requires a compensating financial entry *"where
   * value moved incorrectly"* — which is a fact the resolver must assert, not
   * one this table can know.
   */
  readonly requiresCompensationDecision?: true
}

/** The normative table. Row order matches `STATE_MACHINES.md § 6.4`. */
export const RECONCILIATION_TRANSITIONS: readonly ReconciliationTransition[] = [
  {
    id: 'R01',
    from: [],
    trigger: 'begin',
    to: 'PENDING',
    guard: 'opened by T19',
  },
  {
    id: 'R02',
    from: ['PENDING'],
    trigger: 'observed_matching',
    to: 'MATCHED',
    guard: 'authoritative observation; delta exactly zero (INV-26)',
  },
  {
    id: 'R03',
    from: ['PENDING'],
    trigger: 'observed_differing',
    to: 'MISMATCH',
    guard: 'authoritative observation; non-zero delta',
  },
  {
    id: 'R04',
    from: ['PENDING'],
    trigger: 'observation_overdue',
    to: 'MANUAL_REVIEW',
    guard: 'no authoritative observation within SLA — reconciliation poller; drives T30',
  },
  {
    id: 'R05',
    from: ['MISMATCH'],
    trigger: 'escalate',
    to: 'MANUAL_REVIEW',
    guard: 'automatic; a mismatch is never left unattended',
  },
  {
    id: 'R06',
    from: ['MANUAL_REVIEW'],
    trigger: 'resolve_matched',
    to: 'MATCHED',
    guard: 'attributed operator decision plus a compensating entry where value moved incorrectly (INV-27)',
    requiresAttribution: true,
    requiresCompensationDecision: true,
  },
  {
    id: 'R07',
    from: ['MANUAL_REVIEW'],
    trigger: 'resolve_unresolvable',
    to: 'MISMATCH',
    guard: 'attributed decision; the settlement then fails via T23',
    requiresAttribution: true,
  },
]

export type ReconciliationEvaluation =
  | { readonly ok: true; readonly transition: ReconciliationTransition; readonly to: ReconciliationStatus }
  | {
      readonly ok: false
      readonly error: 'invalid_transition'
      readonly from: ReconciliationStatus | null
      readonly trigger: ReconciliationTrigger
    }

export function evaluateReconciliationTransition(
  from: ReconciliationStatus | null,
  trigger: ReconciliationTrigger,
): ReconciliationEvaluation {
  const match = RECONCILIATION_TRANSITIONS.find(
    (t) => t.trigger === trigger && (from === null ? t.from.length === 0 : t.from.includes(from)),
  )
  if (!match) return { ok: false, error: 'invalid_transition', from, trigger }
  return { ok: true, transition: match, to: match.to }
}

/* ── The comparison itself ──────────────────────────────────────────────── */

/**
 * Where an observation came from.
 *
 * Recorded because `F3` and `INV-39` both turn on *how* we know something, and
 * a comparison whose input's provenance is unrecorded cannot be audited later.
 * The set is closed: there is no `operator_assertion` member, and that omission
 * is the point — `STATE_MACHINES.md § 8.2` lists *"an operator's belief, however
 * senior the operator"* among the things that must never create finality.
 */
export const OBSERVATION_SOURCES = [
  /** A webhook whose signature verified against the provider's current key. */
  'trusted_provider_event',
  /** A response to an authenticated request INRSettle itself initiated. */
  'authoritative_status_pull',
] as const
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number]

export interface Observation {
  readonly source: ObservationSource
  /**
   * What the rail says reached the beneficiary. `null` is a real answer — the
   * provider stated no figure — and is deliberately not the same as zero.
   */
  readonly observedAmount: Money | null
  readonly observedAt: string
}

export type ComparisonVerdict =
  | {
      readonly kind: 'matched'
      readonly delta: Money
      readonly trigger: 'observed_matching'
    }
  | {
      readonly kind: 'mismatch'
      readonly delta: Money
      readonly trigger: 'observed_differing'
      readonly why: 'short' | 'over' | 'currency_mismatch' | 'no_amount_observed'
    }

/**
 * Compare what was expected against what was observed.
 *
 * Four ways to be a mismatch, and they are kept distinct in `why` while sharing
 * one outcome, for the same reason `D-18` gives on the drawdown side: a caller
 * given separate outcomes starts handling one of them, and that is how a policy
 * gets made by accident. The direction is available for the operator who has to
 * decide; it changes nothing here.
 *
 * `no_amount_observed` is a mismatch rather than a pass. A provider that credited
 * and will not say how much has not given us the evidence `F5` asks for, and
 * `MATCHED` means *we checked*, not *we had no reason to doubt*.
 */
export function compareObservation(expected: Money, observation: Observation): ComparisonVerdict {
  const zero: Money = { currency: expected.currency, minorUnits: 0n }

  if (observation.observedAmount === null) {
    return { kind: 'mismatch', delta: zero, trigger: 'observed_differing', why: 'no_amount_observed' }
  }
  if (observation.observedAmount.currency !== expected.currency) {
    return { kind: 'mismatch', delta: zero, trigger: 'observed_differing', why: 'currency_mismatch' }
  }

  // Observed minus expected: negative is short, positive is over. Signed on
  // purpose — an absolute delta would lose the one piece of information the
  // operator actually needs first.
  const deltaMinor = observation.observedAmount.minorUnits - expected.minorUnits
  const delta: Money = { currency: expected.currency, minorUnits: deltaMinor }

  if (deltaMinor === 0n) return { kind: 'matched', delta, trigger: 'observed_matching' }
  return {
    kind: 'mismatch',
    delta,
    trigger: 'observed_differing',
    why: deltaMinor < 0n ? 'short' : 'over',
  }
}

/**
 * Only `MATCHED` can satisfy `F5`, and only with a delta of exactly zero.
 *
 * Both halves are checked rather than one, because they are separately
 * falsifiable: a row could be `MATCHED` with a non-zero delta only if something
 * had gone wrong, and that is exactly the case where a finality evaluator that
 * trusted the status label would settle a mismatch.
 */
export function satisfiesF5(status: ReconciliationStatus, deltaMinor: bigint): boolean {
  return status === 'MATCHED' && deltaMinor === 0n
}

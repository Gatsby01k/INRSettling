/**
 * Batch — `DOMAIN.md § 6.11`, `STATE_MACHINES.md § 6.8`, `PRODUCT.md § 10`.
 *
 * > `INV-30` — *"A batch is a container, not a transaction. An invalid or
 * > blocked row never blocks a valid row, and the batch has no all-or-nothing
 * > semantics."*
 *
 * Everything in this file follows from that sentence, and the most important
 * consequence is what the batch machine **cannot** do: it has no transition
 * that moves a settlement. A batch's status is a *summary* of rows that each
 * live their own life, so nothing here reaches into the settlement machine, and
 * `refreshAggregates` derives its counters from the rows rather than
 * incrementing them as it goes. A counter that is written independently of the
 * thing it counts is a counter that eventually disagrees with it — and on a
 * screen headed *"143 settlements ₹12,840,000"* the disagreement is the first
 * thing a customer notices.
 *
 * ## A note on the transition ids
 *
 * The frozen document gives the batch its states and their order:
 *
 * > `DRAFT → VALIDATING → READY → EXECUTING → COMPLETED | PARTIALLY_COMPLETED`
 *
 * and, unlike the settlement, quote, reservation, payout, reconciliation,
 * repayment and return machines, it numbers nothing. So the `B01…B05` ids below
 * are **Stage 7's numbering of the frozen sequence, not a quotation from the
 * baseline**. They exist so the lifecycle is table-driven and testable like
 * every other machine here; they carry no more authority than that.
 *
 * The sequence itself is followed exactly, with **no additional edges**. In
 * particular a batch whose rows were all invalid still goes
 * `VALIDATING → READY → EXECUTING → PARTIALLY_COMPLETED`: `EXECUTING` is the
 * container's phase rather than the rows', and it completes with zero executable
 * rows. An earlier cut of this stage added a `READY → PARTIALLY_COMPLETED`
 * shortcut for that case; it was a new edge on a frozen machine to describe
 * something the existing path already describes, and it is gone.
 */
import type { Money } from '@inrsettle/money'

export const BATCH_STATUSES = [
  'DRAFT',
  'VALIDATING',
  'READY',
  'EXECUTING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]

export const BATCH_SOURCES = ['CSV', 'API'] as const
export type BatchSource = (typeof BATCH_SOURCES)[number]

export const BATCH_TRIGGERS = [
  'begin_validation',
  'validated',
  'begin_execution',
  'all_rows_resolved',
  'some_rows_unresolved',
] as const
export type BatchTrigger = (typeof BATCH_TRIGGERS)[number]

export const BATCH_TRANSITION_IDS = ['B01', 'B02', 'B03', 'B04', 'B05'] as const
export type BatchTransitionId = (typeof BATCH_TRANSITION_IDS)[number]

export interface BatchTransition {
  readonly id: BatchTransitionId
  readonly from: readonly BatchStatus[]
  readonly trigger: BatchTrigger
  readonly to: BatchStatus
  readonly guard: string
  readonly customerEvent?: string
}

export const BATCH_TRANSITIONS: readonly BatchTransition[] = [
  {
    id: 'B01',
    from: [],
    trigger: 'begin_validation',
    to: 'VALIDATING',
    guard: 'rows have been received from a CSV import or an API call',
  },
  {
    id: 'B02',
    from: ['VALIDATING'],
    trigger: 'validated',
    to: 'READY',
    guard:
      'every row has been validated. READY does not mean every row is valid — ' +
      'it means every row has an answer (INV-30)',
    customerEvent: 'batch.validated',
  },
  {
    id: 'B03',
    from: ['READY'],
    trigger: 'begin_execution',
    to: 'EXECUTING',
    // Deliberately not "at least one valid row was authorized". A batch whose
    // rows were all invalid still passes through EXECUTING: the phase is the
    // container's, not the rows', and it completes with zero executable rows
    // rather than being skipped. Adding a READY → PARTIALLY_COMPLETED shortcut
    // would extend the frozen state line to cover a case the existing path
    // already handles.
    guard: 'the execution phase begins; it may have zero executable rows',
  },
  {
    id: 'B04',
    from: ['EXECUTING'],
    trigger: 'all_rows_resolved',
    to: 'COMPLETED',
    guard: 'every row reached a terminal settlement state and none needs attention',
    customerEvent: 'batch.completed',
  },
  {
    id: 'B05',
    from: ['EXECUTING'],
    trigger: 'some_rows_unresolved',
    to: 'PARTIALLY_COMPLETED',
    guard: 'every row that could resolve has; some could not',
    customerEvent: 'batch.partially_completed',
  },
]

export type BatchEvaluation =
  | { readonly ok: true; readonly transition: BatchTransition; readonly to: BatchStatus }
  | {
      readonly ok: false
      readonly error: 'invalid_transition'
      readonly from: BatchStatus | null
      readonly trigger: BatchTrigger
    }

export function evaluateBatchTransition(
  from: BatchStatus | null,
  trigger: BatchTrigger,
): BatchEvaluation {
  const match = BATCH_TRANSITIONS.find(
    (t) => t.trigger === trigger && (from === null ? t.from.length === 0 : t.from.includes(from)),
  )
  if (!match) return { ok: false, error: 'invalid_transition', from, trigger }
  return { ok: true, transition: match, to: match.to }
}

/** `COMPLETED` and `PARTIALLY_COMPLETED` are where a batch stops. */
export function isTerminalBatchStatus(status: BatchStatus): boolean {
  return status === 'COMPLETED' || status === 'PARTIALLY_COMPLETED'
}

/* ── Row outcomes ───────────────────────────────────────────────────────── */

/**
 * What happened to one row, from the batch's point of view.
 *
 * Deliberately *not* the settlement's status. A batch summarising seventeen
 * internal settlement states would be a second projection of the machine, and
 * `INV-18` allows exactly one. This is a coarser question — did the row become a
 * settlement, does it need somebody, is it finished — and it maps from the
 * **customer** projection, which is the projection a customer-facing aggregate
 * should be built on.
 */
export const BATCH_ROW_OUTCOMES = [
  /** The row could not be read or did not validate. It never became a settlement. */
  'INVALID',
  /** A settlement exists and is progressing on its own. */
  'ACCEPTED',
  /** A settlement exists and is waiting for the customer (`INV-37`). */
  'ACTION_REQUIRED',
  'SETTLED',
  'FAILED',
  'CANCELLED',
] as const
export type BatchRowOutcome = (typeof BATCH_ROW_OUTCOMES)[number]

/**
 * The batch's view of a row, derived from the customer projection.
 *
 * One mapping, in one place, from the five customer states plus "never became a
 * settlement". A row whose settlement is `READY` or `SETTLING` is `ACCEPTED`:
 * both mean *it is under way and nobody is waiting on you*, which is the only
 * distinction a batch aggregate needs to draw.
 */
export function rowOutcomeFromCustomerStatus(
  customerStatus: 'READY' | 'SETTLING' | 'SETTLED' | 'ACTION_REQUIRED' | 'CANCELLED' | null,
  settlementStatus: string | null,
): BatchRowOutcome {
  if (settlementStatus === 'FAILED') return 'FAILED'
  switch (customerStatus) {
    case 'SETTLED': return 'SETTLED'
    case 'ACTION_REQUIRED': return 'ACTION_REQUIRED'
    case 'CANCELLED': return 'CANCELLED'
    case 'READY':
    case 'SETTLING': return 'ACCEPTED'
    // A settlement in DRAFT has no customer status yet — it is composed but not
    // preflighted. From the batch's side that is still "accepted": the row was
    // read, it produced a settlement, and nothing is wrong with it.
    case null: return settlementStatus === null ? 'INVALID' : 'ACCEPTED'
  }
}

/** A row that has stopped moving on its own. */
export function isResolvedOutcome(outcome: BatchRowOutcome): boolean {
  return outcome === 'SETTLED' || outcome === 'FAILED' || outcome === 'CANCELLED' || outcome === 'INVALID'
}

/** A row somebody has to do something about. */
export function needsAttention(outcome: BatchRowOutcome): boolean {
  return outcome === 'INVALID' || outcome === 'ACTION_REQUIRED'
}

/* ── Aggregates ─────────────────────────────────────────────────────────── */

export interface BatchAggregates {
  readonly rowCount: number
  readonly validCount: number
  readonly actionRequiredCount: number
  readonly settledCount: number
  readonly failedCount: number
  /** `PRODUCT.md § 10`'s headline figure. Only rows that became settlements. */
  readonly total: Money
}

/**
 * Derive every counter from the rows, in one pass.
 *
 * Derived rather than maintained, because the alternative is six counters
 * updated by however many code paths touch a row, and the first time one of them
 * forgets, the batch screen tells a customer they have 143 settlements worth
 * ₹12,840,000 when they have 142 worth less.
 *
 * `total` sums only rows that became settlements. An invalid row has an amount
 * in the file and no settlement in the system, and adding it to the headline
 * would claim money is moving that is not.
 */
export function aggregate(
  rows: readonly { outcome: BatchRowOutcome; amountMinor: bigint | null }[],
  currency: Money['currency'],
): BatchAggregates {
  let validCount = 0
  let actionRequiredCount = 0
  let settledCount = 0
  let failedCount = 0
  let totalMinor = 0n

  for (const row of rows) {
    if (row.outcome === 'INVALID') continue
    validCount += 1
    if (row.outcome === 'ACTION_REQUIRED') actionRequiredCount += 1
    if (row.outcome === 'SETTLED') settledCount += 1
    if (row.outcome === 'FAILED') failedCount += 1
    if (row.amountMinor !== null) totalMinor += row.amountMinor
  }

  return {
    rowCount: rows.length,
    validCount,
    actionRequiredCount,
    settledCount,
    failedCount,
    total: { currency, minorUnits: totalMinor },
  }
}

/**
 * Which terminal state a batch has reached, or `null` if it is still running.
 *
 * `COMPLETED` requires **every** row to have resolved *and* none to need
 * attention. A batch with forty invalid rows and four hundred and sixty settled
 * ones is `PARTIALLY_COMPLETED` — which is the honest answer, and is why the
 * frozen state line has two terminal states rather than one.
 */
export function terminalOutcome(
  rows: readonly { outcome: BatchRowOutcome }[],
): 'all_rows_resolved' | 'some_rows_unresolved' | null {
  if (rows.length === 0) return null
  if (rows.some((r) => !isResolvedOutcome(r.outcome))) return null
  return rows.some((r) => needsAttention(r.outcome)) ? 'some_rows_unresolved' : 'all_rows_resolved'
}

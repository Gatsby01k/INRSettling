/**
 * Settlement status and the event vocabulary — `STATE_MACHINES.md § 4`, `§ 8`.
 *
 * `INV-32` divides events into two disjoint sets, and the division is the whole
 * basis of the pairing rule enforced by a database trigger: a transaction that
 * updates `settlements.status` writes exactly one **status event** and any
 * number of **companion events**.
 */

export const SETTLEMENT_STATUSES = [
  'DRAFT',
  'PREFLIGHTING',
  'ACTION_REQUIRED',
  'READY',
  'QUOTED',
  'AUTHORIZED',
  'LIQUIDITY_RESERVING',
  'LIQUIDITY_RESERVED',
  'DRAWDOWN_REQUESTED',
  'DRAWDOWN_CONFIRMED',
  'PAYOUT_SUBMITTED',
  'PAYOUT_CONFIRMED',
  'RECONCILING',
  'EXCEPTION',
  'SETTLED',
  'FAILED',
  'CANCELLED',
] as const

export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number]

/** `INV-38` — no outgoing transitions, and no field writes of any kind. */
export const TERMINAL_STATUSES = ['SETTLED', 'FAILED', 'CANCELLED'] as const
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

export function isTerminal(status: SettlementStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

/**
 * Exactly one of these is the canonical event of each status-changing
 * transition. The set is closed: a new status event is a change to this list
 * *and* to the database enum the trigger reads.
 */
export const SETTLEMENT_STATUS_EVENTS = [
  'settlement.created',
  'settlement.preflight_started',
  'settlement.ready',
  'settlement.action_required',
  'settlement.quoted',
  'settlement.authorized',
  'settlement.liquidity_reservation_started',
  'settlement.liquidity_reserved',
  'settlement.drawdown_requested',
  'settlement.drawdown_confirmed',
  'settlement.payout_submitted',
  'settlement.payout_confirmed',
  'settlement.reconciliation_started',
  'settlement.settled',
  'settlement.exception_opened',
  'settlement.exception_resolved',
  'settlement.failed',
  'settlement.cancelled',
] as const

export type SettlementStatusEvent = (typeof SETTLEMENT_STATUS_EVENTS)[number]

export function isStatusEvent(type: string): type is SettlementStatusEvent {
  return (SETTLEMENT_STATUS_EVENTS as readonly string[]).includes(type)
}

/**
 * Companion events Stage 3 can emit. Events of other aggregates and non-status
 * settlement events. Listed so the table-driven test can assert the exact set
 * a transition emits, rather than only that it emitted "some" companions.
 */
export const COMPANION_EVENTS = [
  'settlement.preflight_completed',
  'settlement.cancellation_requested',
  'settlement.replacement_created',
  'quote.locked',
  'quote.consumed',
  'quote.expired',
  'quote.voided',
  'facility.reservation_created',
  'facility.reservation_released',
  'facility.reservation_expired',
  'facility.drawdown_confirmed',
  'facility.repayment_requested',
  'settlement.reconciled',
  'receipt.available',
] as const

export type CompanionEvent = (typeof COMPANION_EVENTS)[number]

/**
 * The customer-facing states — `PRODUCT.md § 6`. Five, and no sixth.
 * `DRAFT` projects to nothing: drafts appear only in the composing surface.
 */
export const CUSTOMER_STATUSES = ['READY', 'SETTLING', 'SETTLED', 'ACTION_REQUIRED', 'CANCELLED'] as const
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number]

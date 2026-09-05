/**
 * The customer-status projection — `STATE_MACHINES.md § 5`, `INV-18`.
 *
 * **This is the only place the projection exists.** `customer_status` is
 * materialised on the settlement row for query performance, but it is derived
 * here and written by the transition service alone; nothing computes it a
 * second time. A projection defined twice is a projection that disagrees with
 * itself, and the disagreement surfaces as a customer seeing one state in a
 * list and another on the detail screen.
 *
 * Seventeen internal states collapse to five customer states, and the collapse
 * is deliberate: the customer's question is "what is happening to my money",
 * not "which sub-machine is running".
 */
import type { CustomerStatus, SettlementStatus } from './status.js'
import { isCustomerActionable, type ExceptionCode } from './exceptions.js'

export interface ProjectionInput {
  readonly status: SettlementStatus
  /** The open exception's code, when `status` is `EXCEPTION`. */
  readonly openExceptionCode?: ExceptionCode | null | undefined
}

export type CustomerProjection =
  | { readonly customerStatus: CustomerStatus; readonly listed: true; readonly delayed?: boolean }
  /** `DRAFT` is not a customer state: drafts appear only in the composing surface. */
  | { readonly customerStatus: null; readonly listed: false }

export function projectCustomerStatus(input: ProjectionInput): CustomerProjection {
  switch (input.status) {
    case 'DRAFT':
      return { customerStatus: null, listed: false }

    // A brief checking state, not a new status.
    case 'PREFLIGHTING':
    case 'READY':
    case 'QUOTED':
      return { customerStatus: 'READY', listed: true }

    // Preflight-only (INV-37).
    case 'ACTION_REQUIRED':
      return { customerStatus: 'ACTION_REQUIRED', listed: true }

    // The whole execution span is one customer state.
    case 'AUTHORIZED':
    case 'LIQUIDITY_RESERVING':
    case 'LIQUIDITY_RESERVED':
    case 'DRAWDOWN_REQUESTED':
    case 'DRAWDOWN_CONFIRMED':
    case 'PAYOUT_SUBMITTED':
    case 'PAYOUT_CONFIRMED':
    case 'RECONCILING':
      return { customerStatus: 'SETTLING', listed: true }

    case 'EXCEPTION': {
      // The second of the two sources of customer-facing ACTION_REQUIRED. An
      // exception with no code recorded cannot be shown as actionable: we would
      // be telling the customer to fix something we cannot name.
      const actionable =
        input.openExceptionCode != null && isCustomerActionable(input.openExceptionCode)
      return actionable
        ? { customerStatus: 'ACTION_REQUIRED', listed: true }
        : { customerStatus: 'SETTLING', listed: true, delayed: true }
    }

    case 'SETTLED':
      return { customerStatus: 'SETTLED', listed: true }

    // D-03, closed for V1. The five customer states answer "what is happening
    // to my money", and these two have the same answer: nothing was delivered
    // and the liquidity is released. What differs is *why*, which a resolution
    // reason says far better than a state name — see `resolution.ts`. There is
    // no `NOT_COMPLETED` and no sixth customer-facing state.
    case 'FAILED':
    case 'CANCELLED':
      return { customerStatus: 'CANCELLED', listed: true }
  }
}

/**
 * Convenience for the materialised column. `DRAFT` has no customer status, and
 * the column is nullable for exactly that reason.
 */
export function customerStatusColumn(input: ProjectionInput): CustomerStatus | null {
  return projectCustomerStatus(input).customerStatus
}

/**
 * Whether the customer may cancel right now.
 *
 * Deliberately not the same question as "is a cancel transition legal": before
 * authorization cancellation is immediate (T25); after it, the customer is
 * *requesting* cancellation (T26) and it takes effect at the next checkpoint
 * (T27). Past the point of no return there is nothing to offer.
 */
export function cancellationAffordance(input: {
  status: SettlementStatus
  pointOfNoReturnAt: Date | null
  cancellationRequestedAt: Date | null
}): 'cancel' | 'request_cancellation' | 'requested' | 'none' {
  if (input.pointOfNoReturnAt !== null) return 'none'
  if (input.cancellationRequestedAt !== null) return 'requested'
  switch (input.status) {
    case 'DRAFT':
    case 'READY':
    case 'QUOTED':
    case 'ACTION_REQUIRED':
      return 'cancel'
    case 'AUTHORIZED':
    case 'LIQUIDITY_RESERVING':
    case 'LIQUIDITY_RESERVED':
    case 'DRAWDOWN_REQUESTED':
    case 'DRAWDOWN_CONFIRMED':
      return 'request_cancellation'
    default:
      return 'none'
  }
}

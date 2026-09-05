/**
 * Liquidity reservation — `STATE_MACHINES.md § 6.2`, V01–V04.
 *
 * The table is frozen and is reproduced here as data, for the same reasons the
 * settlement table is: it can be checked against the document row by row, and it
 * cannot grow a quiet extra branch in a code review.
 *
 * The load-bearing fact is what is **absent**. `CONSUMED` has no outgoing
 * transition. Once a drawdown is confirmed the value is no longer reserved — it
 * is drawn — and there is nothing to give back on the reservation side.
 * Capacity after a confirmed drawdown returns through exactly one mechanism, a
 * `CONFIRMED` repayment (`INV-46`), and any code path that tries to release a
 * consumed reservation is double-crediting the facility.
 */
import type { LedgerMovement } from './facility.js'

export const RESERVATION_STATUSES = ['ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED'] as const
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]

/**
 * `CONSUMED` is terminal in a different sense from `RELEASED`/`EXPIRED`: the
 * value is still committed, it has simply moved account. The distinction
 * matters because a return arriving months later must find no release path.
 */
export const TERMINAL_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  'CONSUMED',
  'RELEASED',
  'EXPIRED',
]

export function isReservationTerminal(status: ReservationStatus): boolean {
  return TERMINAL_RESERVATION_STATUSES.includes(status)
}

export const RESERVATION_TRIGGERS = ['reserve', 'consume', 'release', 'expire'] as const
export type ReservationTrigger = (typeof RESERVATION_TRIGGERS)[number]

export const RESERVATION_TRANSITION_IDS = ['V01', 'V02', 'V03', 'V04'] as const
export type ReservationTransitionId = (typeof RESERVATION_TRANSITION_IDS)[number]

export interface ReservationTransition {
  readonly id: ReservationTransitionId
  readonly from: readonly ReservationStatus[]
  readonly trigger: ReservationTrigger
  readonly to: ReservationStatus
  readonly guard: string
  /** The ledger movement this transition posts (`INV-23`). */
  readonly movement: LedgerMovement
}

export const RESERVATION_TRANSITIONS: readonly ReservationTransition[] = [
  {
    id: 'V01',
    from: [],
    trigger: 'reserve',
    to: 'ACTIVE',
    guard: 'facility row lock, available >= amount (INV-20)',
    movement: 'reservation_created',
  },
  {
    id: 'V02',
    from: ['ACTIVE'],
    trigger: 'consume',
    to: 'CONSUMED',
    guard: 'drawdown confirmed (T13)',
    movement: 'reservation_consumed',
  },
  {
    id: 'V03',
    from: ['ACTIVE'],
    trigger: 'release',
    to: 'RELEASED',
    guard: 'cancel before drawdown, or failure before drawdown; idempotent',
    movement: 'reservation_released',
  },
  {
    id: 'V04',
    from: ['ACTIVE'],
    trigger: 'expire',
    to: 'EXPIRED',
    guard: 'TTL reached without drawdown — reservation sweeper, drives T28',
    movement: 'reservation_expired',
  },
]

export type ReservationEvaluation =
  | { readonly ok: true; readonly id: ReservationTransitionId; readonly to: ReservationStatus; readonly movement: LedgerMovement }
  | { readonly ok: false; readonly error: 'invalid_transition' }
  /**
   * Distinct from `invalid_transition` on purpose, and required by `INV-22`:
   * *"attempting to release a `CONSUMED` reservation is a typed error, not a
   * no-op, so a mistaken code path fails loudly instead of silently
   * double-crediting the facility."* A generic refusal would let a caller treat
   * it as "already done" and carry on.
   */
  | { readonly ok: false; readonly error: 'consumed_cannot_be_released' }

export function evaluateReservationTransition(
  from: ReservationStatus | null,
  trigger: ReservationTrigger,
): ReservationEvaluation {
  if (from === 'CONSUMED' && (trigger === 'release' || trigger === 'expire')) {
    return { ok: false, error: 'consumed_cannot_be_released' }
  }

  const match = RESERVATION_TRANSITIONS.find(
    (t) => t.trigger === trigger && (from === null ? t.from.length === 0 : t.from.includes(from)),
  )
  if (!match) return { ok: false, error: 'invalid_transition' }
  return { ok: true, id: match.id, to: match.to, movement: match.movement }
}

/**
 * Whether a release is a no-op rather than an error.
 *
 * `INV-22` calls release idempotent under repeated cancel, fail and expiry.
 * Idempotent means the *second* release of an already-released reservation
 * changes nothing and is not an error — the caller may genuinely be retrying.
 * It does **not** extend to `CONSUMED`, which is a different reservation
 * outcome and a real mistake.
 */
export function releaseIsNoop(status: ReservationStatus): boolean {
  return status === 'RELEASED' || status === 'EXPIRED'
}

export const RESERVATION_RELEASE_REASONS = [
  'settlement_cancelled',
  'settlement_failed',
  'drawdown_failed',
  'ttl_expired',
] as const
export type ReservationReleaseReason = (typeof RESERVATION_RELEASE_REASONS)[number]

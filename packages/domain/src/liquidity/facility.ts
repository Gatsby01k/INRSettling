/**
 * The liquidity facility — `DOMAIN.md § 6.6`, `INV-19`, `INV-23`.
 *
 * Liquidity is modelled properly. It is not a boolean on a settlement, and the
 * three figures that matter are not stored opinions:
 *
 *     available = limit − drawn − reserved,   and   available >= 0 always.
 *
 * `drawn` and `reserved` are **projections of the ledger** (`INV-23`), not
 * independently maintained counters. That distinction is the whole design. A
 * counter that is incremented alongside a ledger entry will eventually diverge
 * from it — a retry, a missed rollback, one code path that forgot — and the
 * divergence is silent, which in a facility means either refusing settlements
 * that could be funded or funding settlements that cannot be. Because the
 * projection is derived, it can be recomputed and compared, and the comparison
 * is what turns a silent divergence into an alarm.
 *
 * **In-flight repayments are not capacity** (`INV-46`). Money a provider has not
 * confirmed returning does not appear in this formula, however confident anyone
 * is that it is coming.
 */
import { compare, money, subtract, type CurrencyCode, type Money } from '@inrsettle/money'

export const FACILITY_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const
export type FacilityStatus = (typeof FACILITY_STATUSES)[number]

/**
 * Whether a facility may fund new settlements.
 *
 * `SUSPENDED` is deliberately not `CLOSED`: existing drawdowns still have to be
 * repaid and existing reservations still have to be released, so a suspended
 * facility keeps working for everything except taking on new exposure.
 */
export function facilityAcceptsNewExposure(status: FacilityStatus): boolean {
  return status === 'ACTIVE'
}

export interface FacilityPosition {
  readonly currency: CurrencyCode
  readonly limit: Money
  /** Outstanding drawn value. Falls only on a CONFIRMED repayment (`INV-46`). */
  readonly drawn: Money
  /** Sum of ACTIVE reservations. */
  readonly reserved: Money
}

export class LiquidityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'LiquidityError'
  }
}

/** `INV-19`. Throws rather than returning a negative: there is no such position. */
export function availableToSettle(position: FacilityPosition): Money {
  const available = subtract(subtract(position.limit, position.drawn), position.reserved)
  if (available.minorUnits < 0n) {
    // Reachable only if a projection has already gone wrong. Failing here is
    // how that surfaces as an incident rather than as an over-allocation.
    throw new LiquidityError(
      `facility availability is negative (${available.minorUnits}); the projection disagrees with the ledger (INV-19, INV-23)`,
      'negative_availability',
    )
  }
  return available
}

/** Whether an amount can be reserved right now. Pure; the caller holds the lock. */
export function canReserve(
  position: FacilityPosition,
  status: FacilityStatus,
  amount: Money,
): { ok: true } | { ok: false; reason: 'facility_not_active' | 'insufficient_availability' | 'currency_mismatch' } {
  if (!facilityAcceptsNewExposure(status)) return { ok: false, reason: 'facility_not_active' }
  if (amount.currency !== position.currency) return { ok: false, reason: 'currency_mismatch' }
  // `>= amount`, not `> amount`: a reservation that exactly exhausts a facility
  // is legitimate, and refusing it would strand the last settlement.
  if (compare(availableToSettle(position), amount) < 0) {
    return { ok: false, reason: 'insufficient_availability' }
  }
  return { ok: true }
}

/**
 * The facility position implied by a set of ledger entries.
 *
 * This is the definition of `drawn` and `reserved` — the columns on the facility
 * row are a cache of it. `INV-23`'s rebuild test calls this and compares.
 */
export function projectPosition(
  currency: CurrencyCode,
  limit: Money,
  entries: readonly LedgerEntry[],
): FacilityPosition {
  let drawn = 0n
  let reserved = 0n
  for (const entry of entries) {
    if (entry.currency !== currency) {
      throw new LiquidityError(
        `ledger entry ${entry.id} is in ${entry.currency}, not the facility currency ${currency}`,
        'currency_mismatch',
      )
    }
    switch (entry.account) {
      case 'reserved':
        reserved += entry.direction === 'debit' ? entry.minorUnits : -entry.minorUnits
        break
      case 'drawn':
        drawn += entry.direction === 'debit' ? entry.minorUnits : -entry.minorUnits
        break
      case 'available':
        // The contra account. It exists so every movement is a balanced pair
        // and never participates in the projection: `available` is computed
        // from the other two, not accumulated.
        break
    }
  }
  return { currency, limit, drawn: money(currency, drawn), reserved: money(currency, reserved) }
}

/* ── The ledger (INV-23) ────────────────────────────────────────────────── */

/**
 * Three accounts, and every movement is a balanced pair between two of them.
 *
 * `available` is the contra account. Reserving moves value from `available` to
 * `reserved`; confirming a drawdown moves it from `reserved` to `drawn`;
 * releasing moves it back from `reserved` to `available`; a confirmed repayment
 * moves it from `drawn` to `available`. Every one of those is a pair that sums
 * to zero, which is what makes "the ledger cannot be half-written" checkable
 * rather than asserted.
 */
export const LEDGER_ACCOUNTS = ['available', 'reserved', 'drawn'] as const
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number]

export type LedgerDirection = 'debit' | 'credit'

export const LEDGER_MOVEMENTS = [
  'reservation_created',
  'reservation_released',
  'reservation_expired',
  'reservation_consumed',
  'repayment_confirmed',
  'limit_changed',
] as const
export type LedgerMovement = (typeof LEDGER_MOVEMENTS)[number]

export interface LedgerEntry {
  readonly id: string
  readonly facilityId: string
  /** Pairs share a transfer id, so a half-written movement is detectable. */
  readonly transferId: string
  readonly movement: LedgerMovement
  readonly account: LedgerAccount
  readonly direction: LedgerDirection
  readonly currency: CurrencyCode
  readonly minorUnits: bigint
}

export interface LedgerPair {
  readonly movement: LedgerMovement
  readonly from: LedgerAccount
  readonly to: LedgerAccount
}

/**
 * Which pair each movement posts. A table rather than a switch, so it can be
 * checked for exhaustiveness and read next to the frozen effect columns in
 * `STATE_MACHINES.md § 6.2` and `§ 6.5`.
 */
export const MOVEMENT_PAIRS: Readonly<Record<Exclude<LedgerMovement, 'limit_changed'>, LedgerPair>> = {
  // V01 — `reserved` rises.
  reservation_created: { movement: 'reservation_created', from: 'available', to: 'reserved' },
  // V03 — `reserved` falls.
  reservation_released: { movement: 'reservation_released', from: 'reserved', to: 'available' },
  // V04 — `reserved` falls.
  reservation_expired: { movement: 'reservation_expired', from: 'reserved', to: 'available' },
  // V02 — `reserved` falls, `drawn` rises. One movement, because the value does
  // not pass through `available` on its way: it was never spendable again.
  reservation_consumed: { movement: 'reservation_consumed', from: 'reserved', to: 'drawn' },
  // Y03/Y06 — `drawn` falls. The only transition that restores capacity after a
  // confirmed drawdown (`INV-46`).
  repayment_confirmed: { movement: 'repayment_confirmed', from: 'drawn', to: 'available' },
}

/** The two entries a movement posts. Debit the destination, credit the source. */
export function ledgerPairFor(
  movement: Exclude<LedgerMovement, 'limit_changed'>,
): { debit: LedgerAccount; credit: LedgerAccount } {
  const pair = MOVEMENT_PAIRS[movement]
  return { debit: pair.to, credit: pair.from }
}

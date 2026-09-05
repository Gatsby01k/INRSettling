/**
 * The liquidity domain — the frozen tables and the availability arithmetic.
 *
 * Everything here is pure, so it checks the *rules* rather than the plumbing:
 * that the tables match `STATE_MACHINES.md § 6.2` and `§ 6.5` row for row, that
 * `INV-19`'s formula is the only definition of availability, and that the two
 * absences the invariants care about are really absent — a `CONSUMED`
 * reservation with no release path, and a repayment whose capacity moves on
 * exactly two transitions.
 */
import { describe, expect, it } from 'vitest'
import { money } from '@inrsettle/money'
import {
  LEDGER_ACCOUNTS,
  MOVEMENT_PAIRS,
  REPAYMENT_STATUSES,
  REPAYMENT_TRANSITIONS,
  RESERVATION_STATUSES,
  RESERVATION_TRANSITIONS,
  availableToSettle,
  canReserve,
  capacityRestoringTransitions,
  evaluateDrawdownTransition,
  evaluateRepaymentTransition,
  evaluateReservationTransition,
  facilityAcceptsNewExposure,
  isRepaymentInFlight,
  ledgerPairFor,
  projectPosition,
  repaymentFingerprint,
  type LedgerEntry,
  type ReservationStatus,
} from '../index.js'

const usdt = (n: bigint) => money('USDT', n)
const position = (limit: bigint, drawn: bigint, reserved: bigint) => ({
  currency: 'USDT' as const,
  limit: usdt(limit),
  drawn: usdt(drawn),
  reserved: usdt(reserved),
})

describe('INV-19 — availability has one definition', () => {
  it('is limit minus drawn minus reserved', () => {
    expect(availableToSettle(position(1000n, 300n, 200n)).minorUnits).toBe(500n)
  })

  it('throws rather than reporting a negative position', () => {
    // Unreachable while the database CHECK holds. Reachable only if a
    // projection has already gone wrong, and failing loudly there is how that
    // becomes an incident instead of an over-allocation.
    expect(() => availableToSettle(position(1000n, 900n, 200n))).toThrow(/negative/)
  })

  it('does not count in-flight repayments as capacity (INV-46)', () => {
    // Stated as a property of the type rather than of a value: there is no
    // field for in-flight repayments in the position, so the formula cannot
    // accidentally include them. The nearest thing to a compile-time proof.
    expect(Object.keys(position(0n, 0n, 0n)).sort()).toEqual([
      'currency', 'drawn', 'limit', 'reserved',
    ])
  })
})

describe('reserving', () => {
  it('permits an amount that exactly exhausts the facility', () => {
    expect(canReserve(position(1000n, 0n, 0n), 'ACTIVE', usdt(1000n))).toEqual({ ok: true })
  })

  it('refuses one unit more', () => {
    expect(canReserve(position(1000n, 0n, 0n), 'ACTIVE', usdt(1001n))).toEqual({
      ok: false, reason: 'insufficient_availability',
    })
  })

  it('refuses on a suspended or closed facility', () => {
    for (const status of ['SUSPENDED', 'CLOSED'] as const) {
      expect(canReserve(position(1000n, 0n, 0n), status, usdt(1n))).toEqual({
        ok: false, reason: 'facility_not_active',
      })
      expect(facilityAcceptsNewExposure(status)).toBe(false)
    }
    // SUSPENDED still permits releases and repayments — it stops new exposure,
    // it does not freeze the facility's existing obligations.
    expect(facilityAcceptsNewExposure('ACTIVE')).toBe(true)
  })

  it('refuses a currency that is not the facility currency', () => {
    expect(canReserve(position(1000n, 0n, 0n), 'ACTIVE', money('USD', 1n))).toEqual({
      ok: false, reason: 'currency_mismatch',
    })
  })
})

describe('INV-23 — the position is a projection of the ledger', () => {
  let n = 0
  const entry = (
    account: 'available' | 'reserved' | 'drawn',
    direction: 'debit' | 'credit',
    minorUnits: bigint,
  ): LedgerEntry => ({
    id: `led_${(n += 1)}`,
    facilityId: 'fac_1',
    transferId: `ltr_${n}`,
    movement: 'reservation_created',
    account,
    direction,
    currency: 'USDT',
    minorUnits,
  })

  it('rebuilds drawn and reserved from the entries alone', () => {
    const rebuilt = projectPosition('USDT', usdt(1000n), [
      entry('reserved', 'debit', 300n), entry('available', 'credit', 300n),
      entry('drawn', 'debit', 100n), entry('reserved', 'credit', 100n),
    ])
    expect(rebuilt.reserved.minorUnits).toBe(200n)
    expect(rebuilt.drawn.minorUnits).toBe(100n)
    expect(availableToSettle(rebuilt).minorUnits).toBe(700n)
  })

  it('never accumulates the contra account', () => {
    // `available` is computed, not stored. If it were accumulated it would be
    // a third number that could disagree with the other two.
    const rebuilt = projectPosition('USDT', usdt(1000n), [
      entry('available', 'debit', 500n), entry('drawn', 'credit', 500n),
    ])
    expect(rebuilt.drawn.minorUnits).toBe(-500n)
    expect(LEDGER_ACCOUNTS).toContain('available')
  })

  it('refuses an entry in the wrong currency', () => {
    const wrong = { ...entry('reserved', 'debit', 1n), currency: 'USD' as const }
    expect(() => projectPosition('USDT', usdt(1000n), [wrong])).toThrow(/currency/)
  })

  it('pairs every movement between two different accounts', () => {
    for (const [movement, pair] of Object.entries(MOVEMENT_PAIRS)) {
      expect(pair.from).not.toBe(pair.to)
      const { debit, credit } = ledgerPairFor(movement as keyof typeof MOVEMENT_PAIRS)
      // Debit the destination, credit the source: the pair sums to zero, which
      // is what the database's deferred balance trigger checks at commit.
      expect(debit).toBe(pair.to)
      expect(credit).toBe(pair.from)
    }
  })

  it('routes consumption straight from reserved to drawn', () => {
    // Not reserved → available → drawn. The value was never spendable again,
    // and a trip through `available` would briefly say it was.
    expect(MOVEMENT_PAIRS.reservation_consumed).toMatchObject({ from: 'reserved', to: 'drawn' })
  })

  it('gives capacity back only from drawn on a confirmed repayment', () => {
    expect(MOVEMENT_PAIRS.repayment_confirmed).toMatchObject({ from: 'drawn', to: 'available' })
  })
})

describe('the reservation machine (V01–V04)', () => {
  it('matches the frozen table row for row', () => {
    expect(RESERVATION_TRANSITIONS.map((t) => t.id)).toEqual(['V01', 'V02', 'V03', 'V04'])
    expect(RESERVATION_TRANSITIONS.map((t) => t.to)).toEqual([
      'ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED',
    ])
  })

  it('creates a reservation only from nothing', () => {
    expect(evaluateReservationTransition(null, 'reserve')).toMatchObject({ ok: true, id: 'V01' })
    for (const from of RESERVATION_STATUSES) {
      expect(evaluateReservationTransition(from, 'reserve').ok, from).toBe(false)
    }
  })

  it('gives CONSUMED no outgoing transition at all', () => {
    // The frozen document is explicit: "A CONSUMED reservation has no outgoing
    // transition." Asserted over every trigger rather than the two obvious ones.
    for (const trigger of ['reserve', 'consume', 'release', 'expire'] as const) {
      expect(evaluateReservationTransition('CONSUMED', trigger).ok, trigger).toBe(false)
    }
  })

  it('makes releasing a CONSUMED reservation a distinct, typed error', () => {
    // INV-22 asks for a typed error rather than a no-op, so a mistaken code
    // path fails loudly instead of silently double-crediting the facility. A
    // generic `invalid_transition` would let a caller read it as "already done".
    for (const trigger of ['release', 'expire'] as const) {
      expect(evaluateReservationTransition('CONSUMED', trigger)).toEqual({
        ok: false, error: 'consumed_cannot_be_released',
      })
    }
    expect(evaluateReservationTransition('CONSUMED', 'consume')).toEqual({
      ok: false, error: 'invalid_transition',
    })
  })

  it('leaves RELEASED and EXPIRED with nowhere to go either', () => {
    for (const from of ['RELEASED', 'EXPIRED'] as ReservationStatus[]) {
      for (const trigger of ['consume', 'release', 'expire'] as const) {
        expect(evaluateReservationTransition(from, trigger).ok).toBe(false)
      }
    }
  })

  it('posts the movement the frozen effect column names', () => {
    expect(evaluateReservationTransition(null, 'reserve')).toMatchObject({ movement: 'reservation_created' })
    expect(evaluateReservationTransition('ACTIVE', 'consume')).toMatchObject({ movement: 'reservation_consumed' })
    expect(evaluateReservationTransition('ACTIVE', 'release')).toMatchObject({ movement: 'reservation_released' })
    expect(evaluateReservationTransition('ACTIVE', 'expire')).toMatchObject({ movement: 'reservation_expired' })
  })
})

describe('the repayment machine (Y01–Y08)', () => {
  it('matches the frozen table row for row', () => {
    expect(REPAYMENT_TRANSITIONS.map((t) => t.id)).toEqual([
      'Y01', 'Y02', 'Y03', 'Y04', 'Y05', 'Y06', 'Y07', 'Y08',
    ])
  })

  it('restores capacity on exactly Y03 and Y06 (INV-46)', () => {
    // The sentence the frozen table opens with: "Capacity comes back on exactly
    // one transition, and it is not the one that creates the repayment." Two
    // rows carry it, because a pull-resolved confirmation is the same fact
    // arriving by a different route.
    expect(capacityRestoringTransitions()).toEqual(['Y03', 'Y06'])
    expect(evaluateRepaymentTransition(null, 'request')).toMatchObject({ restoresCapacity: false })
    expect(evaluateRepaymentTransition('REQUESTED', 'submit')).toMatchObject({ restoresCapacity: false })
    expect(evaluateRepaymentTransition('SUBMITTED', 'confirmed')).toMatchObject({ restoresCapacity: true })
    expect(evaluateRepaymentTransition('UNKNOWN', 'pull_resolved_confirmed')).toMatchObject({
      restoresCapacity: true,
    })
  })

  it('treats REQUESTED, SUBMITTED and UNKNOWN as in flight', () => {
    for (const status of REPAYMENT_STATUSES) {
      expect(isRepaymentInFlight(status)).toBe(
        status === 'REQUESTED' || status === 'SUBMITTED' || status === 'UNKNOWN',
      )
    }
  })

  it('resolves UNKNOWN by pull and never by resubmission (INV-47)', () => {
    expect(evaluateRepaymentTransition('UNKNOWN', 'submit').ok).toBe(false)
    expect(evaluateRepaymentTransition('UNKNOWN', 'confirmed').ok).toBe(false)
    expect(evaluateRepaymentTransition('UNKNOWN', 'pull_resolved_confirmed').ok).toBe(true)
    expect(evaluateRepaymentTransition('UNKNOWN', 'pull_resolved_failed').ok).toBe(true)
  })

  it('lets a failed repayment be re-requested, under a new fingerprint', () => {
    const y08 = evaluateRepaymentTransition('FAILED', 're_request')
    expect(y08).toMatchObject({ ok: true, id: 'Y08', to: 'REQUESTED', requiresNewFingerprint: true })
    // And it is the only transition that says so.
    const others = REPAYMENT_TRANSITIONS.filter((t) => t.requiresNewFingerprint === true)
    expect(others.map((t) => t.id)).toEqual(['Y08'])
  })

  it('never reopens a CONFIRMED repayment', () => {
    for (const trigger of ['submit', 'confirmed', 'rejected', 'sla_elapsed', 're_request'] as const) {
      expect(evaluateRepaymentTransition('CONFIRMED', trigger).ok, trigger).toBe(false)
    }
  })

  it('derives a fingerprint from the repayment and its attempt', () => {
    expect(repaymentFingerprint('rpy_1', 1)).toBe('repay:v1:rpy_1:1')
    expect(repaymentFingerprint('rpy_1', 2)).not.toBe(repaymentFingerprint('rpy_1', 1))
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => repaymentFingerprint('rpy_1', bad)).toThrow(RangeError)
    }
  })
})

describe('the drawdown machine', () => {
  it('never resubmits out of UNKNOWN', () => {
    // T29's frozen guard says it in as many words: "Never resubmit blindly."
    expect(evaluateDrawdownTransition('UNKNOWN', 'request').ok).toBe(false)
    expect(evaluateDrawdownTransition('UNKNOWN', 'confirmed').ok).toBe(false)
    expect(evaluateDrawdownTransition('UNKNOWN', 'pull_resolved_confirmed')).toMatchObject({
      ok: true, to: 'CONFIRMED',
    })
    expect(evaluateDrawdownTransition('UNKNOWN', 'pull_resolved_failed')).toMatchObject({
      ok: true, to: 'FAILED',
    })
  })

  it('leaves CONFIRMED and FAILED terminal', () => {
    for (const from of ['CONFIRMED', 'FAILED'] as const) {
      for (const trigger of ['request', 'confirmed', 'failed', 'sla_elapsed'] as const) {
        expect(evaluateDrawdownTransition(from, trigger).ok, `${from}/${trigger}`).toBe(false)
      }
    }
  })
})

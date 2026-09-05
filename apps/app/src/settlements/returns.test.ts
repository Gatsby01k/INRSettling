/**
 * Stage 6 — how a return reaches the customer's screen.
 *
 * `STATE_MACHINES.md § 8.5` spends four bullet points on this, and it spends
 * them because of the tension it names in the same breath: the settlement stays
 * `SETTLED`, so a customer scanning a list would otherwise see nothing wrong
 * with a payment whose money came back. The mitigation is not to soften
 * `SETTLED` — it is to make the return impossible to miss beside it.
 */
import { describe, expect, it } from 'vitest'
import {
  presentSettlement,
  returnNotice,
  summariseReturns,
  type ReturnViewInput,
} from './view-models.js'

const at = new Date('2026-09-03T10:00:00Z')
const a = (status: ReturnViewInput['status'], amountMinor = 500_000_000n): ReturnViewInput => ({
  id: `ret_${status}`, status, amountMinor, reasonCode: 'RAIL_REVERSAL', observedAt: at,
})

describe('a return has its own state, beside a settlement whose state has not changed', () => {
  it('shows the four labels § 8.5 names, and no others', () => {
    expect(returnNotice(a('OBSERVED')).label).toBe('Return reported')
    expect(returnNotice(a('CONFIRMED')).label).toBe('Return confirmed')
    expect(returnNotice(a('REPAID')).label).toBe('Funds released')
    expect(returnNotice(a('REJECTED')).label).toBe('Return not upheld')
  })

  it('shows MANUAL_REVIEW as "Return reported", not as a fifth label', () => {
    // The customer's situation while an operator looks at it is the same as
    // while the check runs: a return is reported and nothing is settled about
    // it. A fifth label would tell them about our queue rather than their money.
    expect(returnNotice(a('MANUAL_REVIEW'))).toMatchObject({
      label: 'Return reported', tone: 'attention', open: true,
    })
  })

  it('carries the amount, the date and a sentence — the fields § 8.5 lists', () => {
    const notice = returnNotice(a('CONFIRMED', 200_000_000n))
    expect(notice.amountMinor).toBe(200_000_000n)
    expect(notice.observedAt).toBe(at)
    expect(notice.detail.length).toBeGreaterThan(20)
  })

  it('does not touch the settlement’s own badge', () => {
    // The whole point. The settlement is SETTLED and its badge says so; the
    // return is a second, separate fact shown next to it.
    const presentation = presentSettlement({
      status: 'SETTLED', pointOfNoReturnAt: new Date(), cancellationRequestedAt: null,
    })
    expect(presentation.customerStatus).toBe('SETTLED')
    expect(presentation.badge?.label).toBe('Settled')
    // And nothing in the return view can reach the settlement's tone scale.
    expect(['attention', 'resolved']).toContain(returnNotice(a('CONFIRMED')).tone)
  })

  // GATE-EXEMPT+6: this case is *about* the prohibition — it lists the forbidden
  // words in order to assert none of them appears in the copy.
  it('never says a settled settlement is provisional, pending or on hold', () => {
    for (const status of ['OBSERVED', 'CONFIRMED', 'REPAID', 'REJECTED', 'MANUAL_REVIEW'] as const) {
      const text = `${returnNotice(a(status)).label} ${returnNotice(a(status)).detail}`.toLowerCase()
      for (const word of ['provisional', 'not final', 'pending final', 'on hold', 'countdown']) {
        expect(text, `${status}: "${word}"`).not.toContain(word)
      }
    }
  })
})

describe('the list markers and the two filters', () => {
  it('marks a row whose payment came back', () => {
    expect(summariseReturns([a('CONFIRMED')])).toMatchObject({
      hasOpenReturn: true, hasConfirmedReturn: true, marker: 'returned',
    })
  })

  it('marks a reported-but-unconfirmed return differently', () => {
    // Reported is not the same as returned, and a row that said "returned" on
    // the strength of an unverified provider report would be telling a customer
    // their money came back before we had checked (INV-40).
    expect(summariseReturns([a('OBSERVED')])).toMatchObject({
      hasOpenReturn: true, hasConfirmedReturn: false, marker: 'return_reported',
    })
  })

  it('counts REPAID as confirmed — "which of my payments came back" includes those', () => {
    expect(summariseReturns([a('REPAID')])).toMatchObject({
      hasOpenReturn: false, hasConfirmedReturn: true, marker: 'returned',
    })
  })

  it('a return that was not upheld leaves no marker', () => {
    expect(summariseReturns([a('REJECTED')])).toMatchObject({
      hasOpenReturn: false, hasConfirmedReturn: false, marker: null,
    })
  })

  it('a settlement with no returns is unmarked', () => {
    expect(summariseReturns([])).toMatchObject({
      hasOpenReturn: false, hasConfirmedReturn: false, marker: null,
    })
  })

  it('several returns summarise to the strongest marker', () => {
    expect(summariseReturns([a('REJECTED'), a('CONFIRMED'), a('OBSERVED')]).marker).toBe('returned')
  })
})

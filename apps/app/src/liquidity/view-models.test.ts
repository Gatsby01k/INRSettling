/**
 * The customer-facing half of Stage 4, which is one number and one sentence.
 *
 * The two things worth testing are both about *absence*: a workspace with no
 * facility shows no figure rather than a zero, and money on its way back to the
 * facility is not counted as available.
 */
import { describe, expect, it } from 'vitest'
import { money } from '@inrsettle/money'
import {
  liquidityRequirementCopy,
  presentAvailability,
  returningLiquidityNote,
} from './view-models.js'

describe('Available to settle', () => {
  it('shows the figure when a facility is enabled', () => {
    const p = presentAvailability({ availableToSettle: money('USDT', 12_500_000n) })
    expect(p.shown).toBe(true)
    expect(p.label).toBe('Available to settle')
    expect(p.amount).toContain('12.5')
    expect(p.setupNote).toBeNull()
  })

  it('shows nothing — not zero — before a facility exists', () => {
    // "You can settle nothing" and "we have not set this up yet" are different
    // things to tell someone. A zero says the first during onboarding, which is
    // both wrong and discouraging at precisely the wrong moment.
    const p = presentAvailability({ availableToSettle: null })
    expect(p.shown).toBe(false)
    expect(p.amount).toBeNull()
    expect(p.setupNote).toMatch(/set up/)
  })

  it('shows zero as zero when the facility is genuinely exhausted', () => {
    const p = presentAvailability({ availableToSettle: money('USDT', 0n) })
    expect(p.shown).toBe(true)
    expect(p.amount).not.toBeNull()
  })
})

describe('the vocabulary the customer reads', () => {
  // Everything a customer reads, and nothing they do not. `code` is excluded
  // on purpose: `liquidity_facility_required` is a stable wire identifier that
  // an integrator matches on, not a sentence anyone is shown — the same
  // distinction the build gate draws when it skips snake_case literals.
  const { title, detail, action } = liquidityRequirementCopy()
  const allCopy = [
    presentAvailability({ availableToSettle: null }).setupNote ?? '',
    presentAvailability({ availableToSettle: money('USDT', 1n) }).label,
    returningLiquidityNote(),
    title, detail, action,
  ].join(' ').toLowerCase()

  it('never says balance, wallet, credit, loan or limit', () => {
    // The build gate checks the whole tree; this checks the strings this module
    // actually produces, which is the part a reader of *this* file can verify.
    for (const word of ['balance', 'wallet', 'credit', 'loan', 'limit']) { // liquidity-copy:allow — the prohibition itself
      expect(allCopy, word).not.toContain(word)
    }
  })

  it('never names the mechanism', () => {
    for (const word of ['facility', 'drawdown', 'reservation', 'repayment', 'provider']) { // liquidity-copy:allow
      expect(allCopy, word).not.toContain(word)
    }
  })

  it('says Available to settle, in those words', () => {
    expect(presentAvailability({ availableToSettle: money('USDT', 1n) }).label).toBe(
      'Available to settle',
    )
  })
})

describe('the returning-liquidity note', () => {
  it('explains a reduced figure without promising it back yet', () => {
    // INV-46: the capacity genuinely is not back. The sentence has to be honest
    // about the condition — "once the funds are confirmed" — rather than
    // implying the money is already available again.
    const note = returningLiquidityNote()
    expect(note).toMatch(/once/)
    expect(note).toMatch(/confirmed/)
    expect(note).toMatch(/available again/)
  })
})

describe('the liquidity requirement (D-10, closed)', () => {
  it('carries all four fields a blocking requirement needs', () => {
    const r = liquidityRequirementCopy()
    expect(r.code).toBe('liquidity_facility_required')
    expect(r.title.length).toBeGreaterThan(11)
    expect(r.detail.length).toBeGreaterThan(23)
    expect(r.action.length).toBeGreaterThan(0)
  })

  it('says sandbox still works, so the customer is not simply blocked', () => {
    expect(liquidityRequirementCopy().detail.toLowerCase()).toContain('sandbox')
  })
})

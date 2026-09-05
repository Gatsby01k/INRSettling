/**
 * The customer projection, the exception taxonomy, and the frozen instruction.
 */
import { describe, expect, it } from 'vitest'
import { fxRateFromDecimalString, money } from '@inrsettle/money'
import {
  CUSTOMER_STATUSES,
  EXCEPTION_CODES,
  EXCEPTION_TAXONOMY,
  SETTLEMENT_STATUSES,
  authorizedTermsHash,
  canonicalInstruction,
  cancellationAffordance,
  customerStatusColumn,
  exceptionDefinition,
  freezeInstruction,
  instructionMatchesHash,
  isCustomerActionable,
  isExceptionCode,
  projectCustomerStatus,
  type ExceptionCode,
} from '../index.js'

const NOW = new Date('2026-09-02T10:00:00Z')
const RATE = fxRateFromDecimalString('USDT/INR', '88.4210000000', NOW, 'sandbox')

describe('the customer projection — STATE_MACHINES.md § 5', () => {
  it('is total: every internal status projects', () => {
    for (const status of SETTLEMENT_STATUSES) {
      const p = projectCustomerStatus({ status, openExceptionCode: 'LIQUIDITY_UNAVAILABLE' })
      if (p.listed) expect(CUSTOMER_STATUSES as readonly string[], status).toContain(p.customerStatus)
      else expect(p.customerStatus, status).toBeNull()
    }
  })

  it('DRAFT is not a customer state', () => {
    expect(projectCustomerStatus({ status: 'DRAFT' })).toEqual({ customerStatus: null, listed: false })
    expect(customerStatusColumn({ status: 'DRAFT' })).toBeNull()
  })

  it('PREFLIGHTING, READY and QUOTED all read as READY', () => {
    for (const status of ['PREFLIGHTING', 'READY', 'QUOTED'] as const) {
      expect(customerStatusColumn({ status }), status).toBe('READY')
    }
  })

  it('the whole execution span is one customer state', () => {
    for (const status of [
      'AUTHORIZED', 'LIQUIDITY_RESERVING', 'LIQUIDITY_RESERVED', 'DRAWDOWN_REQUESTED',
      'DRAWDOWN_CONFIRMED', 'PAYOUT_SUBMITTED', 'PAYOUT_CONFIRMED', 'RECONCILING',
    ] as const) {
      expect(customerStatusColumn({ status }), status).toBe('SETTLING')
    }
  })

  it('a customer-actionable exception projects to ACTION_REQUIRED', () => {
    for (const code of EXCEPTION_CODES.filter(isCustomerActionable)) {
      expect(customerStatusColumn({ status: 'EXCEPTION', openExceptionCode: code }), code).toBe(
        'ACTION_REQUIRED',
      )
    }
  })

  it('a non-actionable exception projects to SETTLING with delay context', () => {
    for (const code of EXCEPTION_CODES.filter((c) => !isCustomerActionable(c))) {
      const p = projectCustomerStatus({ status: 'EXCEPTION', openExceptionCode: code })
      expect(p.customerStatus, code).toBe('SETTLING')
      expect(p.listed && p.delayed, code).toBe(true)
    }
  })

  it('an exception with no recorded code is not shown as actionable', () => {
    // We would be telling the customer to fix something we cannot name.
    const p = projectCustomerStatus({ status: 'EXCEPTION', openExceptionCode: null })
    expect(p.customerStatus).toBe('SETTLING')
  })

  it('FAILED and CANCELLED both read as CANCELLED (D-03, closed)', () => {
    expect(customerStatusColumn({ status: 'FAILED' })).toBe('CANCELLED')
    expect(customerStatusColumn({ status: 'CANCELLED' })).toBe('CANCELLED')
  })

  it('customer-facing ACTION_REQUIRED has exactly two sources', () => {
    const sources = SETTLEMENT_STATUSES.filter(
      (s) => customerStatusColumn({ status: s, openExceptionCode: 'PAYOUT_REJECTED_DESTINATION' }) === 'ACTION_REQUIRED',
    )
    expect(sources.sort()).toEqual(['ACTION_REQUIRED', 'EXCEPTION'])
  })

  it('there is no sixth customer state', () => {
    expect(CUSTOMER_STATUSES).toHaveLength(5)
  })
})

describe('the cancellation affordance', () => {
  const base = { pointOfNoReturnAt: null, cancellationRequestedAt: null }

  it('offers immediate cancellation before authorization', () => {
    for (const status of ['DRAFT', 'READY', 'QUOTED', 'ACTION_REQUIRED'] as const) {
      expect(cancellationAffordance({ ...base, status }), status).toBe('cancel')
    }
  })

  it('offers a cancellation request after authorization', () => {
    for (const status of [
      'AUTHORIZED', 'LIQUIDITY_RESERVING', 'LIQUIDITY_RESERVED',
      'DRAWDOWN_REQUESTED', 'DRAWDOWN_CONFIRMED',
    ] as const) {
      expect(cancellationAffordance({ ...base, status }), status).toBe('request_cancellation')
    }
  })

  it('offers nothing past the point of no return, whatever the status', () => {
    for (const status of SETTLEMENT_STATUSES) {
      expect(
        cancellationAffordance({ status, pointOfNoReturnAt: NOW, cancellationRequestedAt: null }),
        status,
      ).toBe('none')
    }
  })

  it('shows a pending request rather than offering it twice', () => {
    expect(
      cancellationAffordance({ status: 'AUTHORIZED', pointOfNoReturnAt: null, cancellationRequestedAt: NOW }),
    ).toBe('requested')
  })

  it('offers nothing once the settlement is terminal', () => {
    for (const status of ['SETTLED', 'FAILED', 'CANCELLED'] as const) {
      expect(cancellationAffordance({ ...base, status }), status).toBe('none')
    }
  })
})

describe('the exception taxonomy is closed', () => {
  it('has exactly the ten frozen codes and no OTHER', () => {
    expect(EXCEPTION_CODES).toHaveLength(10)
    expect(EXCEPTION_CODES as readonly string[]).not.toContain('OTHER')
    expect(EXCEPTION_TAXONOMY).toHaveLength(10)
  })

  it('every code has a phase, an actionability and a resolution path', () => {
    for (const code of EXCEPTION_CODES) {
      const d = exceptionDefinition(code)
      expect(d.phase, code).toBeTruthy()
      expect(typeof d.customerActionable, code).toBe('boolean')
      expect(d.resolutionPath.length, code).toBeGreaterThan(10)
    }
  })

  it('matches the frozen actionability classification exactly', () => {
    const actionable = EXCEPTION_CODES.filter(isCustomerActionable).sort()
    expect(actionable).toEqual(['PAYOUT_REJECTED_COMPLIANCE', 'PAYOUT_REJECTED_DESTINATION'])
  })

  it('rejects a code outside the taxonomy rather than defaulting', () => {
    expect(isExceptionCode('SOMETHING_NEW')).toBe(false)
    expect(isExceptionCode('OTHER')).toBe(false)
    expect(() => exceptionDefinition('OTHER' as ExceptionCode)).toThrow(/closed taxonomy/)
  })
})

/* ── The frozen instruction ────────────────────────────────────────────── */

const QUOTE = {
  id: 'qt_1',
  direction: 'RECIPIENT_FIRST' as const,
  recipientAmount: money('INR', 500_000_000n),
  fundingAmount: money('USDT', 56_547_652_707n),
  fxRate: { pair: 'USDT/INR', rateScaled: RATE.rateScaled, scale: 10, quotedAt: NOW },
  feeComponents: [
    { code: 'service', label: 'Service fee', amount: money('USDT', 197_916_785n) },
    { code: 'network', label: 'Network fee', amount: money('USDT', 250_000n) },
  ],
  roundingResidual: { currency: 'USDT' as const, amount: '0.000000063865', scale: 12 as const },
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 120_000),
}

const ARGS = {
  beneficiaryId: 'ben_1',
  destinationId: 'dst_1',
  destinationVersionId: 'dvr_1',
  purposeCode: 'SOFTWARE_SERVICES',
  quote: QUOTE,
}

describe('AuthorizedTerms and its hash', () => {
  it('captures every field the frozen model names', () => {
    const { instruction } = freezeInstruction(ARGS)
    expect(instruction.beneficiaryId).toBe('ben_1')
    expect(instruction.destinationVersionId).toBe('dvr_1')
    expect(instruction.recipientAmount.minorUnits).toBe(500_000_000n)
    expect(instruction.purposeCode).toBe('SOFTWARE_SERVICES')
    expect(instruction.fundingCurrency).toBe('USDT')
    expect(instruction.terms.quoteId).toBe('qt_1')
    expect(instruction.terms.fundingAmount.minorUnits).toBe(56_547_652_707n)
    expect(instruction.terms.fxRate.rateScaled).toBe('884210000000')
    expect(instruction.terms.feeComponents).toHaveLength(2)
    expect(instruction.terms.roundingResidual.amount).toBe('0.000000063865')
    expect(instruction.terms.expiresAt).toBe(QUOTE.expiresAt.toISOString())
  })

  it('carries the rate as an integer string, never a float', () => {
    const { instruction } = freezeInstruction(ARGS)
    expect(typeof instruction.terms.fxRate.rateScaled).toBe('string')
    expect(canonicalInstruction(instruction)).not.toMatch(/88\.421[^0]/)
  })

  it('serialises minor units as strings (INV-04)', () => {
    const canonical = canonicalInstruction(freezeInstruction(ARGS).instruction)
    expect(canonical).toContain('"minor_units":"500000000"')
    expect(canonical).not.toMatch(/"minor_units":\d/)
  })

  it('is stable across repeated freezes of the same inputs', () => {
    expect(freezeInstruction(ARGS).hash).toBe(freezeInstruction(ARGS).hash)
  })

  it('does not depend on the order fees were assembled in', () => {
    const reversed = { ...ARGS, quote: { ...QUOTE, feeComponents: [...QUOTE.feeComponents].reverse() } }
    expect(freezeInstruction(reversed).hash).toBe(freezeInstruction(ARGS).hash)
  })

  it('changes when any economically meaningful field changes', () => {
    const base = freezeInstruction(ARGS).hash
    const variants = [
      { ...ARGS, beneficiaryId: 'ben_2' },
      { ...ARGS, destinationId: 'dst_2' },
      { ...ARGS, destinationVersionId: 'dvr_2' },
      { ...ARGS, purposeCode: 'GOODS_EXPORT' },
      { ...ARGS, quote: { ...QUOTE, recipientAmount: money('INR', 500_000_001n) } },
      { ...ARGS, quote: { ...QUOTE, fundingAmount: money('USDT', 56_547_652_708n) } },
      { ...ARGS, quote: { ...QUOTE, fxRate: { ...QUOTE.fxRate, rateScaled: 884_210_000_001n } } },
      { ...ARGS, quote: { ...QUOTE, feeComponents: [] } },
      { ...ARGS, quote: { ...QUOTE, expiresAt: new Date(NOW.getTime() + 121_000) } },
      { ...ARGS, quote: { ...QUOTE, id: 'qt_2' } },
    ]
    for (const [i, v] of variants.entries()) {
      expect(freezeInstruction(v).hash, `variant ${i}`).not.toBe(base)
    }
  })

  it('a hash over the economics alone would not have caught a repointed beneficiary', () => {
    // The reason the hash covers the whole instruction and not just the terms.
    const a = freezeInstruction(ARGS)
    const b = freezeInstruction({ ...ARGS, beneficiaryId: 'ben_attacker' })
    const terms = (i: typeof a) =>
      JSON.stringify(i.instruction.terms, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(terms(a)).toBe(terms(b))
    expect(a.hash).not.toBe(b.hash)
  })

  it('verifies an instruction against a recorded hash', () => {
    const { instruction, hash } = freezeInstruction(ARGS)
    expect(instructionMatchesHash(instruction, hash)).toBe(true)
    const tampered = { ...instruction, destinationVersionId: 'dvr_evil' }
    expect(instructionMatchesHash(tampered, hash)).toBe(false)
  })

  it('recomputes rather than trusting a stored hash', () => {
    // A row whose fields were changed *and* whose hash was updated to match
    // still fails against the hash recorded at authorization.
    const original = freezeInstruction(ARGS)
    const rewritten = freezeInstruction({ ...ARGS, destinationVersionId: 'dvr_evil' })
    expect(instructionMatchesHash(rewritten.instruction, rewritten.hash)).toBe(true)
    expect(instructionMatchesHash(rewritten.instruction, original.hash)).toBe(false)
  })

  it('is a hex sha256', () => {
    expect(authorizedTermsHash(freezeInstruction(ARGS).instruction)).toMatch(/^[0-9a-f]{64}$/)
  })
})

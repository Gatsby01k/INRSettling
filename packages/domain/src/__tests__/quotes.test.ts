import { describe, expect, it } from 'vitest'
import { fxRateFromDecimalString, money } from '@inrsettle/money'
import {
  QUOTE_STATUSES,
  QUOTE_TRANSITIONS,
  QUOTE_TRIGGERS,
  SANDBOX_PRICING,
  PricingError,
  checkQuoteAttachable,
  checkQuoteAuthorizable,
  computeFees,
  evaluateQuoteTransition,
  isQuoteExpiredAt,
  isQuoteTerminal,
  priceQuote,
  sandboxRateFor,
  validatePricingConfig,
  type Quote,
  type QuoteStatus,
} from '../index.js'

const NOW = new Date('2026-09-02T10:00:00Z')
const RATE = fxRateFromDecimalString('USDT/INR', '88.4210000000', NOW, 'sandbox')

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: 'qt_1',
    workspaceId: 'ws_a',
    environment: 'sandbox',
    direction: 'RECIPIENT_FIRST',
    recipientAmount: money('INR', 500_000_000n),
    fundingAmount: money('USDT', 56_547_652_707n),
    fxRate: RATE,
    feeComponents: [],
    roundingResidual: { currency: 'USDT', amount: '0.000000063865', scale: 12 },
    estimatedDelivery: 'under 30 minutes',
    status: 'ACTIVE',
    expiresAt: new Date(NOW.getTime() + 120_000),
    createdAt: NOW,
    lockedAt: null,
    consumedBySettlementId: null,
    pricingVersion: SANDBOX_PRICING.version,
    ...overrides,
  }
}

const SETTLEMENT = {
  workspaceId: 'ws_a',
  environment: 'sandbox' as const,
  recipientAmount: money('INR', 500_000_000n),
  fundingCurrency: 'USDT',
}

describe('the quote lifecycle — Q01 to Q05', () => {
  it('matches the frozen table', () => {
    expect(QUOTE_TRANSITIONS.map((t) => t.id)).toEqual(['Q01', 'Q02', 'Q03', 'Q04', 'Q05'])
  })

  it('runs ACTIVE → LOCKED → CONSUMED', () => {
    expect(evaluateQuoteTransition(null, 'create')).toMatchObject({ ok: true, to: 'ACTIVE' })
    expect(evaluateQuoteTransition('ACTIVE', 'lock')).toMatchObject({ ok: true, to: 'LOCKED' })
    expect(evaluateQuoteTransition('LOCKED', 'consume')).toMatchObject({ ok: true, to: 'CONSUMED' })
  })

  it('expires and voids from both ACTIVE and LOCKED', () => {
    for (const from of ['ACTIVE', 'LOCKED'] as const) {
      expect(evaluateQuoteTransition(from, 'expire')).toMatchObject({ ok: true, to: 'EXPIRED' })
      expect(evaluateQuoteTransition(from, 'void')).toMatchObject({ ok: true, to: 'VOID' })
    }
  })

  it('cannot consume without locking first', () => {
    expect(evaluateQuoteTransition('ACTIVE', 'consume').ok).toBe(false)
  })

  it('rejects every trigger from a terminal quote status', () => {
    for (const from of ['CONSUMED', 'EXPIRED', 'VOID'] as const) {
      expect(isQuoteTerminal(from)).toBe(true)
      for (const trigger of QUOTE_TRIGGERS) {
        expect(evaluateQuoteTransition(from, trigger).ok, `${from}::${trigger}`).toBe(false)
      }
    }
  })

  it('the exhaustive quote matrix accepts only the frozen pairs', () => {
    const legal = new Set<string>()
    for (const t of QUOTE_TRANSITIONS) {
      if (t.from.length === 0) legal.add(`—::${t.trigger}`)
      for (const f of t.from) legal.add(`${f}::${t.trigger}`)
    }
    for (const from of [null, ...QUOTE_STATUSES] as (QuoteStatus | null)[]) {
      for (const trigger of QUOTE_TRIGGERS) {
        const key = `${from ?? '—'}::${trigger}`
        expect(evaluateQuoteTransition(from, trigger).ok, key).toBe(legal.has(key))
      }
    }
  })
})

describe('attachability (T06)', () => {
  it('accepts a matching active quote', () => {
    expect(checkQuoteAttachable(quote(), SETTLEMENT, NOW)).toEqual([])
  })

  it('refuses a quote from another workspace or environment', () => {
    expect(checkQuoteAttachable(quote({ workspaceId: 'ws_b' }), SETTLEMENT, NOW)).toContain(
      'quote_wrong_workspace',
    )
    expect(checkQuoteAttachable(quote({ environment: 'live' }), SETTLEMENT, NOW)).toContain(
      'quote_wrong_environment',
    )
  })

  it('refuses a quote for a different amount or currency', () => {
    expect(
      checkQuoteAttachable(quote({ recipientAmount: money('INR', 1n) }), SETTLEMENT, NOW),
    ).toContain('quote_amount_mismatch')
    expect(
      checkQuoteAttachable(quote({ fundingAmount: money('USD', 1n) }), SETTLEMENT, NOW),
    ).toContain('quote_currency_mismatch')
  })

  it('refuses a consumed or void quote', () => {
    expect(checkQuoteAttachable(quote({ status: 'CONSUMED' }), SETTLEMENT, NOW)).toContain('quote_consumed')
    expect(checkQuoteAttachable(quote({ status: 'VOID' }), SETTLEMENT, NOW)).toContain('quote_void')
  })

  it('refuses an expired quote by the clock, not only by the status flag', () => {
    // INV-15: expiry is evaluated server-side. A quote still marked ACTIVE
    // because the sweeper has not run yet is still expired.
    const late = new Date(NOW.getTime() + 121_000)
    expect(checkQuoteAttachable(quote(), SETTLEMENT, late)).toContain('quote_expired')
    expect(isQuoteExpiredAt(quote(), late)).toBe(true)
    expect(isQuoteExpiredAt(quote(), NOW)).toBe(false)
  })

  it('is not expired exactly at the boundary', () => {
    const exact = new Date(NOW.getTime() + 120_000)
    expect(isQuoteExpiredAt(quote(), exact)).toBe(false)
  })
})

describe('authorizability (T08)', () => {
  it('accepts a locked, unexpired, unconsumed quote', () => {
    expect(checkQuoteAuthorizable(quote({ status: 'LOCKED' }), SETTLEMENT, NOW)).toEqual([])
  })

  it('refuses EXPIRED, VOID and CONSUMED (INV-15)', () => {
    expect(checkQuoteAuthorizable(quote({ status: 'EXPIRED' }), SETTLEMENT, NOW)).toContain('quote_expired')
    expect(checkQuoteAuthorizable(quote({ status: 'VOID' }), SETTLEMENT, NOW)).toContain('quote_void')
    expect(checkQuoteAuthorizable(quote({ status: 'CONSUMED' }), SETTLEMENT, NOW)).toContain('quote_consumed')
  })
})

describe('pricing configuration — D-08 and D-09 stay open', () => {
  it('the shipped configuration is a labelled sandbox fixture', () => {
    expect(SANDBOX_PRICING.source).toBe('sandbox_fixture')
    expect(SANDBOX_PRICING.description).toMatch(/NOT A COMMERCIAL COMMITMENT/)
    expect(SANDBOX_PRICING.description).toMatch(/D-08/)
    expect(SANDBOX_PRICING.description).toMatch(/D-09/)
    expect(validatePricingConfig(SANDBOX_PRICING)).toEqual([])
  })

  it('refuses to price a live quote against sandbox configuration', () => {
    // The commercial equivalent of the verification registry refusing to fall
    // back to the simulator in live.
    expect(() =>
      priceQuote({
        config: SANDBOX_PRICING,
        environment: 'live',
        direction: 'RECIPIENT_FIRST',
        recipientAmount: money('INR', 100n),
        rate: RATE,
        now: NOW,
      }),
    ).toThrow(PricingError)
  })

  it('rejects a sandbox fixture that does not disclose what it is', () => {
    const defects = validatePricingConfig({ ...SANDBOX_PRICING, description: 'Our pricing.' })
    expect(defects).toContainEqual({ problem: 'description_does_not_disclose_status' })
  })

  it('rejects a malformed fee rule and a duplicate fee code', () => {
    expect(
      validatePricingConfig({
        ...SANDBOX_PRICING,
        feeRules: [{ kind: 'basis_points', code: 'x', label: 'X', bps: -1 }],
      }),
    ).toContainEqual({ problem: 'fee_rule_invalid', code: 'x' })
    expect(
      validatePricingConfig({ ...SANDBOX_PRICING, feeRules: [...SANDBOX_PRICING.feeRules, ...SANDBOX_PRICING.feeRules] }),
    ).toContainEqual({ problem: 'duplicate_fee_code', code: 'network' })
  })
})

describe('fees — INV-07', () => {
  it('computes flat and basis-point components separately', () => {
    const fees = computeFees(SANDBOX_PRICING, money('USDT', 56_547_652_707n))
    expect(fees.map((f) => f.code)).toEqual(['network', 'service'])
    expect(fees[0]!.amount.minorUnits).toBe(250_000n)
    // 35bp of 56,547,652,707 = 197,916,784.4745 → rounds up.
    expect(fees[1]!.amount.minorUnits).toBe(197_916_785n)
  })

  it('rounds basis points up, so a fee is never lost to rounding', () => {
    const fees = computeFees(
      { ...SANDBOX_PRICING, feeRules: [{ kind: 'basis_points', code: 'x', label: 'X', bps: 1 }] },
      money('USDT', 1n),
    )
    expect(fees[0]!.amount.minorUnits).toBe(1n)
  })

  it('keeps fees in the funding currency, never folded into the rate', () => {
    const priced = priceQuote({
      config: SANDBOX_PRICING,
      environment: 'sandbox',
      direction: 'RECIPIENT_FIRST',
      recipientAmount: money('INR', 500_000_000n),
      rate: RATE,
      now: NOW,
    })
    expect(priced.fxRate.rateScaled).toBe(RATE.rateScaled)
    for (const fee of priced.feeComponents) expect(fee.amount.currency).toBe('USDT')
  })
})

describe('pricing a quote', () => {
  it('is recipient-first by default and leaves the recipient amount exact', () => {
    const priced = priceQuote({
      config: SANDBOX_PRICING,
      environment: 'sandbox',
      direction: 'RECIPIENT_FIRST',
      recipientAmount: money('INR', 500_000_000n),
      rate: RATE,
      now: NOW,
    })
    expect(priced.direction).toBe('RECIPIENT_FIRST')
    expect(priced.recipientAmount.minorUnits).toBe(500_000_000n)
    expect(priced.fundingAmount.minorUnits).toBe(56_547_652_707n)
  })

  it('sets expiry from the configured window on the supplied clock', () => {
    const priced = priceQuote({
      config: SANDBOX_PRICING,
      environment: 'sandbox',
      direction: 'RECIPIENT_FIRST',
      recipientAmount: money('INR', 100n),
      rate: RATE,
      now: NOW,
    })
    expect(priced.expiresAt.getTime() - NOW.getTime()).toBe(SANDBOX_PRICING.validitySeconds * 1000)
  })

  it('prices source-first when asked', () => {
    const priced = priceQuote({
      config: SANDBOX_PRICING,
      environment: 'sandbox',
      direction: 'SOURCE_FIRST',
      fundingAmount: money('USDT', 1_000_000n),
      rate: RATE,
      now: NOW,
    })
    expect(priced.direction).toBe('SOURCE_FIRST')
    expect(priced.fundingAmount.minorUnits).toBe(1_000_000n)
  })

  it('refuses a direction without its authoritative side (INV-08)', () => {
    expect(() =>
      priceQuote({ config: SANDBOX_PRICING, environment: 'sandbox', direction: 'RECIPIENT_FIRST', rate: RATE, now: NOW }),
    ).toThrow(/requires a recipient amount/)
    expect(() =>
      priceQuote({ config: SANDBOX_PRICING, environment: 'sandbox', direction: 'SOURCE_FIRST', rate: RATE, now: NOW }),
    ).toThrow(/requires a funding amount/)
  })

  it('records which pricing version produced it', () => {
    const priced = priceQuote({
      config: SANDBOX_PRICING,
      environment: 'sandbox',
      direction: 'RECIPIENT_FIRST',
      recipientAmount: money('INR', 100n),
      rate: RATE,
      now: NOW,
    })
    expect(priced.pricingVersion).toBe('sandbox-pricing-1')
  })

  it('offers a deterministic sandbox rate for every supported funding currency', () => {
    for (const currency of ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'AED', 'SGD'] as const) {
      expect(sandboxRateFor(currency), currency).toBeTruthy()
    }
  })
})

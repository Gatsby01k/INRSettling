/**
 * The money path is the highest-risk primitive in the system, so these are
 * property tests as well as example tests: the frozen worked example must come
 * out exactly, and the integer rounding property must hold across a wide sweep
 * of amounts and rates.
 */
import { describe, expect, it } from 'vitest'
import {
  ZERO_RESIDUAL,
  formatFxRate,
  fundingForRecipient,
  fxRateFromDecimalString,
  money,
  moneyFromDecimalString,
  recipientForFunding,
  totalFees,
  verifyRecipientFirst,
  verifySourceFirst,
} from './index.js'

const QUOTED = new Date('2026-09-02T10:00:00Z')
const USDT_INR = fxRateFromDecimalString('USDT/INR', '88.4210000000', QUOTED, 'sandbox')

describe('rate representation', () => {
  it('parses and reprints at scale 10 without loss', () => {
    expect(USDT_INR.rateScaled).toBe(884210000000n)
    expect(formatFxRate(USDT_INR)).toBe('88.4210000000')
  })

  it('pads a short fraction rather than misreading it', () => {
    expect(fxRateFromDecimalString('USD/INR', '83.5', QUOTED, 's').rateScaled).toBe(835000000000n)
  })

  it('refuses more precision than the scale can hold, rather than truncating', () => {
    expect(() => fxRateFromDecimalString('USD/INR', '83.12345678901', QUOTED, 's')).toThrow()
  })

  it('refuses a non-positive rate', () => {
    expect(() => fxRateFromDecimalString('USD/INR', '0', QUOTED, 's')).toThrow()
  })
})

describe('the frozen worked example — DOMAIN.md § 3.3', () => {
  const conversion = fundingForRecipient(moneyFromDecimalString('INR', '5000000.00'), USDT_INR)

  it('charges exactly 56,547,652,707 USDT minor units', () => {
    expect(conversion.fundingAmount.minorUnits).toBe(56_547_652_707n)
    expect(conversion.fundingAmount.currency).toBe('USDT')
  })

  it('leaves the recipient amount untouched (INV-05)', () => {
    expect(conversion.recipientAmount.minorUnits).toBe(500_000_000n)
  })

  it('discloses the residual the document states', () => {
    // 0.0000000638649… USDT, disclosed at scale 12.
    expect(conversion.roundingResidual).toEqual({
      currency: 'USDT',
      amount: '0.000000063865',
      scale: 12,
    })
  })

  it('satisfies the exact integer rounding property', () => {
    expect(verifyRecipientFirst(conversion)).toBe(true)
  })
})

describe('INV-06 — funding always rounds up', () => {
  it('never charges less than the exact requirement', () => {
    for (const rateText of ['88.4210000000', '83.1234567891', '1.0000000001', '0.0000000001', '99999.9999999999']) {
      const rate = fxRateFromDecimalString('USDT/INR', rateText, QUOTED, 'sandbox')
      for (const paise of [1n, 7n, 99n, 100n, 12_345n, 500_000_000n, 999_999_999_999n]) {
        const c = fundingForRecipient(money('INR', paise), rate)
        expect(verifyRecipientFirst(c), `${rateText} / ${paise}`).toBe(true)
      }
    }
  })

  it('a residual is zero exactly when the division is exact', () => {
    // 100.0000000000 divides a round paise amount exactly at USDT scale 6.
    const clean = fxRateFromDecimalString('USDT/INR', '100.0000000000', QUOTED, 'sandbox')
    const c = fundingForRecipient(money('INR', 100n), clean)
    expect(c.roundingResidual).toEqual(ZERO_RESIDUAL('USDT'))
    expect(c.fundingAmount.minorUnits).toBe(10_000n)
  })

  it('the residual is always strictly less than one minor unit', () => {
    for (const paise of [1n, 3n, 17n, 250n, 1_000_003n, 987_654_321n]) {
      const c = fundingForRecipient(money('INR', paise), USDT_INR)
      // A residual of one whole minor unit would mean the ceiling overshot.
      expect(Number(c.roundingResidual.amount) * 1e6).toBeLessThan(1)
    }
  })

  it('is monotonic: a larger recipient amount never costs less', () => {
    let previous = -1n
    for (let paise = 1n; paise < 5_000n; paise += 137n) {
      const charged = fundingForRecipient(money('INR', paise), USDT_INR).fundingAmount.minorUnits
      expect(charged >= previous).toBe(true)
      previous = charged
    }
  })

  it('zero converts to zero with no residual', () => {
    const c = fundingForRecipient(money('INR', 0n), USDT_INR)
    expect(c.fundingAmount.minorUnits).toBe(0n)
    expect(c.roundingResidual).toEqual(ZERO_RESIDUAL('USDT'))
  })

  it('handles amounts far beyond 64-bit without loss', () => {
    const huge = money('INR', 10n ** 24n + 7n)
    expect(verifyRecipientFirst(fundingForRecipient(huge, USDT_INR))).toBe(true)
  })
})

describe('SOURCE_FIRST — the recipient side rounds down', () => {
  it('never promises paise the funding does not cover', () => {
    for (const rateText of ['88.4210000000', '83.1234567891', '7.7777777777']) {
      const rate = fxRateFromDecimalString('USDT/INR', rateText, QUOTED, 'sandbox')
      for (const minor of [1n, 13n, 1_000_000n, 56_547_652_707n]) {
        const c = recipientForFunding(money('USDT', minor), rate)
        expect(verifySourceFirst(c), `${rateText} / ${minor}`).toBe(true)
      }
    }
  })

  it('the two directions are consistent: funding a derived recipient amount never exceeds the source', () => {
    // Round-tripping SOURCE_FIRST → RECIPIENT_FIRST must not manufacture money.
    for (const minor of [1_000_000n, 12_345_678n, 56_547_652_707n]) {
      const forward = recipientForFunding(money('USDT', minor), USDT_INR)
      const back = fundingForRecipient(forward.recipientAmount, USDT_INR)
      expect(back.fundingAmount.minorUnits <= minor).toBe(true)
    }
  })

  it('discloses the INR dust', () => {
    const c = recipientForFunding(money('USDT', 1n), USDT_INR)
    expect(c.roundingResidual.currency).toBe('INR')
    expect(c.roundingResidual.scale).toBe(12)
  })
})

describe('rejections', () => {
  it('refuses a non-INR recipient amount', () => {
    expect(() => fundingForRecipient(money('USD', 100n), USDT_INR)).toThrow(/must be INR/)
  })

  it('refuses a pair that does not settle into INR', () => {
    const wrong = fxRateFromDecimalString('USD/EUR' as never, '1.1', QUOTED, 's')
    expect(() => fundingForRecipient(money('INR', 100n), wrong)).toThrow(/not an INR pair/)
  })

  it('refuses a funding amount in the wrong currency', () => {
    expect(() => recipientForFunding(money('USD', 100n), USDT_INR)).toThrow(/does not match the pair/)
  })

  it('refuses negative amounts on both sides', () => {
    expect(() => fundingForRecipient(money('INR', -1n), USDT_INR)).toThrow()
    expect(() => recipientForFunding(money('USDT', -1n), USDT_INR)).toThrow()
  })
})

describe('INV-07 — fees are separate values', () => {
  it('sums fees in their own currency', () => {
    const total = totalFees('USDT', [
      { code: 'network', label: 'Network fee', amount: money('USDT', 1_000_000n) },
      { code: 'service', label: 'Service fee', amount: money('USDT', 2_500_000n) },
    ])
    expect(total.minorUnits).toBe(3_500_000n)
  })

  it('refuses to sum across currencies rather than coercing', () => {
    expect(() =>
      totalFees('USDT', [{ code: 'x', label: 'X', amount: money('USD', 1n) }]),
    ).toThrow(/not USDT/)
  })

  it('fees do not touch the rate', () => {
    // The structural half of INV-07: applying fees cannot change the conversion.
    const withoutFees = fundingForRecipient(money('INR', 500_000_000n), USDT_INR)
    const fees = totalFees('USDT', [
      { code: 'service', label: 'Service fee', amount: money('USDT', 5_000_000n) },
    ])
    expect(withoutFees.rate.rateScaled).toBe(USDT_INR.rateScaled)
    expect(withoutFees.fundingAmount.minorUnits + fees.minorUnits).toBe(56_552_652_707n)
  })
})

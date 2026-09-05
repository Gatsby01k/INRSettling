/**
 * FX and quote arithmetic — `DOMAIN.md § 3.2`–`§ 3.4`.
 *
 * Every value here is computed in exact integer arithmetic on `bigint`. There
 * is no `number` in the money path and no division that discards a remainder
 * silently: each rounding step names its direction and hands back the residual
 * it created.
 *
 * The three frozen rules this file exists to make true:
 *
 *   `INV-05` the recipient INR amount is never rounded;
 *   `INV-06` funding-side rounding is **up**, and the residual is disclosed;
 *   `INV-08` exactly one side of a quote is authoritative.
 */
import { CURRENCIES, MoneyError, money, scaleOf, type CurrencyCode, type ExactAmount, type Money } from './index.js'

/** Fixed by `DOMAIN.md § 3.2`. A rate is `NUMERIC(28,10)`. */
export const FX_RATE_SCALE = 10
/** Fixed by `DOMAIN.md § 3.3`. */
export const EXACT_AMOUNT_SCALE = 12

export type CurrencyPair = `${CurrencyCode}/${CurrencyCode}`

/**
 * INR per one unit of the left-hand currency.
 *
 * `rateScaled` is the rate multiplied by `10^10` and held as an integer, which
 * is exactly how `NUMERIC(28,10)` stores it. There is deliberately no `number`
 * representation anywhere on this type.
 */
export interface FxRate {
  readonly pair: CurrencyPair
  readonly rateScaled: bigint
  readonly scale: typeof FX_RATE_SCALE
  readonly quotedAt: Date
  /** Provider identifier. Internal only; never shown to a customer. */
  readonly source: string
}

export function fxRate(args: {
  pair: CurrencyPair
  rateScaled: bigint
  quotedAt: Date
  source: string
}): FxRate {
  if (args.rateScaled <= 0n) {
    throw new MoneyError('an FX rate must be positive', 'negative')
  }
  return { ...args, scale: FX_RATE_SCALE }
}

/** Parse `'88.4210000000'` into the scaled integer, exactly. */
export function fxRateFromDecimalString(
  pair: CurrencyPair,
  decimal: string,
  quotedAt: Date,
  source: string,
): FxRate {
  const m = /^(\d+)(?:\.(\d{1,10}))?$/.exec(decimal.trim())
  if (!m) throw new MoneyError(`'${decimal}' is not a rate at scale ${FX_RATE_SCALE}`, 'not_an_integer')
  const whole = m[1]!
  const frac = (m[2] ?? '').padEnd(FX_RATE_SCALE, '0')
  return fxRate({ pair, rateScaled: BigInt(whole + frac), quotedAt, source })
}

export function formatFxRate(rate: FxRate): string {
  const s = rate.rateScaled.toString().padStart(FX_RATE_SCALE + 1, '0')
  return `${s.slice(0, -FX_RATE_SCALE)}.${s.slice(-FX_RATE_SCALE)}`
}

export function fundingCurrencyOf(rate: FxRate): CurrencyCode {
  const left = rate.pair.split('/')[0] as CurrencyCode
  if (!Object.hasOwn(CURRENCIES, left)) {
    throw new MoneyError(`unknown currency in pair ${rate.pair}`, 'unknown_currency')
  }
  return left
}

function assertInrRight(rate: FxRate): void {
  if (!rate.pair.endsWith('/INR')) {
    throw new MoneyError(`${rate.pair} is not an INR pair; V1 settles into INR only`, 'currency_mismatch')
  }
}

/* ── Exact rational helpers ────────────────────────────────────────────── */

/** Ceiling of `a / b` for positive `b`, in exact integer arithmetic. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new MoneyError('division by a non-positive denominator', 'not_an_integer')
  return a >= 0n ? (a + b - 1n) / b : -((-a) / b)
}

/** Floor of `a / b` for positive `b`. */
function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new MoneyError('division by a non-positive denominator', 'not_an_integer')
  return a >= 0n ? a / b : -ceilDiv(-a, b)
}

/**
 * A remainder expressed at `EXACT_AMOUNT_SCALE`, rounded **half-up**.
 *
 * A caveat worth stating rather than hiding: for an arbitrary rate the residual
 * is a rational that is *not* exactly representable at twelve decimal places.
 * `ExactAmount` at scale 12 is therefore the **disclosed** residual — precise
 * to a millionth of a minor unit, which is far below anything a receipt or a
 * ledger can express — and not a lossless encoding of the rational.
 *
 * The property that actually has to hold for the money to be right is the
 * integer one, and it is asserted directly by `verifyRecipientFirst` below:
 * the charged amount is the unique smallest integer whose value covers the
 * recipient amount. That is exact with no caveat.
 */
function remainderAsExactAmount(
  currency: CurrencyCode,
  remainderNum: bigint,
  remainderDen: bigint,
  minorUnitsPerMajor: bigint,
): ExactAmount {
  // remainder is in *minor units*; convert to major and scale to 12 dp.
  const scaled = remainderNum * 10n ** BigInt(EXACT_AMOUNT_SCALE)
  const den = remainderDen * minorUnitsPerMajor
  // Round half-up on the last digit.
  const doubled = 2n * scaled + den
  const units = floorDiv(doubled, 2n * den)
  const digits = units.toString().padStart(EXACT_AMOUNT_SCALE + 1, '0')
  return {
    currency,
    amount: `${digits.slice(0, -EXACT_AMOUNT_SCALE)}.${digits.slice(-EXACT_AMOUNT_SCALE)}`,
    scale: EXACT_AMOUNT_SCALE,
  }
}

export const ZERO_RESIDUAL = (currency: CurrencyCode): ExactAmount => ({
  currency,
  amount: `0.${'0'.repeat(EXACT_AMOUNT_SCALE)}`,
  scale: EXACT_AMOUNT_SCALE,
})

/* ── RECIPIENT_FIRST ───────────────────────────────────────────────────── */

export interface RecipientFirstConversion {
  /** Exactly what the customer asked the beneficiary to receive. Never rounded. */
  readonly recipientAmount: Money
  /** What the customer funds. Rounded **up** to the next minor unit (`INV-06`). */
  readonly fundingAmount: Money
  /** Retained by INRSettle and disclosed on the receipt. */
  readonly roundingResidual: ExactAmount
  readonly rate: FxRate
}

/**
 * Funding required for an exact recipient amount.
 *
 * ```
 * fundingMinor = ceil( R × 10^fundingScale × 10^rateScale
 *                      / ( rateScaled × 10^inrScale ) )
 * ```
 *
 * Worked example from `DOMAIN.md § 3.3` — ₹5,000,000.00 at `USDT/INR
 * 88.4210000000` gives an exact 56,547,652,706.936135… and a charged
 * 56,547,652,707 USDT minor units. That example is a test.
 */
export function fundingForRecipient(recipientAmount: Money, rate: FxRate): RecipientFirstConversion {
  assertInrRight(rate)
  if (recipientAmount.currency !== 'INR') {
    throw new MoneyError('the recipient amount must be INR', 'currency_mismatch')
  }
  if (recipientAmount.minorUnits < 0n) {
    throw new MoneyError('the recipient amount must not be negative', 'negative')
  }

  const fundingCurrency = fundingCurrencyOf(rate)
  const fundingScale = BigInt(scaleOf(fundingCurrency))
  const inrScale = BigInt(scaleOf('INR'))

  const numerator = recipientAmount.minorUnits * 10n ** fundingScale * 10n ** BigInt(FX_RATE_SCALE)
  const denominator = rate.rateScaled * 10n ** inrScale

  const chargedMinor = ceilDiv(numerator, denominator)
  // remainder = chargedMinor − exact, as an exact fraction of a minor unit.
  const remainderNum = chargedMinor * denominator - numerator

  return {
    recipientAmount,
    fundingAmount: money(fundingCurrency, chargedMinor),
    roundingResidual:
      remainderNum === 0n
        ? ZERO_RESIDUAL(fundingCurrency)
        : remainderAsExactAmount(fundingCurrency, remainderNum, denominator, 10n ** fundingScale),
    rate,
  }
}

/**
 * The integer property that makes the rounding correct, checkable directly.
 *
 * `chargedMinor` must be the unique smallest integer that covers the recipient
 * amount: charging it is enough, and charging one less is not. This is what
 * `INV-06` means operationally, and it holds exactly — no scale-12 caveat.
 */
export function verifyRecipientFirst(conversion: RecipientFirstConversion): boolean {
  const fundingScale = BigInt(scaleOf(conversion.fundingAmount.currency))
  const inrScale = BigInt(scaleOf('INR'))
  const numerator =
    conversion.recipientAmount.minorUnits * 10n ** fundingScale * 10n ** BigInt(FX_RATE_SCALE)
  const denominator = conversion.rate.rateScaled * 10n ** inrScale
  const charged = conversion.fundingAmount.minorUnits
  return charged * denominator >= numerator && (charged - 1n) * denominator < numerator
}

/* ── SOURCE_FIRST ──────────────────────────────────────────────────────── */

export interface SourceFirstConversion {
  readonly fundingAmount: Money
  /** Derived and rounded **down** to the paise; the shortfall is disclosed. */
  readonly recipientAmount: Money
  readonly roundingResidual: ExactAmount
  readonly rate: FxRate
}

/**
 * Recipient amount for an exact funding amount.
 *
 * Rounds **down**, because rounding up would promise the beneficiary paise the
 * funding does not cover. The dust is disclosed on the INR side.
 */
export function recipientForFunding(fundingAmount: Money, rate: FxRate): SourceFirstConversion {
  assertInrRight(rate)
  if (fundingAmount.currency !== fundingCurrencyOf(rate)) {
    throw new MoneyError(
      `funding currency ${fundingAmount.currency} does not match the pair ${rate.pair}`,
      'currency_mismatch',
    )
  }
  if (fundingAmount.minorUnits < 0n) {
    throw new MoneyError('the funding amount must not be negative', 'negative')
  }

  const fundingScale = BigInt(scaleOf(fundingAmount.currency))
  const inrScale = BigInt(scaleOf('INR'))

  const numerator = fundingAmount.minorUnits * rate.rateScaled * 10n ** inrScale
  const denominator = 10n ** fundingScale * 10n ** BigInt(FX_RATE_SCALE)

  const recipientMinor = floorDiv(numerator, denominator)
  const remainderNum = numerator - recipientMinor * denominator

  return {
    fundingAmount,
    recipientAmount: money('INR', recipientMinor),
    roundingResidual:
      remainderNum === 0n
        ? ZERO_RESIDUAL('INR')
        : remainderAsExactAmount('INR', remainderNum, denominator, 10n ** inrScale),
    rate,
  }
}

export function verifySourceFirst(conversion: SourceFirstConversion): boolean {
  const fundingScale = BigInt(scaleOf(conversion.fundingAmount.currency))
  const inrScale = BigInt(scaleOf('INR'))
  const numerator = conversion.fundingAmount.minorUnits * conversion.rate.rateScaled * 10n ** inrScale
  const denominator = 10n ** fundingScale * 10n ** BigInt(FX_RATE_SCALE)
  const recipient = conversion.recipientAmount.minorUnits
  return recipient * denominator <= numerator && (recipient + 1n) * denominator > numerator
}

/* ── Fees ──────────────────────────────────────────────────────────────── */

/**
 * `INV-07` — fees are separate `Money` values with their own codes. They are
 * never folded into the rate, and the rate shown is the rate used. This type
 * makes the second half structural: a fee cannot be expressed as a rate
 * adjustment because there is nowhere to put one.
 */
export interface FeeComponent {
  readonly code: string
  readonly label: string
  readonly amount: Money
}

export function totalFees(currency: CurrencyCode, fees: readonly FeeComponent[]): Money {
  let total = 0n
  for (const fee of fees) {
    if (fee.amount.currency !== currency) {
      throw new MoneyError(
        `fee ${fee.code} is in ${fee.amount.currency}, not ${currency}`,
        'currency_mismatch',
      )
    }
    total += fee.amount.minorUnits
  }
  return money(currency, total)
}

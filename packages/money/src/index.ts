/**
 * Money — the highest-risk primitive in the system.
 *
 * Stage 0 invariants implemented here:
 *   INV-01  no floating point, anywhere in the money path
 *   INV-02  persisted as (minor BIGINT, currency TEXT) — see @inrsettle/db
 *   INV-03  cross-currency arithmetic is an error
 *   INV-04  JSON carries minor_units as a STRING
 *   INV-05  the recipient INR amount is never rounded
 *   INV-06  funding-side rounding is upward; the residual is disclosed
 *   INV-08  exactly one side of a quote is authoritative
 *
 * DOMAIN.md § 3. Do not add helpers that accept `number`.
 */

export const CURRENCIES = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  USDT: 6,
  USDC: 6,
} as const

export type CurrencyCode = keyof typeof CURRENCIES

export function scaleOf(currency: CurrencyCode): number {
  return CURRENCIES[currency]
}

export function isCurrencyCode(v: string): v is CurrencyCode {
  return Object.hasOwn(CURRENCIES, v)
}

export interface Money {
  readonly currency: CurrencyCode
  readonly minorUnits: bigint
}

/**
 * An exact quantity smaller than one minor unit. Not a Money — by construction
 * it cannot be expressed in minor units (DOMAIN.md § 3.3).
 */
export interface ExactAmount {
  readonly currency: CurrencyCode
  readonly amount: string
  readonly scale: 12
}

export class MoneyError extends Error {
  constructor(
    message: string,
    readonly code: 'currency_mismatch' | 'not_an_integer' | 'unknown_currency' | 'negative',
  ) {
    super(message)
    this.name = 'MoneyError'
  }
}

export function money(currency: CurrencyCode, minorUnits: bigint): Money {
  if (!isCurrencyCode(currency)) {
    throw new MoneyError(`unknown currency ${currency}`, 'unknown_currency')
  }
  return Object.freeze({ currency, minorUnits })
}

/** Parse from a decimal string. Never from a JS number — INV-01. */
export function moneyFromDecimalString(currency: CurrencyCode, decimal: string): Money {
  const scale = scaleOf(currency)
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(decimal.trim())
  if (!m) throw new MoneyError(`not a decimal string: ${decimal}`, 'not_an_integer')
  const [, sign = '', whole = '0', frac = ''] = m
  if (frac.length > scale) {
    throw new MoneyError(
      `${decimal} has more precision than ${currency} (scale ${scale})`,
      'not_an_integer',
    )
  }
  const padded = frac.padEnd(scale, '0')
  return money(currency, BigInt(`${sign}${whole}${padded}`))
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`cannot combine ${a.currency} and ${b.currency}`, 'currency_mismatch')
  }
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b)
  return money(a.currency, a.minorUnits + b.minorUnits)
}

export function subtract(a: Money, b: Money): Money {
  assertSame(a, b)
  return money(a.currency, a.minorUnits - b.minorUnits)
}

export function sum(currency: CurrencyCode, items: readonly Money[]): Money {
  return items.reduce((acc, m) => add(acc, m), money(currency, 0n))
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b)
  return a.minorUnits < b.minorUnits ? -1 : a.minorUnits > b.minorUnits ? 1 : 0
}

export const isZero = (m: Money): boolean => m.minorUnits === 0n
export const isNegative = (m: Money): boolean => m.minorUnits < 0n

/** Group digits. `international` → 5,000,000.00; `indian` → 50,00,000.00. */
export type NumberFormat = 'international' | 'indian'

export function formatMoney(
  m: Money,
  opts: { format?: NumberFormat; symbol?: boolean } = {},
): string {
  const { format = 'international', symbol = true } = opts
  const scale = scaleOf(m.currency)
  const neg = m.minorUnits < 0n
  const digits = (neg ? -m.minorUnits : m.minorUnits).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const frac = scale > 0 ? digits.slice(digits.length - scale) : ''

  let grouped: string
  if (format === 'indian' && whole.length > 3) {
    const last3 = whole.slice(-3)
    const rest = whole.slice(0, -3)
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3
  } else {
    grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  const body = frac ? `${grouped}.${frac}` : grouped
  const prefix = symbol && m.currency === 'INR' ? '₹' : ''
  const suffix = symbol && m.currency !== 'INR' ? ` ${m.currency}` : ''
  return `${neg ? '-' : ''}${prefix}${body}${suffix}`
}

/** Wire representation — INV-04: minor_units is a string. */
export interface MoneyJson {
  currency: CurrencyCode
  minor_units: string
  scale: number
  display: string
}

export function toJson(m: Money, format: NumberFormat = 'international'): MoneyJson {
  return {
    currency: m.currency,
    minor_units: m.minorUnits.toString(),
    scale: scaleOf(m.currency),
    display: formatMoney(m, { format }),
  }
}

export function fromJson(j: { currency: string; minor_units: string }): Money {
  if (!isCurrencyCode(j.currency)) {
    throw new MoneyError(`unknown currency ${j.currency}`, 'unknown_currency')
  }
  if (!/^-?\d+$/.test(j.minor_units)) {
    throw new MoneyError(`minor_units must be an integer string`, 'not_an_integer')
  }
  return money(j.currency, BigInt(j.minor_units))
}

export * from './fx.js'

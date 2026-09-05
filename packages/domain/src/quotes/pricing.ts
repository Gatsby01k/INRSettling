/**
 * Quote pricing — `D-08` and `D-09`, both **open**.
 *
 * `D-08` (who bears FX movement between lock and execution, and what the quote
 * validity window is) and `D-09` (the fee model) are the commercial core of the
 * product. Neither can be answered without real provider and treasury evidence,
 * and inventing an answer here would produce a system that looks priced and is
 * not — the same failure mode as inventing a purpose-code table for `D-06`.
 *
 * So pricing is **versioned configuration with a recorded source**, exactly like
 * the preflight rules and the name-match policy. The only configuration that
 * exists today is a sandbox fixture whose own description says it is not a
 * commercial commitment, and `quotePricing` refuses to price in live against
 * one.
 *
 * What Stage 3 *does* settle is the arithmetic: `INV-05`–`INV-08` hold whatever
 * the commercial answer turns out to be, and they are tested independently of
 * this file.
 */
import {
  fundingForRecipient,
  money,
  recipientForFunding,
  type CurrencyCode,
  type ExactAmount,
  type FeeComponent,
  type FxRate,
  type Money,
} from '@inrsettle/money'
import type { QuoteDirection } from '../settlements/authorized-terms.js'

export type PricingSource = 'sandbox_fixture' | 'treasury_approved' | 'provider_contract'

/** A fee expressed in the funding currency. */
export type FeeRule =
  /** A flat amount in minor units of the funding currency. */
  | { readonly kind: 'flat'; readonly code: string; readonly label: string; readonly minorUnits: string }
  /** Basis points of the funding amount, rounded **up** so a fee is never under-charged by rounding. */
  | { readonly kind: 'basis_points'; readonly code: string; readonly label: string; readonly bps: number }

export interface PricingConfig {
  readonly version: string
  readonly source: PricingSource
  /** Must say plainly what this is and is not. Validated. */
  readonly description: string
  /**
   * How long a quote stays valid. `D-08` decides the real number; this is a
   * sandbox value and is labelled as one.
   */
  readonly validitySeconds: number
  readonly feeRules: readonly FeeRule[]
  /** A delivery band, never a promise of a time. */
  readonly estimatedDelivery: string
}

/**
 * **SANDBOX SIMULATOR CONFIGURATION — NOT A COMMERCIAL COMMITMENT.**
 *
 * The numbers below are invented so the quote and settlement machinery can be
 * exercised end to end. They are not INRSettle's pricing, they are not any
 * provider's pricing, and they must not be shown to a customer as terms. `D-08`
 * and `D-09` are open.
 */
export const SANDBOX_PRICING: PricingConfig = {
  version: 'sandbox-pricing-1',
  source: 'sandbox_fixture',
  description:
    'DETERMINISTIC SANDBOX PRICING — NOT A COMMERCIAL COMMITMENT. The fee rules and ' +
    'validity window below are invented so the quote lifecycle and settlement machine ' +
    'can be exercised end to end. They are not INRSettle pricing and not any provider’s ' +
    'pricing. Decisions D-08 (who bears FX movement between lock and execution, and the ' +
    'quote validity window) and D-09 (the fee model and its disclosure) are OPEN and can ' +
    'only be closed with real commercial and provider evidence.',
  validitySeconds: 120,
  feeRules: [
    { kind: 'flat', code: 'network', label: 'Network fee', minorUnits: '250000' },
    { kind: 'basis_points', code: 'service', label: 'Service fee', bps: 35 },
  ],
  estimatedDelivery: 'under 30 minutes',
}

export type PricingDefect =
  | { problem: 'missing_field'; field: string }
  | { problem: 'unknown_source'; value: string }
  | { problem: 'description_does_not_disclose_status' }
  | { problem: 'validity_out_of_range' }
  | { problem: 'duplicate_fee_code'; code: string }
  | { problem: 'fee_rule_invalid'; code: string }

const SOURCES: readonly PricingSource[] = ['sandbox_fixture', 'treasury_approved', 'provider_contract']

export function validatePricingConfig(config: PricingConfig): PricingDefect[] {
  const defects: PricingDefect[] = []
  for (const field of ['version', 'description', 'estimatedDelivery'] as const) {
    if (typeof config[field] !== 'string' || config[field] === '') {
      defects.push({ problem: 'missing_field', field })
    }
  }
  if (!SOURCES.includes(config.source)) {
    defects.push({ problem: 'unknown_source', value: String(config.source) })
  }
  // A sandbox fixture has to say so in its own description, so a screenshot of
  // a sandbox quote cannot be mistaken for a commercial one.
  if (config.source === 'sandbox_fixture' && !/NOT A COMMERCIAL COMMITMENT/i.test(config.description)) {
    defects.push({ problem: 'description_does_not_disclose_status' })
  }
  if (!Number.isInteger(config.validitySeconds) || config.validitySeconds < 10 || config.validitySeconds > 86_400) {
    defects.push({ problem: 'validity_out_of_range' })
  }
  const seen = new Set<string>()
  for (const rule of config.feeRules) {
    if (seen.has(rule.code)) defects.push({ problem: 'duplicate_fee_code', code: rule.code })
    seen.add(rule.code)
    if (rule.kind === 'flat' && !/^\d+$/.test(rule.minorUnits)) {
      defects.push({ problem: 'fee_rule_invalid', code: rule.code })
    }
    if (rule.kind === 'basis_points' && (!Number.isInteger(rule.bps) || rule.bps < 0 || rule.bps > 10_000)) {
      defects.push({ problem: 'fee_rule_invalid', code: rule.code })
    }
  }
  return defects
}

/**
 * Fees for a funding amount.
 *
 * Basis points round **up**, in integer arithmetic, for the same reason the
 * funding conversion does: a fee that rounds down is money INRSettle silently
 * gives away, and the direction should be a decision rather than an accident.
 * `INV-07` keeps every component a separate `Money` with its own code.
 */
export function computeFees(config: PricingConfig, fundingAmount: Money): FeeComponent[] {
  return config.feeRules.map((rule) => {
    if (rule.kind === 'flat') {
      return {
        code: rule.code,
        label: rule.label,
        amount: money(fundingAmount.currency, BigInt(rule.minorUnits)),
      }
    }
    const bps = BigInt(rule.bps)
    const amount = (fundingAmount.minorUnits * bps + 9_999n) / 10_000n
    return { code: rule.code, label: rule.label, amount: money(fundingAmount.currency, amount) }
  })
}

export class PricingError extends Error {
  constructor(message: string, readonly code: 'sandbox_config_in_live' | 'invalid_config') {
    super(message)
    this.name = 'PricingError'
  }
}

export interface PricedQuote {
  readonly direction: QuoteDirection
  readonly recipientAmount: Money
  readonly fundingAmount: Money
  readonly feeComponents: readonly FeeComponent[]
  readonly roundingResidual: ExactAmount
  readonly fxRate: FxRate
  readonly expiresAt: Date
  readonly estimatedDelivery: string
  readonly pricingVersion: string
}

/**
 * Price a quote.
 *
 * Refuses to price a **live** quote against a sandbox fixture. That is the same
 * shape of guard as the verification registry refusing to fall back to the
 * simulator in live: quoting real money on invented terms would be a commercial
 * commitment nobody made.
 */
export function priceQuote(args: {
  config: PricingConfig
  environment: 'sandbox' | 'live'
  direction: QuoteDirection
  /** Authoritative side, per `INV-08`. */
  recipientAmount?: Money
  fundingAmount?: Money
  rate: FxRate
  now: Date
}): PricedQuote {
  if (args.environment === 'live' && args.config.source === 'sandbox_fixture') {
    throw new PricingError(
      'a live quote cannot be priced against sandbox pricing configuration; ' +
        'D-08 and D-09 are open and no commercial configuration exists yet',
      'sandbox_config_in_live',
    )
  }
  const defects = validatePricingConfig(args.config)
  if (defects.length > 0) {
    throw new PricingError(`pricing configuration is invalid: ${JSON.stringify(defects)}`, 'invalid_config')
  }

  const expiresAt = new Date(args.now.getTime() + args.config.validitySeconds * 1000)

  if (args.direction === 'RECIPIENT_FIRST') {
    if (!args.recipientAmount) {
      throw new PricingError('RECIPIENT_FIRST requires a recipient amount', 'invalid_config')
    }
    const converted = fundingForRecipient(args.recipientAmount, args.rate)
    return {
      direction: 'RECIPIENT_FIRST',
      recipientAmount: converted.recipientAmount,
      fundingAmount: converted.fundingAmount,
      feeComponents: computeFees(args.config, converted.fundingAmount),
      roundingResidual: converted.roundingResidual,
      fxRate: args.rate,
      expiresAt,
      estimatedDelivery: args.config.estimatedDelivery,
      pricingVersion: args.config.version,
    }
  }

  if (!args.fundingAmount) {
    throw new PricingError('SOURCE_FIRST requires a funding amount', 'invalid_config')
  }
  const converted = recipientForFunding(args.fundingAmount, args.rate)
  return {
    direction: 'SOURCE_FIRST',
    recipientAmount: converted.recipientAmount,
    fundingAmount: converted.fundingAmount,
    feeComponents: computeFees(args.config, converted.fundingAmount),
    roundingResidual: converted.roundingResidual,
    fxRate: args.rate,
    expiresAt,
    estimatedDelivery: args.config.estimatedDelivery,
    pricingVersion: args.config.version,
  }
}

/**
 * The sandbox rate book. Deterministic, labelled, and not a market feed.
 *
 * Fixed rates so a sandbox quote is reproducible in a test and in a demo. A
 * real rate source is Stage 4/5 work and arrives with `D-08`.
 */
export const SANDBOX_RATES: Readonly<Record<string, string>> = {
  'USDT/INR': '88.4210000000',
  'USDC/INR': '88.3900000000',
  'USD/INR': '83.5100000000',
  'EUR/INR': '90.1200000000',
  'GBP/INR': '105.6700000000',
  'AED/INR': '22.7400000000',
  'SGD/INR': '61.8800000000',
}

export function sandboxRateFor(fundingCurrency: CurrencyCode): string | undefined {
  return SANDBOX_RATES[`${fundingCurrency}/INR`]
}

/**
 * The Quote aggregate's application layer — `DOMAIN.md § 6.4`.
 *
 * Two things live here that cannot live in the domain: the **database clock**
 * (`INV-15` — expiry is evaluated server-side, never against a client-supplied
 * time) and the single-consumption write (`INV-14`), whose real enforcement is
 * a unique index rather than a check anyone can forget.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  fxRate,
  fxRateFromDecimalString,
  money,
  type CurrencyCode,
  type ExactAmount,
  type FeeComponent,
  type Money,
} from '@inrsettle/money'
import {
  SANDBOX_PRICING,
  checkQuoteAttachable,
  evaluateQuoteTransition,
  priceQuote,
  sandboxRateFor,
  type PricingConfig,
  type PrincipalRef,
  type Quote,
  type QuoteDirection,
  type QuoteStatus,
  type QuoteTrigger,
  type QuoteUsabilityProblem,
  type TenantScope,
} from '@inrsettle/domain'
import { eventSink } from './events.js'

export class QuoteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'QuoteError'
  }
}

/**
 * The database clock. Never `new Date()` on the application host (`INV-15`).
 *
 * Coerced explicitly, because what comes back through the driver depends on the
 * query path — and a "date" that is actually a string fails silently later
 * rather than here.
 */
export async function databaseNow(tx: Db): Promise<Date> {
  const rows = (await tx.execute(sql`SELECT now() AS now`)) as unknown as { now: Date | string }[]
  const value = rows[0]?.now
  if (value === undefined) throw new QuoteError('no_clock', 'the database returned no clock reading')
  return value instanceof Date ? value : new Date(value)
}

type QuoteRow = typeof schema.quotes.$inferSelect

export function toQuote(row: QuoteRow): Quote {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    environment: row.environment,
    direction: row.direction,
    recipientAmount: money(row.recipientAmountCurrency as CurrencyCode, row.recipientAmountMinor),
    fundingAmount: money(row.fundingAmountCurrency as CurrencyCode, row.fundingAmountMinor),
    fxRate: fxRate({
      pair: row.fxPair as `${CurrencyCode}/${CurrencyCode}`,
      // NUMERIC(28,10) comes back as a decimal string; re-scale exactly.
      rateScaled: BigInt(row.fxRateScaled.replace('.', '').replace(/^(-?)0+(?=\d)/, '$1')),
      quotedAt: row.fxQuotedAt,
      source: row.fxSource,
    }),
    feeComponents: (row.feeComponents as { code: string; label: string; amount: { currency: CurrencyCode; minor_units: string } }[])
      .map((f) => ({ code: f.code, label: f.label, amount: money(f.amount.currency, BigInt(f.amount.minor_units)) })),
    roundingResidual: row.roundingResidual as ExactAmount,
    estimatedDelivery: row.estimatedDelivery,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    lockedAt: row.lockedAt,
    consumedBySettlementId: row.consumedBySettlementId,
    pricingVersion: row.pricingVersion,
  }
}

function feeJson(fees: readonly FeeComponent[]): unknown {
  return fees.map((f) => ({
    code: f.code,
    label: f.label,
    // INV-04: minor units cross a boundary as a string.
    amount: { currency: f.amount.currency, minor_units: f.amount.minorUnits.toString() },
  }))
}

export interface CreateQuoteInput {
  direction?: QuoteDirection
  recipientAmount?: Money
  fundingAmount?: Money
  fundingCurrency: CurrencyCode
  actor: PrincipalRef
  /** Defaults to the labelled sandbox configuration. `D-08`/`D-09` are open. */
  config?: PricingConfig
}

/**
 * Create a quote (Q01).
 *
 * Recipient-first is the default because that is the product's whole framing:
 * the customer says what the beneficiary receives, and the funding side is
 * derived.
 */
export async function createQuote(
  tx: Db,
  scope: TenantScope,
  input: CreateQuoteInput,
): Promise<Quote> {
  const config = input.config ?? SANDBOX_PRICING
  const now = await databaseNow(tx)
  const rateText = sandboxRateFor(input.fundingCurrency)
  if (!rateText) {
    throw new QuoteError('no_rate', `no sandbox rate for ${input.fundingCurrency}/INR`)
  }
  const rate = fxRateFromDecimalString(
    `${input.fundingCurrency}/INR`,
    rateText,
    now,
    `${config.source}:${config.version}`,
  )

  const priced = priceQuote({
    config,
    environment: scope.environment,
    direction: input.direction ?? 'RECIPIENT_FIRST',
    ...(input.recipientAmount ? { recipientAmount: input.recipientAmount } : {}),
    ...(input.fundingAmount ? { fundingAmount: input.fundingAmount } : {}),
    rate,
    now,
  })

  const id = newId('quote')
  await tx.insert(schema.quotes).values({
    id,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    direction: priced.direction,
    recipientAmountMinor: priced.recipientAmount.minorUnits,
    recipientAmountCurrency: priced.recipientAmount.currency,
    fundingAmountMinor: priced.fundingAmount.minorUnits,
    fundingAmountCurrency: priced.fundingAmount.currency,
    fxRateScaled: formatScaled(rate.rateScaled),
    fxPair: rate.pair,
    fxQuotedAt: rate.quotedAt,
    fxSource: rate.source,
    feeComponents: feeJson(priced.feeComponents) as never,
    roundingResidual: priced.roundingResidual as never,
    estimatedDelivery: priced.estimatedDelivery,
    pricingVersion: priced.pricingVersion,
    status: 'ACTIVE',
    expiresAt: priced.expiresAt,
    createdBy: input.actor.id,
  })

  const events = eventSink(tx)
  await events.audit(scope, {
    actor: input.actor,
    action: 'quote.created',
    subjectType: 'quote',
    subjectId: id,
    after: {
      direction: priced.direction,
      recipient_minor: priced.recipientAmount.minorUnits.toString(),
      funding_minor: priced.fundingAmount.minorUnits.toString(),
      pricing_version: priced.pricingVersion,
    },
  })

  const [row] = await tx.select().from(schema.quotes).where(eq(schema.quotes.id, id)).limit(1)
  return toQuote(row!)
}

/** `NUMERIC(28,10)` wants a decimal string; produce it exactly from the integer. */
function formatScaled(scaled: bigint): string {
  const s = scaled.toString().padStart(11, '0')
  return `${s.slice(0, -10)}.${s.slice(-10)}`
}

export async function getQuote(tx: Db, quoteId: string): Promise<Quote | null> {
  const [row] = await tx.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId)).limit(1)
  return row ? toQuote(row) : null
}

/**
 * Move a quote through its lifecycle.
 *
 * The domain decides whether the move is legal; the database's immutability
 * trigger is what makes it true even against raw SQL.
 */
export async function transitionQuote(
  tx: Db,
  scope: TenantScope,
  args: {
    quoteId: string
    trigger: QuoteTrigger
    actor: PrincipalRef
    consumedBySettlementId?: string
  },
): Promise<{ ok: true; status: QuoteStatus } | { ok: false; reason: string }> {
  // The same row lock the settlement transitions take, so a quote cannot be
  // consumed twice by two racing authorizations.
  const locked = (await tx.execute(sql`
    SELECT id, status FROM quotes WHERE id = ${args.quoteId} FOR UPDATE`)) as unknown as {
    id: string
    status: QuoteStatus
  }[]
  const current = locked[0]
  if (!current) return { ok: false, reason: 'quote_not_found' }

  const evaluated = evaluateQuoteTransition(current.status, args.trigger)
  if (!evaluated.ok) return { ok: false, reason: evaluated.error }

  const patch: Record<string, unknown> = { status: evaluated.to }
  if (evaluated.to === 'LOCKED') patch['lockedAt'] = await databaseNow(tx)
  if (evaluated.to === 'CONSUMED') {
    if (!args.consumedBySettlementId) return { ok: false, reason: 'consumer_required' }
    patch['consumedBySettlementId'] = args.consumedBySettlementId
  }

  await tx.update(schema.quotes).set(patch as never).where(eq(schema.quotes.id, args.quoteId))
  return { ok: true, status: evaluated.to }
}

/**
 * Expire quotes past their `expires_at` — the quote sweeper (Q04).
 *
 * Evaluated against the database clock inside the statement, so there is no
 * window in which the application's idea of "now" differs from the row's.
 */
export async function expireDueQuotes(tx: Db): Promise<number> {
  const result = (await tx.execute(sql`
    UPDATE quotes SET status = 'EXPIRED'
    WHERE status IN ('ACTIVE', 'LOCKED') AND expires_at < now()
    RETURNING id`)) as unknown as { id: string }[]
  return result.length
}

export type QuoteCheck =
  | { usable: true; quote: Quote }
  | { usable: false; problems: readonly QuoteUsabilityProblem[] }

/** Check a quote against a settlement, using the database clock. */
export async function checkQuoteForSettlement(
  tx: Db,
  quoteId: string,
  settlement: {
    workspaceId: string
    environment: 'sandbox' | 'live'
    recipientAmount: Money
    fundingCurrency: string
  },
): Promise<QuoteCheck> {
  const quote = await getQuote(tx, quoteId)
  if (!quote) return { usable: false, problems: ['quote_not_found'] }
  const now = await databaseNow(tx)
  const problems = checkQuoteAttachable(quote, settlement, now)
  return problems.length === 0 ? { usable: true, quote } : { usable: false, problems }
}

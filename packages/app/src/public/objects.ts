/**
 * The public objects — `API_CONTRACT.md § 3` and `§ 7`.
 *
 * Every representation a customer can see is built here, and nothing else
 * builds one. That is not tidiness: `§ 10.1` says a webhook envelope's
 * `data.object` is *"the full settlement object"*, so the event stream and the
 * REST surface must produce the **same** document from the same code. They used
 * not to — the envelope carried the raw event payload, which meant a customer
 * webhook could contain `{"transition": "T01", "to": "DRAFT"}` — the internal
 * machine `§ 10.2` says is not the integration surface, delivered to the
 * integration surface.
 *
 * These live in `packages/app` rather than in `apps/api` for exactly that
 * reason: the worker that delivers webhooks cannot import an app, and a second
 * serializer written for it would drift from the first on its first edit. Three rules the whole file exists to make unbreakable:
 *
 * **`minor_units` is a string** (`§ 3.1`). Not because JSON cannot hold the
 * number, but because JavaScript cannot: a settlement above 2^53 minor units
 * would arrive at a browser client silently rounded. `scale` is echoed beside
 * it so a client never has to guess, and `display` "is for rendering only and
 * must never be parsed".
 *
 * **`status` is the customer projection** (`§ 7.3`). The internal machine has
 * seventeen states and `INV-18` allows exactly one projection of it; the API is
 * that projection's second surface, not a second projection.
 *
 * **No full account number, ever** (`INV-12`, `§ 7.1`). The only account data
 * that reaches this file is the last four digits and a summary string built
 * from them.
 */
import {
  formatFxRate, formatMoney, money, scaleOf, type CurrencyCode, type Money,
} from '@inrsettle/money'
import type { BeneficiaryView, DestinationVersionView } from '../beneficiary.service.js'
import type { BatchSummary } from '../batch.service.js'
import type { Quote } from '@inrsettle/domain'

export type NumberFormat = 'international' | 'indian'

/** `§ 3.1`. */
export function moneyJson(m: Money, format: NumberFormat = 'international'): Record<string, unknown> {
  return {
    currency: m.currency,
    minor_units: m.minorUnits.toString(),
    // The currency table owns the scale. Read, never recomputed from the
    // formatted string, so `display` can change without moving `scale`.
    scale: scaleOf(m.currency),
    // `§ 3.1`: digit grouping follows the workspace's `number_format` setting.
    // Indian grouping applies to INR; a USDT amount is grouped internationally
    // whatever the setting, because ₹50,00,000 and 56,547.652707 USDT are not
    // the same convention.
    display: formatMoney(m, { format: format === 'indian' && m.currency === 'INR' ? 'indian' : 'international' }),
  }
}

/** `§ 3.3` — RFC 3339, always UTC, always `Z`. */
export function timestamp(d: Date | null | undefined): string | null {
  return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : null
}

/* ── Beneficiary — § 7.1 ────────────────────────────────────────────────── */

export function beneficiaryJson(
  b: BeneficiaryView,
  summary: { count: number; totalSettled: Money; lastSettledAt: Date | null } | null,
  environment: string,
  format: NumberFormat,
): Record<string, unknown> {
  const destination = b.destinations.find((d) => d.id === b.defaultDestinationId)
    ?? b.destinations[0]
  return {
    id: b.id,
    object: 'beneficiary',
    environment,
    display_name: b.displayName,
    legal_name: b.legalName,
    type: b.type,
    country: b.country,
    status: b.status,
    destination: destination && destination.currentVersion
      ? destinationJson(destination.id, destination.currentVersion)
      : null,
    settlement_summary: summary === null ? null : {
      count: summary.count,
      total_settled: moneyJson(summary.totalSettled, format),
      last_settled_at: timestamp(summary.lastSettledAt),
    },
    created_at: timestamp(b.createdAt),
  }
}

function destinationJson(
  destinationId: string, v: DestinationVersionView,
): Record<string, unknown> {
  return {
    id: destinationId,
    current_version_id: v.id,
    version_number: v.versionNumber,
    kind: v.kind,
    // Four digits. Never the account number, on any endpoint (INV-12).
    account_number_last4: v.accountNumberLast4,
    ifsc: v.ifsc,
    account_type: v.accountType,
    account_holder_name: v.accountHolderName,
    vpa: v.vpa,
    verification_status: v.verificationStatus,
    verified_at: timestamp(v.verifiedAt),
  }
}

/* ── Quote — § 7.2 ──────────────────────────────────────────────────────── */

export function quoteJson(q: Quote, format: NumberFormat): Record<string, unknown> {
  return {
    id: q.id,
    object: 'quote',
    direction: q.direction === 'RECIPIENT_FIRST' ? 'recipient_first' : 'funding_first',
    recipient_amount: moneyJson(q.recipientAmount, format),
    funding_amount: moneyJson(q.fundingAmount, format),
    fx_rate: {
      pair: q.fxRate.pair,
      // A decimal string, never a float: INR per one unit of the left-hand
      // currency, at scale 10 (`§ 3.2`).
      rate: formatFxRate(q.fxRate),
      scale: q.fxRate.scale,
      quoted_at: timestamp(q.fxRate.quotedAt),
    },
    fees: q.feeComponents.map((f) => ({
      code: f.code,
      label: f.label,
      amount: moneyJson(f.amount, format),
    })),
    // An ExactAmount, not a Money: by construction smaller than one minor unit,
    // so it carries an exact decimal string at scale 12 (§ 7.2). The only field
    // in the API with this shape.
    rounding_residual: {
      currency: q.roundingResidual.currency,
      amount: q.roundingResidual.amount,
      scale: q.roundingResidual.scale,
    },
    estimated_delivery: q.estimatedDelivery,
    status: q.status.toLowerCase(),
    expires_at: timestamp(q.expiresAt),
    created_at: timestamp(q.createdAt),
  }
}

/* ── Settlement return — § 7.5 ──────────────────────────────────────────── */

export interface ReturnJsonInput {
  readonly id: string
  readonly settlement_id: string
  readonly status: string
  readonly amount_minor: string | number | bigint
  readonly amount_currency: string
  readonly reason_code: string
  readonly reason_message: string
  readonly observed_at: Date
  readonly confirmed_at?: Date | null
  readonly repaid_at?: Date | null
}

export function settlementReturnJson(
  r: ReturnJsonInput, format: NumberFormat,
): Record<string, unknown> {
  return {
    id: r.id,
    object: 'settlement_return',
    settlement_id: r.settlement_id,
    status: r.status.toLowerCase(),
    amount: moneyJson(
      money(r.amount_currency as CurrencyCode, BigInt(r.amount_minor)), format,
    ),
    reason_code: r.reason_code,
    reason_message: r.reason_message,
    observed_at: timestamp(r.observed_at),
    confirmed_at: timestamp(r.confirmed_at ?? null),
    repaid_at: timestamp(r.repaid_at ?? null),
  }
}

/* ── Batch — § 8 ────────────────────────────────────────────────────────── */

export function batchJson(b: BatchSummary, format: NumberFormat): Record<string, unknown> {
  return {
    id: b.id,
    object: 'batch',
    name: b.name,
    source: b.source,
    status: b.status.toLowerCase(),
    row_count: b.rowCount,
    valid_count: b.validCount,
    action_required_count: b.actionRequiredCount,
    settled_count: b.settledCount,
    failed_count: b.failedCount,
    total: moneyJson(money(b.totalCurrency as CurrencyCode, b.totalMinor), format),
  }
}

/* ── Event — § 10.1 ─────────────────────────────────────────────────────── */

/**
 * `§ 10.1`'s envelope.
 *
 * `object` is the **resolved public object**, never the event row's payload.
 * The signature says so: there is no `payload` parameter to pass by mistake.
 */
export function eventJson(
  e: { id: string; type: string; createdAt: Date; object: unknown },
  apiVersion: string,
  environment: string,
  workspaceId: string,
): Record<string, unknown> {
  return {
    id: e.id,
    object: 'event',
    type: e.type,
    api_version: apiVersion,
    environment,
    workspace_id: workspaceId,
    created_at: timestamp(e.createdAt),
    data: { object: e.object },
  }
}

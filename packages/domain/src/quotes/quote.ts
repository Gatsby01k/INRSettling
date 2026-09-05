/**
 * The Quote aggregate — `DOMAIN.md § 6.4`, `STATE_MACHINES.md § 6.1`.
 *
 * A quote is its own aggregate with its own lifecycle, not a field on a
 * settlement. That separation is what makes `INV-13` (immutable once created)
 * and `INV-14` (consumed by at most one settlement) statable at all.
 *
 * ```
 * ACTIVE ──lock──▶ LOCKED ──consume──▶ CONSUMED
 *   │                 │
 *   └──expire/void────┴──▶ EXPIRED / VOID
 * ```
 *
 * A locked quote that expires before authorization does **not** silently
 * re-price. The settlement returns to READY (T07) and the customer sees a fresh
 * quote, because a price that changes under someone between clicking and
 * confirming is the thing this whole aggregate exists to prevent.
 */
import type { ExactAmount, FeeComponent, FxRate, Money } from '@inrsettle/money'
import type { QuoteDirection } from '../settlements/authorized-terms.js'

export const QUOTE_STATUSES = ['ACTIVE', 'LOCKED', 'CONSUMED', 'EXPIRED', 'VOID'] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

export const QUOTE_TRIGGERS = ['create', 'lock', 'consume', 'expire', 'void'] as const
export type QuoteTrigger = (typeof QUOTE_TRIGGERS)[number]

export const QUOTE_TRANSITION_IDS = ['Q01', 'Q02', 'Q03', 'Q04', 'Q05'] as const
export type QuoteTransitionId = (typeof QUOTE_TRANSITION_IDS)[number]

export interface QuoteTransition {
  readonly id: QuoteTransitionId
  readonly from: readonly QuoteStatus[]
  readonly trigger: QuoteTrigger
  readonly to: QuoteStatus
  readonly guard: string
}

/** The normative table from `STATE_MACHINES.md § 6.1`. */
export const QUOTE_TRANSITIONS: readonly QuoteTransition[] = [
  { id: 'Q01', from: [], trigger: 'create', to: 'ACTIVE', guard: 'priced against a live rate' },
  { id: 'Q02', from: ['ACTIVE'], trigger: 'lock', to: 'LOCKED', guard: 'attached by T06' },
  {
    id: 'Q03',
    from: ['LOCKED'],
    trigger: 'consume',
    to: 'CONSUMED',
    guard: 'consumed by T08; at most one settlement (INV-14)',
  },
  {
    id: 'Q04',
    from: ['ACTIVE', 'LOCKED'],
    trigger: 'expire',
    to: 'EXPIRED',
    guard: 'now > expires_at, server clock (INV-15)',
  },
  {
    id: 'Q05',
    from: ['ACTIVE', 'LOCKED'],
    trigger: 'void',
    to: 'VOID',
    guard: 'settlement cancelled, or a re-quote requested',
  },
]

export type QuoteTransitionResult =
  | { ok: true; transition: QuoteTransition; to: QuoteStatus }
  | { ok: false; error: 'invalid_quote_transition'; from: QuoteStatus | null; trigger: QuoteTrigger }

export function evaluateQuoteTransition(
  from: QuoteStatus | null,
  trigger: QuoteTrigger,
): QuoteTransitionResult {
  const candidates = QUOTE_TRANSITIONS.filter((t) => {
    if (t.trigger !== trigger) return false
    return from === null ? t.from.length === 0 : (t.from as readonly string[]).includes(from)
  })
  const transition = candidates[0]
  if (!transition || candidates.length > 1) {
    return { ok: false, error: 'invalid_quote_transition', from, trigger }
  }
  return { ok: true, transition, to: transition.to }
}

/** `CONSUMED`, `EXPIRED` and `VOID` have no outgoing transitions. */
export const TERMINAL_QUOTE_STATUSES = ['CONSUMED', 'EXPIRED', 'VOID'] as const
export function isQuoteTerminal(status: QuoteStatus): boolean {
  return (TERMINAL_QUOTE_STATUSES as readonly string[]).includes(status)
}

/* ── The aggregate ─────────────────────────────────────────────────────── */

export interface Quote {
  readonly id: string
  readonly workspaceId: string
  readonly environment: 'sandbox' | 'live'
  /** `INV-08` — exactly one side is authoritative, and it is fixed for life. */
  readonly direction: QuoteDirection
  readonly recipientAmount: Money
  readonly fundingAmount: Money
  readonly fxRate: FxRate
  readonly feeComponents: readonly FeeComponent[]
  readonly roundingResidual: ExactAmount
  /** A band, not a promise: 'under 30 minutes'. */
  readonly estimatedDelivery: string
  readonly status: QuoteStatus
  readonly expiresAt: Date
  readonly createdAt: Date
  readonly lockedAt: Date | null
  readonly consumedBySettlementId: string | null
  /** Which pricing configuration produced it. See `pricing.ts` — `D-08`/`D-09`. */
  readonly pricingVersion: string
}

export type QuoteUsabilityProblem =
  | 'quote_not_found'
  | 'quote_expired'
  | 'quote_consumed'
  | 'quote_void'
  | 'quote_wrong_workspace'
  | 'quote_wrong_environment'
  | 'quote_amount_mismatch'
  | 'quote_currency_mismatch'

/**
 * Can this quote be attached to this settlement (T06)?
 *
 * Expiry is evaluated against `now` supplied by the caller, which the
 * application takes from the **database clock** (`INV-15`). A client-supplied
 * time never reaches here.
 */
export function checkQuoteAttachable(
  quote: Quote,
  settlement: {
    workspaceId: string
    environment: 'sandbox' | 'live'
    recipientAmount: Money
    fundingCurrency: string
  },
  now: Date,
): QuoteUsabilityProblem[] {
  const problems: QuoteUsabilityProblem[] = []
  if (quote.workspaceId !== settlement.workspaceId) problems.push('quote_wrong_workspace')
  if (quote.environment !== settlement.environment) problems.push('quote_wrong_environment')
  if (quote.status === 'CONSUMED') problems.push('quote_consumed')
  if (quote.status === 'VOID') problems.push('quote_void')
  if (quote.status === 'EXPIRED' || now.getTime() > quote.expiresAt.getTime()) {
    problems.push('quote_expired')
  }
  if (
    quote.recipientAmount.minorUnits !== settlement.recipientAmount.minorUnits ||
    quote.recipientAmount.currency !== settlement.recipientAmount.currency
  ) {
    problems.push('quote_amount_mismatch')
  }
  if (quote.fundingAmount.currency !== settlement.fundingCurrency) {
    problems.push('quote_currency_mismatch')
  }
  return problems
}

/**
 * Can this quote be consumed at authorization (T08)?
 *
 * `INV-15` — a settlement may not be authorized against a quote that is
 * EXPIRED, VOID or already CONSUMED. `ACTIVE` is accepted as well as `LOCKED`
 * so that a quote attached and immediately authorized in one flow does not
 * require a redundant lock round trip; the database's single-consumption
 * constraint is what actually enforces `INV-14`.
 */
export function checkQuoteAuthorizable(
  quote: Quote,
  settlement: {
    workspaceId: string
    environment: 'sandbox' | 'live'
    recipientAmount: Money
    fundingCurrency: string
  },
  now: Date,
): QuoteUsabilityProblem[] {
  const problems = checkQuoteAttachable(quote, settlement, now)
  return problems
}

export function isQuoteExpiredAt(quote: Quote, now: Date): boolean {
  return now.getTime() > quote.expiresAt.getTime()
}

/**
 * The fields that may never change after creation (`INV-13`).
 *
 * `status`, `locked_at` and `consumed_by_settlement_id` are the lifecycle and do
 * move; everything describing the *price* is frozen. Named here so the database
 * trigger and the test agree on one list.
 */
export const IMMUTABLE_QUOTE_COLUMNS = [
  'workspace_id',
  'environment',
  'direction',
  'recipient_amount_minor',
  'recipient_amount_currency',
  'funding_amount_minor',
  'funding_amount_currency',
  'fx_rate_scaled',
  'fx_pair',
  'fee_components',
  'rounding_residual',
  'expires_at',
  'created_at',
  'pricing_version',
] as const

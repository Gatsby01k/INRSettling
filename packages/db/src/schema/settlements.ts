/**
 * Stage 3 tables — `DOMAIN.md § 6.4`, `§ 6.5`, `STATE_MACHINES.md § 4`.
 *
 * Column names mirror `migrations/0005_settlements.sql` exactly; the SQL is the
 * source of truth and this is the typed view of it.
 */
import {
  bigint, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { environmentEnum } from './identity.js'

export const quoteStatusEnum = pgEnum('quote_status', ['ACTIVE', 'LOCKED', 'CONSUMED', 'EXPIRED', 'VOID'])
export const quoteDirectionEnum = pgEnum('quote_direction', ['RECIPIENT_FIRST', 'SOURCE_FIRST'])

export const settlementStatusEnum = pgEnum('settlement_status', [
  'DRAFT', 'PREFLIGHTING', 'ACTION_REQUIRED', 'READY', 'QUOTED', 'AUTHORIZED',
  'LIQUIDITY_RESERVING', 'LIQUIDITY_RESERVED', 'DRAWDOWN_REQUESTED', 'DRAWDOWN_CONFIRMED',
  'PAYOUT_SUBMITTED', 'PAYOUT_CONFIRMED', 'RECONCILING', 'EXCEPTION',
  'SETTLED', 'FAILED', 'CANCELLED',
])

export const customerStatusEnum = pgEnum('customer_status', [
  'READY', 'SETTLING', 'SETTLED', 'ACTION_REQUIRED', 'CANCELLED',
])

export const exceptionCodeEnum = pgEnum('settlement_exception_code', [
  'LIQUIDITY_UNAVAILABLE', 'FACILITY_SUSPENDED',
  'DRAWDOWN_FAILED', 'DRAWDOWN_STATUS_UNKNOWN',
  'PAYOUT_REJECTED_DESTINATION', 'PAYOUT_REJECTED_COMPLIANCE',
  'PAYOUT_REJECTED_PROVIDER', 'PAYOUT_STATUS_UNKNOWN',
  'RECONCILIATION_MISMATCH', 'FINALITY_EVIDENCE_MISSING',
])

/** Money crosses the driver boundary as a string; `bigint` mode keeps it exact. */
const minorUnits = (name: string) => bigint(name, { mode: 'bigint' })

export const quotes = pgTable('quotes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  direction: quoteDirectionEnum('direction').notNull(),
  recipientAmountMinor: minorUnits('recipient_amount_minor').notNull(),
  recipientAmountCurrency: text('recipient_amount_currency').notNull(),
  fundingAmountMinor: minorUnits('funding_amount_minor').notNull(),
  fundingAmountCurrency: text('funding_amount_currency').notNull(),
  /** `NUMERIC(28,10)` — read as a string and parsed to a scaled bigint. */
  fxRateScaled: numeric('fx_rate_scaled').notNull(),
  fxPair: text('fx_pair').notNull(),
  fxQuotedAt: timestamp('fx_quoted_at', { withTimezone: true }).notNull(),
  fxSource: text('fx_source').notNull(),
  feeComponents: jsonb('fee_components').notNull(),
  roundingResidual: jsonb('rounding_residual').notNull(),
  estimatedDelivery: text('estimated_delivery').notNull(),
  pricingVersion: text('pricing_version').notNull(),
  status: quoteStatusEnum('status').notNull().default('ACTIVE'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  consumedBySettlementId: text('consumed_by_settlement_id'),
}, (t) => [
  index('quotes_scope_idx').on(t.workspaceId, t.environment, t.createdAt),
  uniqueIndex('quotes_single_consumption').on(t.consumedBySettlementId),
])

export const settlements = pgTable('settlements', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  beneficiaryId: text('beneficiary_id').notNull(),
  destinationId: text('destination_id'),
  /** Frozen at authorization. What payout executes against (`INV-16`). */
  destinationVersionId: text('destination_version_id'),
  recipientAmountMinor: minorUnits('recipient_amount_minor').notNull(),
  recipientAmountCurrency: text('recipient_amount_currency').notNull(),
  fundingCurrency: text('funding_currency').notNull(),
  purposeCode: text('purpose_code'),
  quoteId: text('quote_id'),
  authorizedTerms: jsonb('authorized_terms'),
  authorizedTermsHash: text('authorized_terms_hash'),
  status: settlementStatusEnum('status').notNull().default('DRAFT'),
  /** Derived, never independently set (`INV-18`). Null for DRAFT. */
  customerStatus: customerStatusEnum('customer_status'),
  exceptionEnteredFrom: settlementStatusEnum('exception_entered_from'),
  openExceptionCode: exceptionCodeEnum('open_exception_code'),
  externalReference: text('external_reference'),
  idempotencyKey: text('idempotency_key'),
  replacesSettlementId: text('replaces_settlement_id'),
  authorizedAt: timestamp('authorized_at', { withTimezone: true }),
  authorizedBy: text('authorized_by'),
  cancellationRequestedAt: timestamp('cancellation_requested_at', { withTimezone: true }),
  cancellationRequestedBy: text('cancellation_requested_by'),
  /** Stamped by the dispatch transaction; never cleared (`INV-36`). */
  pointOfNoReturnAt: timestamp('point_of_no_return_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  reservationId: text('reservation_id'),
  drawdownId: text('drawdown_id'),
  payoutAttemptId: text('payout_attempt_id'),
  receiptId: text('receipt_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  version: integer('version').notNull().default(1),
}, (t) => [
  index('settlements_scope_idx').on(t.workspaceId, t.environment, t.createdAt),
  index('settlements_status_idx').on(t.workspaceId, t.environment, t.status),
  index('settlements_beneficiary_idx').on(t.beneficiaryId),
])

/**
 * The durable dispatch identity (`INV-36`). Stage 3 records the intent; Stage 5
 * owns the provider adapter and adds nothing to this table until then.
 */
export const payoutRailEnum = pgEnum('payout_rail', ['NEFT', 'RTGS', 'IMPS', 'UPI'])

export const payoutAttemptStatusEnum = pgEnum('payout_attempt_status', [
  'SUBMITTED', 'ACCEPTED', 'CREDITED', 'REJECTED', 'RETURNED', 'UNKNOWN',
])

export const payoutAttempts = pgTable('payout_attempts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  settlementId: text('settlement_id').notNull(),
  destinationVersionId: text('destination_version_id').notNull(),
  /** INV-24: monotonic per settlement. The only thing that advances identity. */
  attemptNumber: integer('attempt_number').notNull(),
  status: payoutAttemptStatusEnum('status').notNull().default('SUBMITTED'),
  /** INV-25: settlement_id + attempt_number, and nothing else. */
  idempotencyKey: text('idempotency_key').notNull(),
  providerReference: text('provider_reference'),
  utr: text('utr'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }).notNull().defaultNow(),
  dispatchedBy: text('dispatched_by').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  /* Stage 5 — the provider-facing facts of an execution. */
  providerId: text('provider_id'),
  rail: payoutRailEnum('rail'),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }),
  amountCurrency: text('amount_currency'),
  /**
   * What the rail says actually reached the beneficiary, in `amountCurrency`.
   * `null` means the provider stated no figure — never the same thing as "it
   * credited the full amount" (`INV-26`).
   */
  creditedMinor: bigint('credited_minor', { mode: 'bigint' }),
  /** The provider's own code, stored unmapped (`INV-43`). */
  rawCode: text('raw_code'),
  mappingVersion: text('mapping_version'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  creditedAt: timestamp('credited_at', { withTimezone: true }),
  returnedAt: timestamp('returned_at', { withTimezone: true }),
  /** The SLA this attempt was dispatched under, not the one declared today. */
  slaSeconds: integer('sla_seconds'),
}, (t) => [
  uniqueIndex('payout_attempts_settlement_id_attempt_number_key').on(t.settlementId, t.attemptNumber),
  uniqueIndex('payout_attempts_idempotency_key').on(t.idempotencyKey),
])

export const settlementExceptions = pgTable('settlement_exceptions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  settlementId: text('settlement_id').notNull(),
  code: exceptionCodeEnum('code').notNull(),
  enteredFrom: settlementStatusEnum('entered_from').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  providerRawCode: text('provider_raw_code'),
  providerRawMessage: text('provider_raw_message'),
  providerEventId: text('provider_event_id'),
  classification: text('classification'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by'),
  resolutionReason: text('resolution_reason'),
}, (t) => [index('settlement_exceptions_scope_idx').on(t.workspaceId, t.environment)])

/**
 * Versioned provider vocabulary mappings — `INV-43`, *"data, not code"*.
 *
 * Global rather than tenant-scoped, exactly like the preflight rule sets: the
 * same table interprets every workspace's events, and `source` is what stops a
 * sandbox fixture being mistaken for a provider's documented contract.
 */
export const providerMappingTables = pgTable('provider_mapping_tables', {
  version: text('version').primaryKey(),
  providerId: text('provider_id').notNull(),
  source: text('source').notNull(),
  description: text('description').notNull(),
  codes: jsonb('codes').notNull(),
  checksum: text('checksum').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

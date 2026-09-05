/**
 * Stage 6 tables — `DOMAIN.md §§ 6.8–6.10`, `STATE_MACHINES.md § 6.4`, `§ 6.6`, `§ 8`.
 *
 * Column names mirror `migrations/0009_reconciliation_finality_returns.sql`
 * exactly; the SQL is the source of truth and this is the typed view of it.
 *
 * Note what is absent: any Drizzle relation writing back to `settlements`. A
 * return references a settled settlement and modifies nothing about it
 * (`INV-42`), and the cheapest way to keep that true is for the typed surface to
 * offer no way to express the write.
 */
import {
  bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { environmentEnum } from './identity.js'

export const reconciliationStatusEnum = pgEnum('reconciliation_status', [
  'PENDING', 'MATCHED', 'MISMATCH', 'MANUAL_REVIEW',
])

export const settlementReturnStatusEnum = pgEnum('settlement_return_status', [
  'OBSERVED', 'CONFIRMED', 'REPAID', 'REJECTED', 'MANUAL_REVIEW',
])

export const returnReasonCodeEnum = pgEnum('return_reason_code', [
  'BENEFICIARY_ACCOUNT_CLOSED',
  'BENEFICIARY_ACCOUNT_INVALID',
  'BENEFICIARY_NAME_MISMATCH',
  'BENEFICIARY_ACCOUNT_BLOCKED',
  'REFUSED_BY_BENEFICIARY',
  'COMPLIANCE_AT_BENEFICIARY_BANK',
  'RAIL_REVERSAL',
  'RETURN_REASON_UNMAPPED',
])

export const artifactKindEnum = pgEnum('artifact_kind', [
  'settlement_receipt', 'return_notice', 'receipt_composite',
])

export const reconciliations = pgTable('reconciliations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  settlementId: text('settlement_id').notNull(),
  status: reconciliationStatusEnum('status').notNull().default('PENDING'),
  expectedMinor: bigint('expected_minor', { mode: 'bigint' }).notNull(),
  /** `null` means the provider stated no figure — not the same as zero. */
  observedMinor: bigint('observed_minor', { mode: 'bigint' }),
  /** Signed: observed minus expected. Negative is short, positive is over. */
  deltaMinor: bigint('delta_minor', { mode: 'bigint' }).notNull().default(0n),
  currency: text('currency').notNull(),
  source: text('source'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
  slaSeconds: integer('sla_seconds').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by'),
  resolutionNote: text('resolution_note'),
  compensationRequired: boolean('compensation_required'),
}, (t) => [
  uniqueIndex('reconciliations_settlement_key').on(t.settlementId),
  index('reconciliations_scope_idx').on(t.workspaceId, t.environment, t.status),
])

export const settlementReturns = pgTable('settlement_returns', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  settlementId: text('settlement_id').notNull(),
  payoutAttemptId: text('payout_attempt_id').notNull(),
  status: settlementReturnStatusEnum('status').notNull().default('OBSERVED'),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  amountCurrency: text('amount_currency').notNull(),
  reasonCode: returnReasonCodeEnum('reason_code').notNull(),
  reasonMessage: text('reason_message').notNull(),
  providerRawReason: text('provider_raw_reason'),
  /** `INV-39`. Two values only; there is no operator assertion. */
  openedBySource: text('opened_by_source').notNull(),
  providerEventId: text('provider_event_id'),
  /** `INV-50`'s second dedupe key, with `payout_attempt_id`. */
  providerReturnReference: text('provider_return_reference').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  repaidAt: timestamp('repaid_at', { withTimezone: true }),
  repaymentId: text('repayment_id'),
  /** `§ 8.6` triage evidence, stored because `D-04` is open on the duration. */
  windowSecondsAtOpen: integer('window_seconds_at_open'),
  arrivalElapsedSeconds: integer('arrival_elapsed_seconds'),
  arrivedWithinWindow: boolean('arrived_within_window'),
  resolvedBy: text('resolved_by'),
  resolutionNote: text('resolution_note'),
}, (t) => [
  uniqueIndex('settlement_returns_dedupe_key').on(t.payoutAttemptId, t.providerReturnReference),
  index('settlement_returns_settlement_idx').on(t.settlementId, t.observedAt),
  index('settlement_returns_scope_idx').on(t.workspaceId, t.environment, t.status),
])

/** Append-only sightings — `INV-50`. Each channel that reported one return. */
export const returnObservations = pgTable('return_observations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  returnId: text('return_id').notNull(),
  source: text('source').notNull(),
  providerEventId: text('provider_event_id'),
  /** What this channel reported, in the currency it reported it in. */
  observedAmountMinor: bigint('observed_amount_minor', { mode: 'bigint' }),
  observedAmountCurrency: text('observed_amount_currency'),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  openedTheReturn: boolean('opened_the_return').notNull().default(false),
  payload: jsonb('payload'),
}, (t) => [
  index('return_observations_return_idx').on(t.returnId, t.observedAt),
  index('return_observations_scope_idx').on(t.workspaceId, t.environment),
])

/** Receipts, return notices and composites — one shape, `INV-29` and `INV-48`. */
export const financialArtifacts = pgTable('financial_artifacts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  kind: artifactKindEnum('kind').notNull(),
  settlementId: text('settlement_id').notNull(),
  returnId: text('return_id'),
  receiptId: text('receipt_id'),
  /** The receipt's hash, on a notice or composite. Composition, not absorption. */
  sourceContentHash: text('source_content_hash'),
  /** The exact bytes the hash is over, and that the PDF renders. */
  canonicalBytes: text('canonical_bytes').notNull(),
  contentHash: text('content_hash').notNull(),
  pdfObjectKey: text('pdf_object_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('financial_artifacts_object_key').on(t.pdfObjectKey),
  index('financial_artifacts_settlement_idx').on(t.settlementId, t.kind, t.createdAt),
  index('financial_artifacts_scope_idx').on(t.workspaceId, t.environment),
])

/** Every verdict, passing and failing — `STATE_MACHINES.md § 8.1`. */
export const finalityEvaluations = pgTable('finality_evaluations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  settlementId: text('settlement_id').notNull(),
  final: boolean('final').notNull(),
  conditions: jsonb('conditions').notNull(),
  missing: text('missing').array().notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('finality_evaluations_settlement_idx').on(t.settlementId, t.evaluatedAt),
  index('finality_evaluations_scope_idx').on(t.workspaceId, t.environment),
])

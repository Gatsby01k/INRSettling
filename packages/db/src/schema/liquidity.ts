/**
 * Stage 4 tables — `DOMAIN.md § 6.6`, `STATE_MACHINES.md § 6.2`, `§ 6.5`.
 *
 * Column names mirror `migrations/0006_liquidity.sql` exactly; the SQL is the
 * source of truth and this is the typed view of it. In particular `drawn_minor`
 * and `reserved_minor` are *projections of the ledger* (`INV-23`), not
 * independent counters — reading them is a cache read, and the rebuild test
 * compares them against `project_facility_position()`.
 */
import {
  bigint, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { environmentEnum } from './identity.js'

export const facilityStatusEnum = pgEnum('facility_status', ['ACTIVE', 'SUSPENDED', 'CLOSED'])
export const reservationStatusEnum = pgEnum('reservation_status', [
  'ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED',
])
export const drawdownStatusEnum = pgEnum('drawdown_status', [
  'REQUESTED', 'CONFIRMED', 'FAILED', 'UNKNOWN',
])
export const repaymentStatusEnum = pgEnum('repayment_status', [
  'REQUESTED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN',
])
export const repaymentSourceEnum = pgEnum('repayment_source', [
  'CANCELLATION_AFTER_DRAWDOWN', 'SETTLEMENT_RETURN', 'MANUAL', 'SCHEDULED',
])
export const ledgerAccountEnum = pgEnum('ledger_account', ['available', 'reserved', 'drawn'])
export const ledgerDirectionEnum = pgEnum('ledger_direction', ['debit', 'credit'])
export const ledgerMovementEnum = pgEnum('ledger_movement', [
  'reservation_created', 'reservation_released', 'reservation_expired',
  'reservation_consumed', 'repayment_confirmed', 'limit_changed',
])

export const liquidityFacilities = pgTable('liquidity_facilities', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  providerId: text('provider_id').notNull(),
  currency: text('currency').notNull(),
  /** `currency` governs this, `drawnMinor` and `reservedMinor` alike. */
  limitMinor: bigint('limit_minor', { mode: 'bigint' }).notNull(),
  status: facilityStatusEnum('status').notNull().default('ACTIVE'),
  /** Projection of the ledger (`INV-23`), not a counter. */
  drawnMinor: bigint('drawn_minor', { mode: 'bigint' }).notNull().default(0n),
  /** Projection of the ledger (`INV-23`), not a counter. */
  reservedMinor: bigint('reserved_minor', { mode: 'bigint' }).notNull().default(0n),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(0),
}, (t) => [
  index('liquidity_facilities_scope_idx').on(t.workspaceId, t.environment),
])

export const liquidityReservations = pgTable('liquidity_reservations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  facilityId: text('facility_id').notNull(),
  settlementId: text('settlement_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  amountCurrency: text('amount_currency').notNull(),
  status: reservationStatusEnum('status').notNull().default('ACTIVE'),
  /** `D-05`: the mechanism is closed here; the duration is configuration. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedReason: text('released_reason'),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => [
  index('liquidity_reservations_facility_idx').on(t.facilityId, t.status),
  index('liquidity_reservations_scope_idx').on(t.workspaceId, t.environment),
])

export const drawdowns = pgTable('drawdowns', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  facilityId: text('facility_id').notNull(),
  settlementId: text('settlement_id').notNull(),
  reservationId: text('reservation_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  amountCurrency: text('amount_currency').notNull(),
  status: drawdownStatusEnum('status').notNull().default('REQUESTED'),
  requestFingerprint: text('request_fingerprint').notNull(),
  providerReference: text('provider_reference'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  requestedBy: text('requested_by').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('drawdowns_request_fingerprint_key').on(t.requestFingerprint),
  index('drawdowns_scope_idx').on(t.workspaceId, t.environment),
])

export const repayments = pgTable('repayments', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  facilityId: text('facility_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  amountCurrency: text('amount_currency').notNull(),
  source: repaymentSourceEnum('source').notNull(),
  settlementId: text('settlement_id'),
  returnId: text('return_id'),
  status: repaymentStatusEnum('status').notNull().default('REQUESTED'),
  /** `INV-47`: Y08 advances this, which is what mints a new fingerprint. */
  attempt: integer('attempt').notNull().default(1),
  requestFingerprint: text('request_fingerprint').notNull(),
  providerReference: text('provider_reference'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('repayments_request_fingerprint_key').on(t.requestFingerprint),
  index('repayments_facility_idx').on(t.facilityId, t.status),
  index('repayments_scope_idx').on(t.workspaceId, t.environment),
])

export const ledgerEntries = pgTable('ledger_entries', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  facilityId: text('facility_id').notNull(),
  /** The two rows of one movement share this. */
  transferId: text('transfer_id').notNull(),
  movement: ledgerMovementEnum('movement').notNull(),
  account: ledgerAccountEnum('account').notNull(),
  direction: ledgerDirectionEnum('direction').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  amountCurrency: text('amount_currency').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
}, (t) => [
  uniqueIndex('ledger_entries_transfer_id_account_key').on(t.transferId, t.account),
  index('ledger_entries_facility_idx').on(t.facilityId, t.createdAt),
  index('ledger_entries_scope_idx').on(t.workspaceId, t.environment),
])

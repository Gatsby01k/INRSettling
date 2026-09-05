/**
 * Stage 7 tables — `DOMAIN.md § 6.11`, `PRODUCT.md § 10`.
 *
 * Column names mirror `migrations/0010_batches.sql` exactly; the SQL is the
 * source of truth and this is the typed view of it.
 *
 * Note the absence of a Drizzle relation from `settlements` back to a batch. A
 * settlement created in a batch is a settlement first (`INV-30`), and giving the
 * typed surface a batch pointer on the settlement would invite code that treats
 * membership as part of a settlement's identity — which is how a container
 * quietly becomes a transaction.
 */
import {
  bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { environmentEnum } from './identity.js'

export const batchStatusEnum = pgEnum('batch_status', [
  'DRAFT', 'VALIDATING', 'READY', 'EXECUTING', 'COMPLETED', 'PARTIALLY_COMPLETED',
])

export const batchSourceEnum = pgEnum('batch_source', ['CSV', 'API'])

export const batchRowOutcomeEnum = pgEnum('batch_row_outcome', [
  'INVALID', 'ACCEPTED', 'ACTION_REQUIRED', 'SETTLED', 'FAILED', 'CANCELLED',
])

export const batches = pgTable('batches', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  name: text('name').notNull(),
  source: batchSourceEnum('source').notNull(),
  status: batchStatusEnum('status').notNull().default('DRAFT'),
  /* Derived from the rows on every refresh, never incremented in place. */
  rowCount: integer('row_count').notNull().default(0),
  validCount: integer('valid_count').notNull().default(0),
  actionRequiredCount: integer('action_required_count').notNull().default(0),
  settledCount: integer('settled_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull().default(0n),
  totalCurrency: text('total_currency').notNull().default('INR'),
  /** The file's own content hash — how a re-upload is recognised as one. */
  importFingerprint: text('import_fingerprint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('batches_import_fingerprint_key')
    .on(t.workspaceId, t.environment, t.importFingerprint),
  index('batches_scope_idx').on(t.workspaceId, t.environment, t.createdAt),
])

export const batchRows = pgTable('batch_rows', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  batchId: text('batch_id').notNull(),
  /** 1-based, counting the header as line 1 — what the spreadsheet shows. */
  lineNumber: integer('line_number').notNull(),
  outcome: batchRowOutcomeEnum('outcome').notNull(),
  /** Set exactly when the row became a settlement. */
  settlementId: text('settlement_id'),
  /** What the file said, verbatim. */
  raw: jsonb('raw').notNull(),
  /** Per-row errors, each naming the column and the fix. Empty when valid. */
  errors: jsonb('errors').notNull().default([]),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }),
  amountCurrency: text('amount_currency'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('batch_rows_line_key').on(t.batchId, t.lineNumber),
  uniqueIndex('batch_rows_settlement_key').on(t.settlementId),
  index('batch_rows_batch_idx').on(t.batchId, t.lineNumber),
  index('batch_rows_scope_idx').on(t.workspaceId, t.environment),
])

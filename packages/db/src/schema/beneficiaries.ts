/**
 * Stage 2 tables — DOMAIN.md § 6.2 and § 6.3.
 *
 * Column names mirror `migrations/0004_beneficiaries.sql` exactly; the SQL is
 * the source of truth and this file is the typed view of it.
 */
import {
  boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { environmentEnum } from './identity.js'

export const beneficiaryTypeEnum   = pgEnum('beneficiary_type', ['individual', 'business'])
export const beneficiaryStatusEnum = pgEnum('beneficiary_status', [
  'draft', 'pending_verification', 'verified', 'rejected', 'disabled',
])
export const destinationKindEnum     = pgEnum('destination_kind', ['bank_account', 'upi'])
export const verificationStatusEnum  = pgEnum('verification_status', [
  'unverified', 'verifying', 'verified', 'failed',
])
export const verificationMethodEnum  = pgEnum('verification_method', [
  'penny_drop', 'provider_lookup', 'manual',
])

export const beneficiaries = pgTable('beneficiaries', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  displayName: text('display_name').notNull(),
  legalName: text('legal_name'),
  type: beneficiaryTypeEnum('type').notNull(),
  country: text('country').notNull().default('IN'),
  /** PAN, encrypted (INV-12 applies to every account identifier, not just bank). */
  taxIdCiphertext: text('tax_id_ciphertext'),
  taxIdLast4: text('tax_id_last4'),
  status: beneficiaryStatusEnum('status').notNull().default('draft'),
  defaultDestinationId: text('default_destination_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => [
  index('beneficiaries_scope_idx').on(t.workspaceId, t.environment, t.createdAt),
])

export const payoutDestinations = pgTable('payout_destinations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  beneficiaryId: text('beneficiary_id').notNull(),
  kind: destinationKindEnum('kind').notNull(),
  currentVersionId: text('current_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => [
  index('payout_destinations_scope_idx').on(t.workspaceId, t.environment),
  index('payout_destinations_ben_idx').on(t.beneficiaryId),
])

/** Append-only (INV-44). The database enforces it; this type does not pretend to. */
export const payoutDestinationVersions = pgTable('payout_destination_versions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  destinationId: text('destination_id').notNull(),
  versionNumber: integer('version_number').notNull(),
  kind: destinationKindEnum('kind').notNull(),
  accountNumberCiphertext: text('account_number_ciphertext'),
  accountNumberLast4: text('account_number_last4'),
  ifsc: text('ifsc'),
  accountType: text('account_type'),
  accountHolderName: text('account_holder_name'),
  vpa: text('vpa'),
  /** Keyed HMAC; opaque, never exposed. See crypto/destination-fingerprint.ts. */
  detailsFingerprint: text('details_fingerprint').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('payout_destination_versions_destination_id_version_number_key')
    .on(t.destinationId, t.versionNumber),
  index('pdv_scope_idx').on(t.workspaceId, t.environment),
  index('pdv_dest_idx').on(t.destinationId, t.versionNumber),
])

/** Attaches to a version, never to a destination (INV-45). */
export const destinationVerifications = pgTable('destination_verifications', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  destinationVersionId: text('destination_version_id').notNull(),
  status: verificationStatusEnum('status').notNull().default('verifying'),
  method: verificationMethodEnum('method').notNull(),
  providerId: text('provider_id').notNull(),
  providerReference: text('provider_reference'),
  nameMatchOutcome: text('name_match_outcome'),
  nameMatchBasis: text('name_match_basis'),
  nameMatchScore: integer('name_match_score'),
  nameMatchPolicyVersion: text('name_match_policy_version'),
  reasonCode: text('reason_code'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  requestedBy: text('requested_by').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  providerEventId: text('provider_event_id'),
}, (t) => [
  index('dv_scope_idx').on(t.workspaceId, t.environment),
  index('dv_version_idx').on(t.destinationVersionId),
])

/** Raw provider payloads, stored before interpretation (INV-33). */
export const providerEvents = pgTable('provider_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  providerId: text('provider_id').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  interpretedAt: timestamp('interpreted_at', { withTimezone: true }),
  interpretation: text('interpretation'),
  /* Stage 5 — what the event was about, and the INV-43 alarm made queryable. */
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  unmappedCode: text('unmapped_code'),
}, (t) => [
  uniqueIndex('provider_events_dedupe').on(t.providerId, t.providerEventId),
  index('provider_events_scope_idx').on(t.workspaceId, t.environment, t.receivedAt),
])

/* ── Reference data (global, not tenant-scoped) ────────────────────────── */

export const preflightRuleSets = pgTable('preflight_rule_sets', {
  version: text('version').primaryKey(),
  source: text('source').notNull(),
  description: text('description').notNull(),
  rules: jsonb('rules').notNull(),
  checksum: text('checksum').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const purposeCodes = pgTable('purpose_codes', {
  ruleSetVersion: text('rule_set_version').notNull(),
  code: text('code').notNull(),
  label: text('label').notNull(),
  /** NULL while D-06 is open. A sandbox fixture may never set it. */
  regulatoryCode: text('regulatory_code'),
  source: text('source').notNull(),
}, (t) => [primaryKey({ columns: [t.ruleSetVersion, t.code] })])

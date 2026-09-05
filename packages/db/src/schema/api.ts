/**
 * Stage 8 tables — migration `0012_public_api.sql`.
 *
 * The SQL is the source of truth for constraints, policies and grants; this is
 * the typed view of it. Where a column's shape carries an argument, the argument
 * is in the migration, not repeated here.
 */
import { sql } from 'drizzle-orm'
import {
  boolean, index, integer, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { environmentEnum } from './identity.js'

export const idempotencyClaims = pgTable(
  'idempotency_claims',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    environment: environmentEnum('environment').notNull(),
    /** The concrete request target, ids resolved — never a route template. */
    endpoint: text('endpoint').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    fingerprintVersion: text('fingerprint_version').notNull(),
    requestId: text('request_id').notNull(),
    subjectId: text('subject_id'),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_claims_key').on(
      t.workspaceId, t.environment, t.endpoint, t.idempotencyKey,
    ),
    index('idempotency_claims_expiry').on(t.expiresAt),
  ],
)

export const apiRequests = pgTable(
  'api_requests',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    environment: environmentEnum('environment').notNull(),
    apiKeyId: text('api_key_id'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    route: text('route').notNull(),
    status: integer('status').notNull(),
    errorType: text('error_type'),
    errorCode: text('error_code'),
    apiVersion: text('api_version').notNull(),
    idempotencyKey: text('idempotency_key'),
    idempotencyReplayed: boolean('idempotency_replayed').notNull().default(false),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_requests_scope_idx').on(t.workspaceId, t.environment, t.createdAt)],
)

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    environment: environmentEnum('environment').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    /** Empty means every customer-visible type. */
    eventTypes: text('event_types').array().notNull().default(sql`'{}'`),
    status: text('status').notNull().default('enabled')
      .$type<'enabled' | 'disabled' | 'circuit_open' | 'deleted'>(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    previousSecretCiphertext: text('previous_secret_ciphertext'),
    previousSecretExpiresAt: timestamp('previous_secret_expires_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    circuitOpenedAt: timestamp('circuit_opened_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (t) => [index('webhook_endpoints_scope_idx').on(t.workspaceId, t.environment)],
)

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    environment: environmentEnum('environment').notNull(),
    endpointId: text('endpoint_id').notNull(),
    eventId: text('event_id').notNull(),
    origin: text('origin').notNull().default('outbox').$type<'outbox' | 'replay' | 'test'>(),
    status: text('status').notNull().default('pending')
      .$type<'pending' | 'delivering' | 'succeeded' | 'failed' | 'exhausted'>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_deliveries_event_idx').on(t.workspaceId, t.environment, t.eventId)],
)

export const webhookAttempts = pgTable(
  'webhook_attempts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    environment: environmentEnum('environment').notNull(),
    deliveryId: text('delivery_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    statusCode: integer('status_code'),
    responseBody: text('response_body'),
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('webhook_attempts_sequence').on(t.deliveryId, t.attemptNumber)],
)

export const apiRateLimits = pgTable('api_rate_limits', {
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  apiKeyId: text('api_key_id').notNull(),
  bucket: text('bucket').notNull().$type<'read' | 'write' | 'batch'>(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
})

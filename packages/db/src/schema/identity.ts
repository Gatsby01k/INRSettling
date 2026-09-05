import {
  boolean, index, inet, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const environmentEnum   = pgEnum('environment', ['sandbox', 'live'])
export const workspaceRoleEnum = pgEnum('workspace_role', ['viewer', 'operator', 'approver', 'admin', 'developer'])
export const principalTypeEnum = pgEnum('principal_type', ['user', 'api_key', 'job', 'provider', 'operator'])
export const kybStatusEnum     = pgEnum('kyb_status', ['pending', 'approved', 'rejected', 'suspended'])
export const mfaMethodEnum     = pgEnum('mfa_method', ['totp', 'webauthn'])

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  kybStatus: kybStatusEnum('kyb_status').notNull().default('pending'),
  numberFormat: text('number_format').notNull().default('international'),
  /** API_CONTRACT.md § 2 — the dated version this workspace is pinned to. */
  apiVersion: text('api_version').notNull().default('2026-08-31'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  fullName: text('full_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
})

export const userMfaMethods = pgTable('user_mfa_methods', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  method: mfaMethodEnum('method').notNull(),
  label: text('label'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('user_mfa_methods_user_idx').on(t.userId)])

export const memberships = pgTable('memberships', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by'),
}, (t) => [
  uniqueIndex('memberships_workspace_id_environment_user_id_key')
    .on(t.workspaceId, t.environment, t.userId),
  index('memberships_scope_idx').on(t.workspaceId, t.environment),
])

/** Roles are a set, not a column: SECURITY.md § 3.2 grants admin + approver. */
export const membershipRoles = pgTable('membership_roles', {
  membershipId: text('membership_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  role: workspaceRoleEnum('role').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  grantedBy: text('granted_by'),
}, (t) => [
  primaryKey({ columns: [t.membershipId, t.role] }),
  index('membership_roles_scope_idx').on(t.workspaceId, t.environment),
])

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  userId: text('user_id').notNull(),
  mfaMethod: mfaMethodEnum('mfa_method').notNull(),
  deviceFingerprint: text('device_fingerprint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
}, (t) => [index('sessions_user_idx').on(t.workspaceId, t.environment, t.userId)])

export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  secretSha256: text('secret_sha256').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('api_keys_scope_idx').on(t.workspaceId, t.environment)])

/** Decision D-007 — separation of duties, per workspace and per environment. */
export const workspaceSecurityPolicies = pgTable('workspace_security_policies', {
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  separationOfDutiesEnabled: boolean('separation_of_duties_enabled').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByType: principalTypeEnum('updated_by_type'),
  updatedById: text('updated_by_id'),
})

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  type: text('type').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  actorType: principalTypeEnum('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  actorType: principalTypeEnum('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  requestId: text('request_id'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const outbox = pgTable('outbox', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  environment: environmentEnum('environment').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
})

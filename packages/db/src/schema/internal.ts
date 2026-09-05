/**
 * Stage 9 tables — migration `0017_internal_operations.sql`.
 *
 * INRSettle staff identity and the record of what staff did. The SQL is the
 * source of truth for constraints, policies and grants; this is the typed view.
 *
 * Note what is *not* here: no ops write table for settlements, facilities or
 * anything else financial. An operator action on a settlement is a
 * tenant-scoped write through the ordinary application role, using the same
 * services a customer action uses, so there is no second set of tables and no
 * second set of triggers to keep in step.
 */
import { index, inet, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { environmentEnum, mfaMethodEnum } from './identity.js'

export const internalRoleEnum = pgEnum(
  'internal_role', ['ops_read', 'ops_resolve', 'ops_liquidity', 'ops_admin'],
)

export const internalOperators = pgTable(
  'internal_operators',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().$type<'active' | 'suspended'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (t) => ({ email: uniqueIndex('internal_operators_email').on(sql`lower(${t.email})`) }),
)

export const internalOperatorRoles = pgTable(
  'internal_operator_roles',
  {
    operatorId: text('operator_id').notNull(),
    role: internalRoleEnum('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedBy: text('granted_by').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.operatorId, t.role] }) }),
)

export const internalSessions = pgTable(
  'internal_sessions',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id').notNull(),
    /** NOT NULL in the migration: a session without a second factor is unrepresentable. */
    mfaMethod: mfaMethodEnum('mfa_method').notNull(),
    /**
     * NOT NULL, where `sessions.device_fingerprint` is nullable.
     *
     * `SECURITY.md § 3.1` binds every human session to a device and makes ops
     * sessions *additionally* restricted — so an unbound ops session cannot
     * exist, rather than being refused by a check somebody could skip.
     */
    deviceFingerprint: text('device_fingerprint').notNull(),
    ip: inet('ip').notNull(),
    /** Which allow-list admitted this address, so the decision is answerable later. */
    networkPolicy: text('network_policy').notNull(),
    userAgent: text('user_agent'),
    establishedAt: timestamp('established_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => ({ operator: index('internal_sessions_operator').on(t.operatorId, t.establishedAt) }),
)

/**
 * Every cross-tenant read and every operator write, with its reason.
 *
 * Append-only in the database. `kind` distinguishes the two, because
 * `SECURITY.md § 2` requires reads to be recorded and a table that held only
 * writes would answer "who changed this" while leaving "who looked at this"
 * unanswerable.
 */
export const operatorActions = pgTable(
  'operator_actions',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id').notNull(),
    sessionId: text('session_id'),
    kind: text('kind').notNull().$type<'read' | 'write'>(),
    action: text('action').notNull(),
    workspaceId: text('workspace_id').notNull(),
    environment: environmentEnum('environment').notNull(),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    reason: text('reason').notNull(),
    requestId: text('request_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    operator: index('operator_actions_operator').on(t.operatorId, t.createdAt),
    workspace: index('operator_actions_workspace')
      .on(t.workspaceId, t.environment, t.createdAt),
    subject: index('operator_actions_subject').on(t.subjectType, t.subjectId, t.createdAt),
  }),
)

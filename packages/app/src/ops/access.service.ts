/**
 * The one way Internal Operations reads another tenant's data.
 *
 * `SECURITY.md § 2`:
 *
 * > Cross-tenant reads exist only in Internal Operations, only through an
 * > explicitly named role, and **every one is written to the audit log with the
 * > operator, the workspace and the reason**.
 *
 * Three clauses, three mechanisms:
 *
 * **"only in Internal Operations"** — the ops pool is a connection as
 * `inrsettle_ops`, a role with `SELECT` and nothing else, whose permissive
 * policies exist on 24 named tables and no others (migration `0017`). The
 * customer-facing application never holds it; the isolation gate asserts
 * neither role is a member of the other, in either direction.
 *
 * **"through an explicitly named role"** — that role, by name, rather than
 * `BYPASSRLS`.
 *
 * **"every one is written to the audit log"** — this file. Every function that
 * reads across tenants goes through `withOperatorRead`, which will not perform
 * the read until the audit records for it are committed.
 *
 * ## Audit first, then read
 *
 * The order is the point, and it is why every read here declares the workspaces
 * it is about to touch rather than discovering them as it goes.
 *
 * Read-then-audit has a window: the read succeeds, the audit write fails or the
 * process dies, and a cross-tenant read has happened with no record of it. That
 * is precisely the failure the requirement exists to prevent, so the order is
 * inverted — the audit is committed first, in its own transaction, and the read
 * only happens afterwards. The cost is over-recording: an audit row for a read
 * that then failed. A record of a read that did not happen is a much better
 * defect than a read with no record.
 *
 * A queue spanning many workspaces cannot know its scopes in advance, so it
 * gets them from a **discovery** step that returns scope pairs and nothing else
 * — the same shape as `pending_outbox_scopes`, and for the same reason. Every
 * workspace that discovery names is then audited before any of its content is
 * read.
 *
 * ## Two writes, on purpose
 *
 * Each read writes two rows:
 *
 *   * one into the workspace's own `audit_log`, where **the customer can see
 *     it** — they are entitled to know that INRSettle looked at their
 *     settlement, who did, and why;
 *   * one into `operator_actions`, the cross-tenant view, so "what has this
 *     operator been doing" is one query rather than a scan of every workspace.
 *
 * Neither is redundant: the first is scoped and the customer's, the second
 * spans tenants and is ours. They are written in one transaction per workspace,
 * so a workspace never gets one without the other.
 */
import { sql } from 'drizzle-orm'
import type { Db, TenantScope } from '@inrsettle/db'
import { schema, withTenant, withoutScope } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import { validateReason, type InternalCapability, type ReasonRefusal } from '@inrsettle/domain'
import { eventSink } from '../events.js'
import type { ActiveOperator } from './session.service.js'

/* ── Refusals ───────────────────────────────────────────────────────────── */

export type OperatorRefusal =
  | { reason: 'insufficient_capability'; required: InternalCapability }
  | { reason: ReasonRefusal }

export class OperatorAccessRefused extends Error {
  constructor(readonly refusal: OperatorRefusal) {
    super(
      refusal.reason === 'insufficient_capability'
        ? `this operator does not hold ${refusal.required}`
        : `an operator action needs a reason (${refusal.reason})`,
    )
    this.name = 'OperatorAccessRefused'
  }
}

/**
 * The context every ops action carries.
 *
 * `reason` is not optional and has no default. `SECURITY.md § 6` requires a
 * mandatory free-text reason on operator actions, and mandatory means the
 * action does not happen without one — which is only true if the type says so.
 */
export interface OperatorContext {
  readonly operator: ActiveOperator
  /** What is being done, in the audit vocabulary: `ops.exception_resolved`. */
  readonly action: string
  readonly reason: string
  readonly requestId?: string
  readonly ip?: string
  readonly userAgent?: string
}

export function requireCapability(
  ctx: OperatorContext, capability: InternalCapability,
): void {
  if (!ctx.operator.capabilities.has(capability)) {
    throw new OperatorAccessRefused({ reason: 'insufficient_capability', required: capability })
  }
  const bad = validateReason(ctx.reason)
  if (bad !== null) throw new OperatorAccessRefused({ reason: bad })
}

/* ── Recording ──────────────────────────────────────────────────────────── */

export interface RecordedSubject {
  readonly subjectType: string
  readonly subjectId: string
}

/**
 * Write the two records for one workspace, in one transaction.
 *
 * Runs on the **application** pool inside `withTenant`, not on the ops pool:
 * `inrsettle_ops` holds no write privilege anywhere, which is the property that
 * makes "no ops action can edit a settled record" a fact about grants rather
 * than a rule about code.
 */
export async function recordOperatorAccess(
  appDb: Db,
  scope: TenantScope,
  ctx: OperatorContext,
  kind: 'read' | 'write',
  subject?: RecordedSubject,
): Promise<string> {
  return withTenant(appDb, scope, (tx) => writeOperatorRecord(tx, scope, ctx, kind, subject))
}

/**
 * The same two rows, written inside a transaction the caller already owns.
 *
 * A *write* action records itself in the transaction that performed it, so a
 * resolution that rolls back takes its attribution with it — a write that did
 * not happen should leave no record that it did. A *read* uses the wrapper
 * above, which commits separately and first, because a read cannot be rolled
 * back and an unrecorded one is the failure this whole file exists to prevent.
 */
export async function writeOperatorRecord(
  tx: Db,
  scope: TenantScope,
  ctx: OperatorContext,
  kind: 'read' | 'write',
  subject?: RecordedSubject,
): Promise<string> {
  const write = async (): Promise<string> => {
    const id = newId('operatorAction')
    await tx.insert(schema.operatorActions).values({
      id,
      operatorId: ctx.operator.operatorId,
      sessionId: ctx.operator.sessionId,
      kind,
      action: ctx.action,
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      ...(subject ? { subjectType: subject.subjectType, subjectId: subject.subjectId } : {}),
      reason: ctx.reason,
      ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
      ...(ctx.ip === undefined ? {} : { ip: ctx.ip }),
      ...(ctx.userAgent === undefined ? {} : { userAgent: ctx.userAgent }),
    })

    // The customer's own copy. Same reason, same actor, in the log they read.
    await eventSink(tx).audit(scope, {
      actor: ctx.operator.principal,
      action: ctx.action,
      subjectType: subject?.subjectType ?? 'workspace',
      subjectId: subject?.subjectId ?? scope.workspaceId,
      after: { operator: ctx.operator.email, kind },
      reason: ctx.reason,
    })
    return id
  }
  return write()
}

/* ── The cross-tenant read ──────────────────────────────────────────────── */

export interface OperatorReadInput {
  /** Every workspace this read will touch. Audited before the read happens. */
  readonly scopes: readonly TenantScope[]
  readonly subject?: RecordedSubject
}

/**
 * Read across tenants, having first recorded that you are about to.
 *
 * The callback is handed the **ops pool**, unscoped. It can see every workspace
 * the permissive policies cover, which is the privilege this whole file exists
 * to bound: the callback runs only after `scopes` have been audited, and only
 * for an operator holding `ops:read` with a reason that passed validation.
 *
 * An empty `scopes` list is refused rather than treated as "nothing to audit".
 * A cross-tenant read that names no workspace is either a bug or the shape an
 * unaudited read would take, and neither should proceed.
 */
export async function withOperatorRead<T>(
  appDb: Db,
  opsDb: Db,
  ctx: OperatorContext,
  input: OperatorReadInput,
  read: (conn: Db) => Promise<T>,
): Promise<T> {
  requireCapability(ctx, 'ops:read')

  if (input.scopes.length === 0) {
    throw new OperatorAccessRefused({ reason: 'insufficient_capability', required: 'ops:read' })
  }

  // Committed before the read. See the header: over-recording beats an
  // unrecorded read.
  for (const scope of input.scopes) {
    await recordOperatorAccess(appDb, scope, ctx, 'read', input.subject)
  }

  return withoutScope(opsDb, read)
}

/* ── Discovery ──────────────────────────────────────────────────────────── */

/** A queue, and the workspaces that currently have anything in it. */
export type OpsQueue = 'exceptions' | 'reconciliation' | 'returns' | 'drawdowns'

export interface QueueScope extends TenantScope {
  readonly waiting: number
  readonly oldestAt: Date
}

/**
 * Which workspaces have work in a queue.
 *
 * Scope pairs and a count, deliberately: no settlement id, no amount, no
 * customer name. It is the same shape as `pending_outbox_scopes` and exists for
 * the same reason — a caller that cannot see past RLS needs *some* way to learn
 * that a workspace it was never told about needs attention, and the narrowest
 * possible answer to that question is the right one.
 *
 * Every workspace this returns is audited by the `withOperatorRead` that
 * follows, before any of its content is read. The gap between the two is a gap
 * in which the operator knows only a list of ids they are about to be recorded
 * against.
 */
export async function discoverQueueScopes(
  opsDb: Db, queue: OpsQueue, limit = 100,
): Promise<readonly QueueScope[]> {
  const query = ((): ReturnType<typeof sql> => {
    switch (queue) {
      case 'exceptions':
        return sql`SELECT workspace_id, environment, count(*)::int AS waiting,
                          min(opened_at) AS oldest_at
                     FROM settlement_exceptions
                    WHERE resolved_at IS NULL
                    GROUP BY workspace_id, environment
                    ORDER BY min(opened_at)
                    LIMIT ${limit}`
      case 'reconciliation':
        return sql`SELECT workspace_id, environment, count(*)::int AS waiting,
                          min(opened_at) AS oldest_at
                     FROM reconciliations
                    WHERE status = 'PENDING'
                    GROUP BY workspace_id, environment
                    ORDER BY min(opened_at)
                    LIMIT ${limit}`
      case 'returns':
        return sql`SELECT workspace_id, environment, count(*)::int AS waiting,
                          min(observed_at) AS oldest_at
                     FROM settlement_returns
                    WHERE status IN ('OBSERVED', 'MANUAL_REVIEW')
                    GROUP BY workspace_id, environment
                    ORDER BY min(observed_at)
                    LIMIT ${limit}`
      case 'drawdowns':
        return sql`SELECT workspace_id, environment, count(*)::int AS waiting,
                          min(requested_at) AS oldest_at
                     FROM drawdowns
                    WHERE status = 'REQUESTED'
                    GROUP BY workspace_id, environment
                    ORDER BY min(requested_at)
                    LIMIT ${limit}`
    }
  })()

  const rows = (await withoutScope(opsDb, (conn) => conn.execute(query))) as unknown as {
    workspace_id: string
    environment: 'sandbox' | 'live'
    waiting: number
    oldest_at: Date | string
  }[]

  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    environment: r.environment,
    waiting: r.waiting,
    // Coerced, because `min(timestamptz)` comes back as a string rather than a
    // Date: the driver parses columns by their declared type and an aggregate
    // has none. A caller that assumed Date got a `toISOString is not a
    // function` at the far end of the request, which is a long way from here.
    oldestAt: r.oldest_at instanceof Date ? r.oldest_at : new Date(r.oldest_at),
  }))
}

/**
 * What Internal Operations can see — `PRODUCT.md § 14`.
 *
 * > A separate surface, outside customer navigation, where complexity is
 * > allowed and expected: settlements, liquidity facilities, reservations,
 * > drawdowns, repayments, payout providers, reconciliation queues, exceptions,
 * > raw provider events, and the audit log.
 * >
 * > **The internal tool may expose complexity. The customer product must not.**
 *
 * So these reads are deliberately unlike the public serializers next door. The
 * customer sees five statuses; ops sees seventeen. The customer sees "We are
 * sending your payment"; ops sees the provider's raw code, the mapping table
 * version that interpreted it, and the transition it produced. That is the
 * point of a second surface — the alternative is leaking the state machine into
 * the customer product, which `API_CONTRACT.md § 10.2` forbids and Stage 8 spent
 * a correction fixing.
 *
 * Two things stay masked even here, because `SECURITY.md § 8` does not have an
 * ops exception: the payout account number and the PAN. Ops sees the same last
 * four the customer sees, and `inrsettle_ops` is not granted the ciphertext
 * columns at all (migration `0017`), so this is a fact about the connection
 * rather than a discipline this file maintains.
 *
 * Every function here takes the **ops pool** and is meant to be called inside
 * `withOperatorRead`, which has already recorded who is reading, which
 * workspaces, and why. None of them takes a scope: the whole reason they exist
 * is to see across workspaces, and a scope parameter would suggest otherwise.
 */
import { sql } from 'drizzle-orm'
import type { Db, Environment } from '@inrsettle/db'
import { withoutScope } from '@inrsettle/db'

/* ── Shared shapes ──────────────────────────────────────────────────────── */

export interface OpsScoped {
  readonly workspaceId: string
  readonly environment: Environment
}

/** Money as ops reads it: minor units as a string, never a number (`INV-04`). */
export interface OpsMoney {
  readonly currency: string
  readonly minorUnits: string
}

const money = (currency: string, minor: string | number | bigint): OpsMoney =>
  ({ currency, minorUnits: String(minor) })

async function rows<T>(opsDb: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await withoutScope(opsDb, (conn) => conn.execute(query))) as unknown as T[]
}

/* ── Settlements ────────────────────────────────────────────────────────── */

export interface OpsSettlement extends OpsScoped {
  readonly id: string
  /** The **internal** status — all seventeen of them. */
  readonly status: string
  readonly customerStatus: string | null
  readonly recipientAmount: OpsMoney
  readonly fundingCurrency: string
  readonly purposeCode: string
  readonly beneficiaryName: string
  readonly destinationSummary: string | null
  readonly exceptionEnteredFrom: string | null
  readonly openExceptionCode: string | null
  readonly pointOfNoReturnAt: Date | null
  readonly cancellationRequestedAt: Date | null
  readonly quoteId: string | null
  readonly payoutAttemptId: string | null
  readonly version: number
  readonly createdAt: Date
  readonly settledAt: Date | null
}

export async function opsSettlement(
  opsDb: Db, settlementId: string,
): Promise<OpsSettlement | null> {
  const found = await rows<{
    id: string; workspace_id: string; environment: Environment; status: string
    customer_status: string | null; recipient_amount_minor: string
    recipient_amount_currency: string; funding_currency: string; purpose_code: string
    beneficiary_name: string; account_number_last4: string | null; ifsc: string | null
    vpa: string | null; exception_entered_from: string | null; open_exception_code: string | null
    point_of_no_return_at: Date | null; cancellation_requested_at: Date | null
    quote_id: string | null; payout_attempt_id: string | null; version: number
    created_at: Date; settled_at: Date | null
  }>(opsDb, sql`
    SELECT s.id, s.workspace_id, s.environment, s.status, s.customer_status,
           s.recipient_amount_minor, s.recipient_amount_currency, s.funding_currency,
           s.purpose_code, s.exception_entered_from, s.open_exception_code,
           s.point_of_no_return_at, s.cancellation_requested_at, s.quote_id,
           s.payout_attempt_id, s.version, s.created_at, s.settled_at,
           b.display_name AS beneficiary_name,
           -- The masked form, and only the masked form. The ciphertext columns
           -- are not granted to this role at all.
           v.account_number_last4, v.ifsc, v.vpa
      FROM settlements s
      JOIN beneficiaries b ON b.id = s.beneficiary_id
      LEFT JOIN payout_destination_versions v ON v.id = s.destination_version_id
     WHERE s.id = ${settlementId}`)

  const row = found[0]
  if (!row) return null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    environment: row.environment,
    status: row.status,
    customerStatus: row.customer_status,
    recipientAmount: money(row.recipient_amount_currency, row.recipient_amount_minor),
    fundingCurrency: row.funding_currency,
    purposeCode: row.purpose_code,
    beneficiaryName: row.beneficiary_name,
    destinationSummary: row.vpa ?? (row.account_number_last4
      ? `${row.ifsc ?? ''} •••• ${row.account_number_last4}`.trim()
      : null),
    exceptionEnteredFrom: row.exception_entered_from,
    openExceptionCode: row.open_exception_code,
    pointOfNoReturnAt: row.point_of_no_return_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    quoteId: row.quote_id,
    payoutAttemptId: row.payout_attempt_id,
    version: row.version,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  }
}

/* ── The exception queue ────────────────────────────────────────────────── */

export interface OpsException extends OpsScoped {
  readonly id: string
  readonly settlementId: string
  readonly code: string
  readonly enteredFrom: string
  readonly openedAt: Date
  readonly recipientAmount: OpsMoney
  /** Present only when a provider input arrived that the mapping table did not cover. */
  readonly providerRawCode: string | null
  readonly providerRawMessage: string | null
  readonly providerEventId: string | null
  readonly classification: string | null
  /** True once the payout may have delivered value — a `FAILED` resolution is then refused. */
  readonly pastPointOfNoReturn: boolean
}

export async function opsExceptionQueue(
  opsDb: Db, scopes: readonly OpsScoped[], limit = 200,
): Promise<readonly OpsException[]> {
  if (scopes.length === 0) return []
  const found = await rows<{
    id: string; workspace_id: string; environment: Environment; settlement_id: string
    code: string; entered_from: string; opened_at: Date
    recipient_amount_minor: string; recipient_amount_currency: string
    provider_raw_code: string | null; provider_raw_message: string | null
    provider_event_id: string | null; classification: string | null
    point_of_no_return_at: Date | null
  }>(opsDb, sql`
    SELECT e.id, e.workspace_id, e.environment, e.settlement_id, e.code, e.entered_from,
           e.opened_at, e.provider_raw_code, e.provider_raw_message, e.provider_event_id,
           e.classification,
           s.recipient_amount_minor, s.recipient_amount_currency, s.point_of_no_return_at
      FROM settlement_exceptions e
      JOIN settlements s ON s.id = e.settlement_id
     WHERE e.resolved_at IS NULL
       AND (e.workspace_id, e.environment) IN ${scopeTuples(scopes)}
     ORDER BY e.opened_at
     LIMIT ${limit}`)

  return found.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    environment: r.environment,
    settlementId: r.settlement_id,
    code: r.code,
    enteredFrom: r.entered_from,
    openedAt: r.opened_at,
    recipientAmount: money(r.recipient_amount_currency, r.recipient_amount_minor),
    providerRawCode: r.provider_raw_code,
    providerRawMessage: r.provider_raw_message,
    providerEventId: r.provider_event_id,
    classification: r.classification,
    pastPointOfNoReturn: r.point_of_no_return_at !== null,
  }))
}

/**
 * `(workspace_id, environment) IN ((…), (…))`, built safely.
 *
 * Composed from parameterised fragments rather than interpolated text, so a
 * workspace id is a bound parameter and not a string somebody trusted.
 */
function scopeTuples(scopes: readonly OpsScoped[]): ReturnType<typeof sql> {
  const parts = scopes.map((s) =>
    sql`(${s.workspaceId}, ${s.environment}::environment)`)
  return sql`(${sql.join(parts, sql`, `)})`
}

/* ── Liquidity ──────────────────────────────────────────────────────────── */

export interface OpsFacility extends OpsScoped {
  readonly id: string
  readonly providerId: string
  readonly currency: string
  readonly limit: OpsMoney
  readonly available: OpsMoney
  readonly reserved: OpsMoney
  readonly drawn: OpsMoney
  readonly status: string
  readonly createdAt: Date
}

export async function opsFacilities(
  opsDb: Db, scopes: readonly OpsScoped[],
): Promise<readonly OpsFacility[]> {
  if (scopes.length === 0) return []
  const found = await rows<{
    id: string; workspace_id: string; environment: Environment; provider_id: string
    currency: string; limit_minor: string; available_minor: string
    reserved_minor: string; drawn_minor: string; status: string; created_at: Date
  }>(opsDb, sql`
    SELECT id, workspace_id, environment, provider_id, currency,
           limit_minor, reserved_minor, drawn_minor,
           -- Derived, never stored: availableToSettle is limit minus drawn
           -- minus reserved (INV-19), and a stored copy would be a second
           -- source of truth that can disagree with the ledger.
           (limit_minor - drawn_minor - reserved_minor) AS available_minor,
           status, created_at
      FROM liquidity_facilities
     WHERE (workspace_id, environment) IN ${scopeTuples(scopes)}
     ORDER BY created_at DESC`)

  return found.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    environment: r.environment,
    providerId: r.provider_id,
    currency: r.currency,
    limit: money(r.currency, r.limit_minor),
    available: money(r.currency, r.available_minor),
    reserved: money(r.currency, r.reserved_minor),
    drawn: money(r.currency, r.drawn_minor),
    status: r.status,
    createdAt: r.created_at,
  }))
}

export interface OpsMovement extends OpsScoped {
  readonly id: string
  readonly kind: 'reservation' | 'drawdown' | 'repayment'
  readonly facilityId: string
  readonly settlementId: string | null
  readonly amount: OpsMoney
  readonly status: string
  readonly at: Date
  /** A reservation's TTL, so an operator can see what is about to expire. */
  readonly expiresAt: Date | null
}

/**
 * Reservations, drawdowns and repayments as one list.
 *
 * They are three tables and one question — *what has this facility been doing*
 * — and an operator chasing a stuck settlement should not have to open three
 * screens and merge them by timestamp in their head.
 */
export async function opsFacilityMovements(
  opsDb: Db, scopes: readonly OpsScoped[], limit = 200,
): Promise<readonly OpsMovement[]> {
  if (scopes.length === 0) return []
  const tuples = scopeTuples(scopes)
  const found = await rows<{
    id: string; kind: OpsMovement['kind']; workspace_id: string; environment: Environment
    facility_id: string; settlement_id: string | null; amount_minor: string
    amount_currency: string; status: string; at: Date; expires_at: Date | null
  }>(opsDb, sql`
    SELECT id, 'reservation' AS kind, workspace_id, environment, facility_id, settlement_id,
           amount_minor, amount_currency,
           -- Cast to text: the three tables have three different status enums,
           -- and a UNION will not convert one to another. Ops reads them as
           -- labels, which is what they are on this screen.
           status::text AS status, created_at AS at, expires_at
      FROM liquidity_reservations WHERE (workspace_id, environment) IN ${tuples}
    UNION ALL
    SELECT id, 'drawdown', workspace_id, environment, facility_id, settlement_id,
           amount_minor, amount_currency, status::text, requested_at, NULL
      FROM drawdowns WHERE (workspace_id, environment) IN ${tuples}
    UNION ALL
    SELECT id, 'repayment', workspace_id, environment, facility_id, settlement_id,
           amount_minor, amount_currency, status::text, requested_at, NULL
      FROM repayments WHERE (workspace_id, environment) IN ${tuples}
    ORDER BY at DESC
    LIMIT ${limit}`)

  return found.map((r) => ({
    id: r.id,
    kind: r.kind,
    workspaceId: r.workspace_id,
    environment: r.environment,
    facilityId: r.facility_id,
    settlementId: r.settlement_id,
    amount: money(r.amount_currency, r.amount_minor),
    status: r.status,
    at: r.at,
    expiresAt: r.expires_at,
  }))
}

/* ── Reconciliation ─────────────────────────────────────────────────────── */

export interface OpsReconciliation extends OpsScoped {
  readonly id: string
  readonly settlementId: string
  readonly status: string
  readonly expected: OpsMoney
  readonly observed: OpsMoney | null
  readonly deltaMinor: string | null
  readonly source: string | null
  readonly openedAt: Date
  readonly evaluatedAt: Date | null
  readonly resolvedAt: Date | null
  readonly compensationRequired: boolean | null
}

export async function opsReconciliationQueue(
  opsDb: Db, scopes: readonly OpsScoped[], limit = 200,
): Promise<readonly OpsReconciliation[]> {
  if (scopes.length === 0) return []
  const found = await rows<{
    id: string; workspace_id: string; environment: Environment; settlement_id: string
    status: string; expected_minor: string; currency: string
    observed_minor: string | null; delta_minor: string | null; source: string | null
    opened_at: Date; evaluated_at: Date | null; resolved_at: Date | null
    compensation_required: boolean | null
  }>(opsDb, sql`
    SELECT id, workspace_id, environment, settlement_id, status,
           expected_minor, currency, observed_minor, delta_minor, source,
           opened_at, evaluated_at, resolved_at, compensation_required
      FROM reconciliations
     WHERE (workspace_id, environment) IN ${scopeTuples(scopes)}
     ORDER BY opened_at
     LIMIT ${limit}`)

  return found.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    environment: r.environment,
    settlementId: r.settlement_id,
    status: r.status,
    expected: money(r.currency, r.expected_minor),
    observed: r.observed_minor === null ? null : money(r.currency, r.observed_minor),
    // A delta is a signed difference, not an amount: it has no currency of its
    // own and is carried as the string it is stored as (`INV-04`).
    deltaMinor: r.delta_minor === null ? null : String(r.delta_minor),
    source: r.source,
    openedAt: r.opened_at,
    evaluatedAt: r.evaluated_at,
    resolvedAt: r.resolved_at,
    compensationRequired: r.compensation_required,
  }))
}

/* ── Providers and their raw events ─────────────────────────────────────── */

export interface OpsProviderEvent extends OpsScoped {
  readonly id: string
  readonly providerId: string
  readonly providerEventId: string
  readonly eventType: string
  readonly receivedAt: Date
  readonly signatureValid: boolean
  /** What we decided it meant, and when. Null until it has been interpreted. */
  readonly interpretation: string | null
  readonly interpretedAt: Date | null
  /**
   * The provider's own code, present exactly when the mapping table did not
   * cover it (`INV-43`). This is the field that turns "the provider is
   * misbehaving" into "our mapping is out of date", which are different
   * incidents with different fixes.
   */
  readonly unmappedCode: string | null
  /** The event exactly as it arrived, for the case where none of the above helps. */
  readonly payload: unknown
  readonly subjectType: string | null
  readonly subjectId: string | null
}

/**
 * Raw provider events — `PRODUCT.md § 14`'s *"raw provider events"*.
 *
 * Raw is the word that matters. What a provider actually sent, beside what we
 * decided it meant and which mapping-table version decided it, is the only view
 * that lets an operator answer "is this a provider problem or a mapping
 * problem" — and `INV-43` exists because the second kind was invisible.
 */
export async function opsProviderEvents(
  opsDb: Db, scopes: readonly OpsScoped[], limit = 200,
): Promise<readonly OpsProviderEvent[]> {
  if (scopes.length === 0) return []
  const found = await rows<{
    id: string; workspace_id: string; environment: Environment; provider_id: string
    provider_event_id: string; event_type: string; received_at: Date
    signature_valid: boolean; interpretation: string | null; interpreted_at: Date | null
    unmapped_code: string | null; payload: unknown
    subject_type: string | null; subject_id: string | null
  }>(opsDb, sql`
    SELECT id, workspace_id, environment, provider_id, provider_event_id, event_type,
           received_at, signature_valid, interpretation, interpreted_at, unmapped_code,
           payload, subject_type, subject_id
      FROM provider_events
     WHERE (workspace_id, environment) IN ${scopeTuples(scopes)}
     ORDER BY received_at DESC
     LIMIT ${limit}`)

  return found.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    environment: r.environment,
    providerId: r.provider_id,
    providerEventId: r.provider_event_id,
    eventType: r.event_type,
    receivedAt: r.received_at,
    signatureValid: r.signature_valid,
    interpretation: r.interpretation,
    interpretedAt: r.interpreted_at,
    unmappedCode: r.unmapped_code,
    payload: r.payload,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
  }))
}

/* ── The audit log ──────────────────────────────────────────────────────── */

export interface OpsAuditEntry extends OpsScoped {
  readonly id: string
  readonly actorType: string
  readonly actorId: string
  readonly action: string
  readonly subjectType: string
  readonly subjectId: string
  readonly reason: string | null
  readonly requestId: string | null
  readonly createdAt: Date
}

export async function opsAuditLog(
  opsDb: Db,
  scopes: readonly OpsScoped[],
  filter: { subjectId?: string; actorId?: string } = {},
  limit = 200,
): Promise<readonly OpsAuditEntry[]> {
  if (scopes.length === 0) return []
  const found = await rows<{
    id: string; workspace_id: string; environment: Environment; actor_type: string
    actor_id: string; action: string; subject_type: string; subject_id: string
    reason: string | null; request_id: string | null; created_at: Date
  }>(opsDb, sql`
    SELECT id, workspace_id, environment, actor_type, actor_id, action,
           subject_type, subject_id, reason, request_id, created_at
      FROM audit_log
     WHERE (workspace_id, environment) IN ${scopeTuples(scopes)}
       AND (${filter.subjectId ?? null}::text IS NULL OR subject_id = ${filter.subjectId ?? null})
       AND (${filter.actorId ?? null}::text IS NULL OR actor_id = ${filter.actorId ?? null})
     ORDER BY created_at DESC
     LIMIT ${limit}`)

  return found.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    environment: r.environment,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    reason: r.reason,
    requestId: r.request_id,
    createdAt: r.created_at,
  }))
}

/* ── What we have been doing ────────────────────────────────────────────── */

export interface OpsOperatorAction {
  readonly id: string
  readonly operatorId: string
  readonly kind: 'read' | 'write'
  readonly action: string
  readonly workspaceId: string
  readonly environment: Environment
  readonly subjectType: string | null
  readonly subjectId: string | null
  readonly reason: string
  readonly createdAt: Date
}

/**
 * One operator's history, across every workspace they touched.
 *
 * The reason `operator_actions` exists as well as `audit_log`: this question
 * spans tenants, and answering it from the per-workspace log would mean
 * scanning every workspace in the deployment.
 *
 * Not itself a cross-tenant read of *customer* data — it is a read of our own
 * record of what we did — so it does not go through `withOperatorRead`. It is
 * still restricted to `ops:read` by its caller, and it is exactly the query an
 * `ops_admin` runs when reviewing someone's access.
 */
export async function opsOperatorHistory(
  opsDb: Db, operatorId: string, limit = 200,
): Promise<readonly OpsOperatorAction[]> {
  const found = await rows<{
    id: string; operator_id: string; kind: 'read' | 'write'; action: string
    workspace_id: string; environment: Environment; subject_type: string | null
    subject_id: string | null; reason: string; created_at: Date
  }>(opsDb, sql`
    SELECT id, operator_id, kind, action, workspace_id, environment,
           subject_type, subject_id, reason, created_at
      FROM operator_actions
     WHERE operator_id = ${operatorId}
     ORDER BY created_at DESC
     LIMIT ${limit}`)

  return found.map((r) => ({
    id: r.id,
    operatorId: r.operator_id,
    kind: r.kind,
    action: r.action,
    workspaceId: r.workspace_id,
    environment: r.environment,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    reason: r.reason,
    createdAt: r.created_at,
  }))
}

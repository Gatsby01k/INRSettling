/**
 * `data.object` — `API_CONTRACT.md § 10.1`, `§ 10.2`.
 *
 * > `"data": { "object": { "…": "the full settlement object" } }`
 *
 * One resolver, used by webhook delivery and by `GET /v1/events` alike, because
 * the contract says they carry the same document and two implementations of
 * "the same document" diverge on their first edit.
 *
 * ## What this replaces, and why it mattered
 *
 * The envelope used to carry `events.payload` — the row the transition wrote for
 * its own audit purposes. That payload is internal by construction: a
 * `settlement.created` event carries `{"transition": "T01", "to": "DRAFT"}`. So
 * a customer endpoint subscribed to a customer-visible event type was receiving
 * the internal state machine anyway, through the field meant to hold the public
 * object. `§ 10.2` — *"The internal state machine is not the integration
 * surface"* — was true of the allow-list and false of the payload.
 *
 * It is now impossible by construction: this module resolves the event's
 * **subject** through the same public serializers `/v1` uses, and there is no
 * path by which a payload reaches an envelope.
 *
 * ## What happens when the subject is gone
 *
 * Nothing is invented. A resolver that cannot find its subject returns a
 * **reference object** — `{object, id, deleted: true}` — rather than a partial
 * one assembled from the payload. A customer replaying a year-old event about a
 * beneficiary that has since been removed gets a document that says exactly
 * that, and their code branches on a field rather than on a missing key.
 *
 * Sandbox data is freely resettable (`ARCHITECTURE.md § 8`), so this is a
 * routine case rather than a corruption case.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { money, type CurrencyCode } from '@inrsettle/money'
import {
  isCustomerEventType,
  type CustomerStatus, type ExceptionCode, type SettlementStatus, type TenantScope,
} from '@inrsettle/domain'
import { getBeneficiary } from '../beneficiary.service.js'
import { getQuote } from '../quote.service.js'
import { readBatch } from '../batch.service.js'
import { listReturns } from '../settlement-return.service.js'
import { summariseVersion } from '../preflight.service.js'
import {
  batchJson, beneficiaryJson, quoteJson, settlementReturnJson, timestamp,
  type NumberFormat,
} from './objects.js'
import { settlementJson, type SettlementSerializationInput } from './settlement-object.js'

export interface EventObjectContext {
  readonly numberFormat: NumberFormat
  /** Purpose labels, for the settlement object. Absent is fine; the code shows. */
  readonly purposeLabels?: ReadonlyMap<string, string>
}

/** What a resolver returns when its subject no longer exists. */
function reference(object: string, id: string): Record<string, unknown> {
  return { object, id, deleted: true }
}

/**
 * The public object for one event.
 *
 * Reads through `tx`, so it is already tenant-scoped: an event and its subject
 * are in the same workspace by construction, and RLS is what makes that true
 * rather than a `WHERE` clause somebody wrote.
 */
export async function resolveCustomerEventObject(
  tx: Db,
  scope: TenantScope,
  event: { readonly type: string; readonly subjectType: string; readonly subjectId: string },
  ctx: EventObjectContext,
): Promise<Record<string, unknown>> {
  // Belt and braces on the allow-list. Nothing should reach here with an
  // internal type — the drain filters and `/v1/events` filters — but a resolver
  // that would happily serialise one is a resolver waiting for a third caller.
  if (!isCustomerEventType(event.type) && !event.type.startsWith('endpoint.')) {
    return reference('unknown', event.subjectId)
  }

  switch (event.subjectType) {
    case 'settlement': return settlementObject(tx, scope, event.subjectId, ctx)
    case 'beneficiary': return beneficiaryObject(tx, scope, event.subjectId, ctx)
    case 'payout_destination': return destinationBeneficiaryObject(tx, scope, event.subjectId, ctx)
    case 'settlement_return': return returnObject(tx, event.subjectId, ctx)
    case 'batch': return batchObject(tx, event.subjectId, ctx)
    case 'quote': return quoteObject(tx, event.subjectId, ctx)
    case 'financial_artifact': return receiptObject(tx, event.subjectId)
    case 'webhook_endpoint': return endpointObject(tx, event.subjectId)
    default: return reference(event.subjectType, event.subjectId)
  }
}

/* ── Settlement ─────────────────────────────────────────────────────────── */

export async function settlementObject(
  tx: Db, scope: TenantScope, settlementId: string, ctx: EventObjectContext,
): Promise<Record<string, unknown>> {
  const [row] = await tx.select().from(schema.settlements)
    .where(eq(schema.settlements.id, settlementId)).limit(1)
  if (!row) return reference('settlement', settlementId)

  const beneficiary = await getBeneficiary(tx, scope, row.beneficiaryId)
  const returns = await listReturns(tx, row.id)
  const [replacement] = await tx.select({ id: schema.settlements.id })
    .from(schema.settlements)
    .where(eq(schema.settlements.replacesSettlementId, row.id)).limit(1)

  const destination = beneficiary?.destinations.find((d) => d.id === row.destinationId)
    ?? beneficiary?.destinations[0]
  const frozenSummary = row.destinationVersionId === null
    ? null
    : await summariseVersion(tx, row.destinationVersionId)

  const attempt = row.payoutAttemptId === null ? null : (
    await tx.select().from(schema.payoutAttempts)
      .where(eq(schema.payoutAttempts.id, row.payoutAttemptId)).limit(1)
  )[0] ?? null

  const [batchRow] = await tx.select({ batchId: schema.batchRows.batchId })
    .from(schema.batchRows)
    .where(eq(schema.batchRows.settlementId, row.id)).limit(1)

  const input: SettlementSerializationInput = {
    id: row.id,
    environment: row.environment,
    status: row.status as SettlementStatus,
    customerStatus: row.customerStatus as CustomerStatus | null,
    openExceptionCode: row.openExceptionCode as ExceptionCode | null,
    recipientAmount: money(row.recipientAmountCurrency as CurrencyCode, row.recipientAmountMinor),
    deliveredAmount: attempt?.creditedMinor == null
      ? null
      : money('INR' as CurrencyCode, attempt.creditedMinor),
    fundingCurrency: row.fundingCurrency,
    purposeCode: row.purposeCode,
    purposeLabel: row.purposeCode === null
      ? null
      : ctx.purposeLabels?.get(row.purposeCode) ?? null,
    externalReference: row.externalReference,
    quoteId: row.quoteId,
    batchId: batchRow?.batchId ?? null,
    receiptId: row.receiptId,
    payoutReference: attempt?.providerReference ?? null,
    authorizedTerms: row.authorizedTerms as Record<string, unknown> | null,
    authorizedTermsHash: row.authorizedTermsHash,
    pointOfNoReturnAt: row.pointOfNoReturnAt,
    cancellationRequestedAt: row.cancellationRequestedAt,
    authorizedAt: row.authorizedAt,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
    replacesSettlementId: row.replacesSettlementId,
    replacedBy: replacement?.id ?? null,
    resolution: null,
    beneficiary: {
      id: row.beneficiaryId,
      displayName: beneficiary?.displayName ?? '',
      destinationId: row.destinationId,
      destinationVersionId: row.destinationVersionId,
      destinationSummary: frozenSummary ?? destination?.currentVersion?.summary ?? null,
      verificationStatus: destination?.currentVersion?.verificationStatus ?? null,
    },
    // Requirements belong to a settlement waiting on somebody, and computing
    // them needs the versioned rule set, which the worker does not carry. The
    // event points at the settlement; `GET /v1/settlements/{id}` is where a
    // client reads what is being asked of them, and § 10.3 already tells them
    // to re-read for anything irreversible.
    requirements: [],
    returns: returns.map((r) => settlementReturnJson(r, ctx.numberFormat)),
    progressTimestamps: {
      ready: row.status === 'DRAFT' || row.status === 'PREFLIGHTING' ? null : row.createdAt,
      liquiditySecured: row.drawdownId === null ? null : row.updatedAt,
      payoutConfirmed: attempt?.creditedAt ?? null,
      reconciled: row.settledAt,
    },
  }
  return settlementJson(input, ctx.numberFormat)
}

/* ── Beneficiary ────────────────────────────────────────────────────────── */

async function beneficiaryObject(
  tx: Db, scope: TenantScope, beneficiaryId: string, ctx: EventObjectContext,
): Promise<Record<string, unknown>> {
  const view = await getBeneficiary(tx, scope, beneficiaryId)
  if (!view) return reference('beneficiary', beneficiaryId)
  // No settlement summary in an event object: it is a live aggregate over the
  // settlements table, and an event is a statement about a moment. A client
  // that wants it reads the beneficiary.
  return beneficiaryJson(view, null, scope.environment, ctx.numberFormat)
}

/**
 * The verification events name a *destination*; the public object is its
 * beneficiary.
 *
 * `API_CONTRACT.md § 7.1` has no standalone destination resource — a destination
 * is a compact summary nested inside a beneficiary — so an event about one
 * resolves to the object a customer can actually fetch.
 */
async function destinationBeneficiaryObject(
  tx: Db, scope: TenantScope, destinationId: string, ctx: EventObjectContext,
): Promise<Record<string, unknown>> {
  const [destination] = await tx.select({ beneficiaryId: schema.payoutDestinations.beneficiaryId })
    .from(schema.payoutDestinations)
    .where(eq(schema.payoutDestinations.id, destinationId)).limit(1)
  if (!destination) return reference('beneficiary', destinationId)
  return beneficiaryObject(tx, scope, destination.beneficiaryId, ctx)
}

/* ── Return, batch, quote, receipt ──────────────────────────────────────── */

async function returnObject(
  tx: Db, returnId: string, ctx: EventObjectContext,
): Promise<Record<string, unknown>> {
  const rows = await tx.select().from(schema.settlementReturns)
    .where(eq(schema.settlementReturns.id, returnId)).limit(1)
  const row = rows[0]
  if (!row) return reference('settlement_return', returnId)
  return settlementReturnJson({
    id: row.id,
    settlement_id: row.settlementId,
    status: row.status,
    amount_minor: row.amountMinor,
    amount_currency: row.amountCurrency,
    reason_code: row.reasonCode,
    reason_message: row.reasonMessage,
    observed_at: row.observedAt,
    confirmed_at: row.confirmedAt,
    repaid_at: row.repaidAt,
  }, ctx.numberFormat)
}

async function batchObject(
  tx: Db, batchId: string, ctx: EventObjectContext,
): Promise<Record<string, unknown>> {
  const batch = await readBatch(tx, batchId)
  return batch === null ? reference('batch', batchId) : batchJson(batch, ctx.numberFormat)
}

async function quoteObject(
  tx: Db, quoteId: string, ctx: EventObjectContext,
): Promise<Record<string, unknown>> {
  const quote = await getQuote(tx, quoteId)
  return quote === null ? reference('quote', quoteId) : quoteJson(quote, ctx.numberFormat)
}

/**
 * `receipt.available` names the artifact; the object is the receipt.
 *
 * No `pdf_url`: a presigned URL is short-lived by design, and one embedded in a
 * webhook that may be replayed a day later would be a broken link presented as a
 * link. The receipt id and the content hash are what a client needs; the URL is
 * a read away.
 */
async function receiptObject(tx: Db, artifactId: string): Promise<Record<string, unknown>> {
  const rows = await tx.select().from(schema.financialArtifacts)
    .where(eq(schema.financialArtifacts.id, artifactId)).limit(1)
  const row = rows[0]
  if (!row) return reference('settlement_receipt', artifactId)
  return {
    id: row.id,
    object: row.kind === 'settlement_receipt' ? 'settlement_receipt' : row.kind,
    settlement_id: row.settlementId,
    content_hash: row.contentHash,
    pdf_url: null,
    created_at: timestamp(row.createdAt),
  }
}

async function endpointObject(tx: Db, endpointId: string): Promise<Record<string, unknown>> {
  const [row] = await tx.select().from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, endpointId)).limit(1)
  if (!row) return reference('webhook_endpoint', endpointId)
  return {
    id: row.id,
    object: 'webhook_endpoint',
    url: row.url,
    status: row.status,
    consecutive_failures: row.consecutiveFailures,
    circuit_opened_at: timestamp(row.circuitOpenedAt),
  }
}

/** Exposed so a test can assert every subject type an event can carry is covered. */
export const RESOLVED_SUBJECT_TYPES = [
  'settlement', 'beneficiary', 'payout_destination', 'settlement_return',
  'batch', 'quote', 'financial_artifact', 'webhook_endpoint',
] as const

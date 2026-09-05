/**
 * Settlement endpoints — `API_CONTRACT.md § 7.3`, `§ 7.3.1`, `§ 8`.
 *
 * Every handler here is thin over `packages/app`, and that is the invariant this
 * file is defending. `INV-17`: *"No route handler, worker, UI component,
 * migration or ops helper may write settlement status directly."* Nothing below
 * touches `settlements.status`; each one gathers a request into a service call
 * and turns the service's answer into an envelope.
 *
 * There is no handler for setting a status, marking a settlement paid, or
 * adjusting an amount, because `§ 8` says there is deliberately no such
 * endpoint — and a test walks the route table to prove none appeared.
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, lt, sql, type SQL } from 'drizzle-orm'
import { schema } from '@inrsettle/db'
import { money, type CurrencyCode } from '@inrsettle/money'
import {
  ApiError, notFound,
  type CustomerStatus, type ExceptionCode, type SettlementStatus,
} from '@inrsettle/domain'
import {
  authorizeSettlement, cancelSettlement, createSettlement, enqueuePreflight, getBeneficiary,
  listArtifacts, listReturns, requestCancellation, runPreflightFor, summariseVersion,
} from '@inrsettle/app-services'
import type { Handler, HandlerContext } from '../pipeline.js'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, listEnvelope } from '../http.js'
import { settlementJson, type SettlementSerializationInput } from '@inrsettle/app-services'
import { settlementReturnJson, timestamp } from '@inrsettle/app-services'
import { objectField, requireBody, requireString, stringField } from './body.js'

/** The customer-facing filter values — never an internal state (`§ 6`). */
const CUSTOMER_STATUS_FILTER: Record<string, CustomerStatus> = {
  ready: 'READY', settling: 'SETTLING', settled: 'SETTLED',
  action_required: 'ACTION_REQUIRED', cancelled: 'CANCELLED',
}

type SettlementRow = typeof schema.settlements.$inferSelect

async function serialize(
  ctx: HandlerContext, row: SettlementRow,
): Promise<Record<string, unknown>> {
  const beneficiary = await getBeneficiary(ctx.tx, ctx.scope, row.beneficiaryId)
  const returns = await listReturns(ctx.tx, row.id)
  const [replacement] = await ctx.tx
    .select({ id: schema.settlements.id })
    .from(schema.settlements)
    .where(eq(schema.settlements.replacesSettlementId, row.id))
    .limit(1)

  // The frozen version if there is one, the current one otherwise. After
  // authorization these differ whenever the customer has edited the
  // destination, and the settlement must show what it pays (INV-45).
  const destination = beneficiary?.destinations.find((d) => d.id === row.destinationId)
    ?? beneficiary?.destinations[0]
  const frozenVersion = row.destinationVersionId === null
    ? null
    : await frozenVersionSummary(ctx, row.destinationVersionId)

  const attempt = row.payoutAttemptId === null ? null : (
    await ctx.tx.select().from(schema.payoutAttempts)
      .where(eq(schema.payoutAttempts.id, row.payoutAttemptId)).limit(1)
  )[0] ?? null

  const purposeLabel = row.purposeCode === null
    ? null
    : ctx.deps.ruleSet.purposeCodes.find((p) => p.code === row.purposeCode)?.label ?? null

  const input: SettlementSerializationInput = {
    id: row.id,
    environment: row.environment,
    status: row.status as SettlementStatus,
    customerStatus: row.customerStatus as CustomerStatus | null,
    openExceptionCode: row.openExceptionCode as ExceptionCode | null,
    recipientAmount: money(row.recipientAmountCurrency as CurrencyCode, row.recipientAmountMinor),
    deliveredAmount: attempt?.creditedMinor == null
      ? null
      : money(
          'INR' as CurrencyCode,
          attempt.creditedMinor,
        ),
    fundingCurrency: row.fundingCurrency,
    purposeCode: row.purposeCode,
    purposeLabel,
    externalReference: row.externalReference,
    quoteId: row.quoteId,
    batchId: await batchIdOf(ctx, row.id),
    receiptId: row.receiptId,
    payoutReference: attempt?.providerReference ?? null,
    authorizedTerms: (row.authorizedTerms as Record<string, unknown> | null),
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
      destinationSummary: frozenVersion ?? destination?.currentVersion?.summary ?? null,
      verificationStatus: destination?.currentVersion?.verificationStatus ?? null,
    },
    requirements: await requirementsFor(ctx, row),
    returns: returns.map((r) => settlementReturnJson(r, ctx.numberFormat)),
    progressTimestamps: {
      ready: row.status === 'DRAFT' ? null : row.createdAt,
      liquiditySecured: row.drawdownId === null ? null : row.updatedAt,
      payoutConfirmed: attempt?.creditedAt ?? null,
      reconciled: row.settledAt,
    },
  }
  return settlementJson(input, ctx.numberFormat)
}

/**
 * The frozen version's masked summary — "HDFC •••• 4417".
 *
 * Built by the same function the rest of the product uses, from the last four
 * digits held in clear. There is no path here to the account number itself, and
 * this process could not decrypt one if there were (`SECURITY.md § 8`).
 */
/**
 * `§ 7.4` — every requirement, with a machine code, a human title, context and
 * one named action.
 *
 * Re-derived on read rather than stored, because a requirement is a *function*
 * of the settlement and the versioned rule set: storing the four-field object
 * would mean a rule-set revision left old settlements showing copy that no
 * longer matches the rule that produced it. The transition event records which
 * rule set and which codes decided, which is what an audit needs; this is what
 * a customer needs, and the two answer different questions.
 *
 * Computed only for a settlement that is waiting on somebody. `§ 7.3`'s own
 * example carries `"requirements": []` on a settlement already under way — once
 * the instruction is frozen, a requirement is history rather than a to-do.
 */
async function requirementsFor(
  ctx: HandlerContext, row: SettlementRow,
): Promise<readonly Record<string, unknown>[]> {
  if (row.customerStatus !== 'ACTION_REQUIRED') return []

  const preflight = await runPreflightFor(ctx.tx, ctx.scope, ctx.deps.ruleSet, {
    beneficiaryId: row.beneficiaryId,
    ...(row.destinationId === null ? {} : { destinationId: row.destinationId }),
    amount: { currency: 'INR', minorUnits: row.recipientAmountMinor },
    purposeCode: row.purposeCode,
    hasActiveLiquidityFacility: ctx.deps.hasActiveLiquidityFacility,
  })
  if (!preflight.ok) return []

  return preflight.outcome.requirements
    .filter((r) => r.severity === 'blocking')
    .map((r) => ({
      code: r.code,
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      action: r.action,
    }))
}

async function frozenVersionSummary(
  ctx: HandlerContext, versionId: string,
): Promise<string | null> {
  return summariseVersion(ctx.tx, versionId)
}

async function batchIdOf(ctx: HandlerContext, settlementId: string): Promise<string | null> {
  const [row] = await ctx.tx
    .select({ batchId: schema.batchRows.batchId })
    .from(schema.batchRows)
    .where(eq(schema.batchRows.settlementId, settlementId))
    .limit(1)
  return row?.batchId ?? null
}

async function load(ctx: HandlerContext, id: string): Promise<SettlementRow> {
  const [row] = await ctx.tx.select().from(schema.settlements)
    .where(eq(schema.settlements.id, id)).limit(1)
  // RLS has already filtered by workspace *and* environment, so a live object
  // addressed by a sandbox key simply is not here. That is why this is a 404
  // and not a 403 — the difference § 3.3 insists on falls out of the query.
  if (!row) throw notFound('settlement')
  return row
}

/* ── POST /v1/settlements ───────────────────────────────────────────────── */

export const createSettlementHandler: Handler = async (ctx) => {
  const body = requireBody(ctx)
  const beneficiaryId = requireString(body, 'beneficiary_id')
  const amount = objectField(body, 'recipient_amount')
  const minorUnits = requireString(amount, 'minor_units')
  if (!/^\d+$/.test(minorUnits)) {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: 'recipient_amount.minor_units must be a whole number of paise, as a string.',
      detail: '₹5,000,000.00 is "500000000". It is a string so values above 2^53 survive JavaScript clients.',
      param: 'recipient_amount.minor_units',
    })
  }
  const currency = stringField(amount, 'currency') ?? 'INR'
  if (currency !== 'INR') {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: 'A settlement always delivers INR.',
      detail: 'recipient_amount.currency must be "INR"; the funding side is funding_currency.',
      param: 'recipient_amount.currency',
    })
  }

  const created = await createSettlement(ctx.tx, ctx.scope, {
    beneficiaryId,
    recipientAmountMinor: BigInt(minorUnits),
    fundingCurrency: stringField(body, 'funding_currency') ?? 'USDT',
    purposeCode: stringField(body, 'purpose_code'),
    externalReference: stringField(body, 'external_reference'),
    actor: ctx.key.principal,
  })

  // § 8 says this endpoint "runs preflight", and it does — by enqueueing it,
  // not by doing it here.
  //
  // `ARCHITECTURE.md § 3`: "A request never drives a settlement through more
  // than one transition; it records intent and enqueues." Preflight is `T02`
  // followed by `T03` or `T04`, so doing it inline would put three transitions
  // in this transaction — and the `INV-32` pairing trigger counts status events
  // at commit and refuses exactly that. The architecture and the database agree,
  // and the database would have found out first.
  //
  // The quote named at creation rides on the same job: `T06` is a fourth
  // transition, and it is only legal once preflight has left the settlement
  // READY.
  await enqueuePreflight(ctx.tx, ctx.scope, {
    settlementId: created.id,
    quoteId: stringField(body, 'quote_id'),
  })

  // `202 Accepted`, not `201 Created`, and the difference is the point.
  //
  // The settlement exists; what has not happened is preflight, which decides
  // between `ready` and `action_required`. `API_CONTRACT.md § 7.3` (Revision 7)
  // says `status` is `null` in exactly that window — the absence of a status
  // rather than a sixth one, and no internal state in its place. `202` is what
  // tells a client the object is not finished being decided, and it is the
  // honest code for a request that recorded intent.
  return {
    status: 202,
    body: await serialize(ctx, await load(ctx, created.id)),
    subjectId: created.id,
  }
}

/* ── GET /v1/settlements ────────────────────────────────────────────────── */

export const listSettlementsHandler: Handler = async (ctx) => {
  const limit = parseLimit(ctx.query['limit'])
  const filters: SQL[] = []

  const status = ctx.query['status']
  if (status !== undefined) {
    const mapped = CUSTOMER_STATUS_FILTER[status]
    if (mapped === undefined) {
      throw new ApiError({
        type: 'invalid_request_error', code: 'invalid_parameter',
        message: `"${status}" is not a settlement status.`,
        detail: `Filter on one of: ${Object.keys(CUSTOMER_STATUS_FILTER).join(', ')}.`,
        param: 'status',
      })
    }
    filters.push(eq(schema.settlements.customerStatus, mapped))
  }

  const beneficiaryId = ctx.query['beneficiary_id']
  if (beneficiaryId !== undefined) {
    filters.push(eq(schema.settlements.beneficiaryId, beneficiaryId))
  }
  const externalReference = ctx.query['external_reference']
  if (externalReference !== undefined) {
    filters.push(eq(schema.settlements.externalReference, externalReference))
  }
  const batchId = ctx.query['batch_id']
  if (batchId !== undefined) {
    const rows = await ctx.tx.select({ settlementId: schema.batchRows.settlementId })
      .from(schema.batchRows).where(eq(schema.batchRows.batchId, batchId))
    const ids = rows.map((r) => r.settlementId).filter((v): v is string => v !== null)
    filters.push(ids.length === 0 ? sql`false` : inArray(schema.settlements.id, ids))
  }
  const gteAt = ctx.query['created_at[gte]']
  if (gteAt !== undefined) filters.push(gte(schema.settlements.createdAt, parseDate(gteAt, 'created_at[gte]')))
  const lteAt = ctx.query['created_at[lte]']
  if (lteAt !== undefined) filters.push(lte(schema.settlements.createdAt, parseDate(lteAt, 'created_at[lte]')))

  // § 7.5: two supported ways to handle a return correctly, and this is one.
  const hasOpenReturn = ctx.query['has_open_return']
  const hasConfirmedReturn = ctx.query['has_confirmed_return']
  if (hasOpenReturn === 'true' || hasConfirmedReturn === 'true') {
    const statuses = hasConfirmedReturn === 'true'
      ? ['CONFIRMED', 'REPAID']
      : ['OBSERVED', 'MANUAL_REVIEW']
    const rows = await ctx.tx.select({ settlementId: schema.settlementReturns.settlementId })
      .from(schema.settlementReturns)
      .where(inArray(schema.settlementReturns.status, statuses as never))
    const ids = [...new Set(rows.map((r) => r.settlementId))]
    filters.push(ids.length === 0 ? sql`false` : inArray(schema.settlements.id, ids))
  }

  // The cursor is the last id of the previous page, resolved to its creation
  // time. Offsets do not exist (§ 6): a page built on an offset shifts under a
  // client whenever a settlement is created while they are reading.
  const after = ctx.query['starting_after']
  if (after !== undefined) {
    const [anchor] = await ctx.tx.select({ createdAt: schema.settlements.createdAt })
      .from(schema.settlements).where(eq(schema.settlements.id, after)).limit(1)
    if (!anchor) throw notFound('settlement named by starting_after')
    filters.push(lt(schema.settlements.createdAt, anchor.createdAt))
  }

  // A settlement being preflighted has no customer status and is not listed:
  // `INV-18` allows one projection of the machine, and that projection says a
  // settlement without a customer status has not entered the customer-visible
  // lifecycle. It is readable by id, so a client that has just created one can
  // poll it (`§ 7.3`).
  filters.push(isNotNull(schema.settlements.customerStatus))

  const rows = await ctx.tx.select().from(schema.settlements)
    .where(and(...filters))
    .orderBy(desc(schema.settlements.createdAt))
    .limit(limit + 1)

  const serialized = await Promise.all(rows.map((r) => serialize(ctx, r)))
  return {
    status: 200,
    body: listEnvelope(serialized, limit, (row) => String(row['id'])),
  }
}

/* ── GET /v1/settlements/{id} ───────────────────────────────────────────── */

export const getSettlementHandler: Handler = async (ctx) => ({
  status: 200,
  body: await serialize(ctx, await load(ctx, ctx.params['id']!)),
})

/* ── POST /v1/settlements/{id}/authorize ────────────────────────────────── */

export const authorizeSettlementHandler: Handler = async (ctx) => {
  const id = ctx.params['id']!
  await load(ctx, id)

  const result = await authorizeSettlement(ctx.tx, ctx.scope, {
    settlementId: id,
    actor: ctx.key.principal,
    // An API key is not a person. `evaluateSeparationOfDuties` refuses any
    // non-`user` authorizer when the policy is on, which is the whole point in
    // Live: a single key holding create and authorize cannot move money on its
    // own say-so. The roles here are the key's scopes, not a person's.
    actorRoles: ['approver'],
    ruleSet: ctx.deps.ruleSet,
    hasActiveLiquidityFacility: ctx.deps.hasActiveLiquidityFacility,
  })

  if (!result.ok) throw transitionRefusal(result.reason, result.detail)

  return { status: 200, body: await serialize(ctx, await load(ctx, id)), subjectId: id }
}

/* ── POST /v1/settlements/{id}/cancel ───────────────────────────────────── */

export const cancelSettlementHandler: Handler = async (ctx) => {
  const id = ctx.params['id']!
  const row = await load(ctx, id)
  const reason = ctx.body === null ? undefined : stringField(ctx.body as never, 'reason')

  // Before authorization it cancels immediately; after it, it registers a
  // request that is honoured at the next safe checkpoint (§ 7.3.1). The
  // difference is not the handler's to decide — it is the settlement's status.
  const preAuthorization = row.authorizedAt === null

  // The key already had to hold `settlement:cancel` to reach this handler — the
  // route table declares it and the pipeline enforced it before the claim — so
  // `cancelSettlement` is told the roles that carry that capability, and
  // `requestCancellation` is told the answer directly. Neither is being given a
  // permission it did not earn; both are being told the one already checked.
  const result = preAuthorization
    ? await cancelSettlement(ctx.tx, ctx.scope, {
        settlementId: id, actor: ctx.key.principal, actorRoles: ['operator'],
        ...(reason === undefined ? {} : { reason }),
      })
    : await requestCancellation(ctx.tx, ctx.scope, {
        settlementId: id, actor: ctx.key.principal, mayCancel: true,
        ...(reason === undefined ? {} : { reason }),
      })

  if (!result.ok) {
    if (result.reason === 'past_point_of_no_return') {
      throw new ApiError({
        type: 'conflict_error',
        code: 'past_point_of_no_return',
        message: 'This settlement can no longer be cancelled.',
        detail:
          `Payout submission was attempted at ${timestamp(row.pointOfNoReturnAt)}. ` +
          'After that moment a cancellation cannot be honoured, because the instruction is with the rail.',
      })
    }
    throw transitionRefusal(result.reason, 'detail' in result ? result.detail : undefined)
  }

  return {
    status: preAuthorization ? 200 : 202,
    body: await serialize(ctx, await load(ctx, id)),
    subjectId: id,
  }
}

/* ── GET /v1/settlements/{id}/receipt ───────────────────────────────────── */

export const receiptHandler: Handler = async (ctx) => {
  const id = ctx.params['id']!
  await load(ctx, id)
  const artifacts = await listArtifacts(ctx.tx, id)
  const receipt = artifacts.find((a) => a.kind === 'settlement_receipt')
  // § 8: "404 until settled". A receipt that does not exist yet is not an
  // empty receipt; the settlement has not reached the state that produces one.
  if (!receipt) throw notFound('receipt for this settlement — a receipt exists once the settlement is settled')

  const notices = artifacts.filter((a) => a.kind === 'return_notice')
  return {
    status: 200,
    body: {
      id: receipt.id,
      object: 'settlement_receipt',
      settlement_id: id,
      content_hash: receipt.content_hash,
      document: JSON.parse(receipt.canonical_bytes),
      pdf_url: null,
      return_notices: notices.map((n) => ({
        id: n.id,
        return_id: n.return_id,
        content_hash: n.content_hash,
        pdf_url: null,
        created_at: timestamp(n.created_at),
      })),
      created_at: timestamp(receipt.created_at),
    },
  }
}

/* ── GET /v1/settlements/{id}/returns ───────────────────────────────────── */

export const settlementReturnsHandler: Handler = async (ctx) => {
  const id = ctx.params['id']!
  await load(ctx, id)
  const returns = await listReturns(ctx.tx, id)
  return {
    status: 200,
    body: {
      object: 'list',
      data: returns.map((r) => settlementReturnJson(r, ctx.numberFormat)),
      has_more: false,
      next_cursor: null,
    },
  }
}

/* ── Shared refusals ────────────────────────────────────────────────────── */

/**
 * A state-machine refusal.
 *
 * `§ 5`: *"A state-machine rejection surfaces as `409` with `code:
 * "invalid_transition"` and a `detail` naming the current and attempted
 * states."* The domain's own reason is carried through rather than flattened,
 * because "invalid_transition" alone tells an integrator nothing they can act on.
 */
export function transitionRefusal(reason: string, detail?: unknown): ApiError {
  const named = typeof detail === 'object' && detail !== null
    ? JSON.stringify(detail)
    : undefined
  return new ApiError({
    type: 'conflict_error',
    code: 'invalid_transition',
    message: 'This settlement cannot do that in its current state.',
    detail: named === undefined ? `The settlement refused: ${reason}.` : `${reason} — ${named}`,
  })
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return LIST_DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > LIST_MAX_LIMIT) {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: `limit must be a whole number between 1 and ${LIST_MAX_LIMIT}.`,
      detail: `It defaults to ${LIST_DEFAULT_LIMIT} if you omit it.`,
      param: 'limit',
    })
  }
  return n
}

function parseDate(raw: string, param: string): Date {
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: `${param} is not a timestamp.`,
      detail: 'Send an RFC 3339 timestamp in UTC, e.g. 2026-08-31T09:14:02Z.',
      param,
    })
  }
  return d
}

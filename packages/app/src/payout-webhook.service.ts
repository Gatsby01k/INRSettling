/**
 * Inbound provider webhooks — `SECURITY.md § 4.2`, `INV-33`, `INV-43`.
 *
 * > *"This is the finality attack surface, and it is treated as hostile."*
 *
 * The seven steps the frozen document lists, in its order, because the order is
 * the security property:
 *
 *   1. read the **raw** body before any parsing;
 *   2. verify the signature, constant-time;
 *   3. reject any timestamp outside tolerance in **either** direction;
 *   4. persist the raw event, headers and verification result — *then*
 *      interpret it;
 *   5. deduplicate on the provider's event id; a replay is a recorded no-op;
 *   6. apply the transition through the domain, which re-asserts its own
 *      guards — *the webhook proposes; the state machine decides*;
 *   7. an input the mapping table does not cover is still ingested, persisted,
 *      acknowledged and alarmed.
 *
 * Steps 2 and 4 are in that order for a reason worth stating: a failed
 * signature does **not** stop the event being stored. An attacker's forged
 * event and a provider's misconfigured one look identical at the edge, and the
 * only way to tell them apart later is to have kept both. What a failed
 * signature stops is step 6 — untrusted evidence never moves the machine.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  interpretProviderCode,
  returnReasonOf,
  type ExceptionCode,
  type PayoutProvider,
  type PrincipalRef,
  type ProviderMappingTable,
  type ProviderOutcome,
  type ReturnReasonCode,
  type TenantScope,
} from '@inrsettle/domain'
import { applyPayoutOutcome } from './payout.service.js'
import { eventSink } from './events.js'

export type WebhookResult =
  | {
      ok: true
      providerEventId: string
      /** True when this exact provider event had already been handled. */
      duplicate: boolean
      applied: boolean
      outcome?: ProviderOutcome
      /** Set when the provider's vocabulary was not in the mapping table. */
      alarm?: 'unmapped_provider_code' | 'untrusted_event'
    }
  | { ok: false; reason: string; detail?: unknown }

/**
 * Which outcome the *transport* implies, before any code is interpreted.
 *
 * `INV-43` requires an unmapped input to route to *"the phase-appropriate safe
 * default, chosen from the one thing every provider does communicate — whether
 * the instruction was rejected or its status is simply unknown."* The event
 * type is that one thing: a webhook delivered on a rejection topic is a
 * rejection even when its code is novel.
 *
 * A type we do not recognise falls to `unknown`, which is the safest reading —
 * it leads to a status pull rather than to a decision.
 */
const EVENT_TYPE_OUTCOMES: Readonly<Record<string, ProviderOutcome>> = {
  'payout.accepted': 'accepted',
  'payout.credited': 'credited',
  'payout.rejected': 'rejected',
  'payout.failed': 'rejected',
  'payout.returned': 'returned',
}

function outcomeForEventType(eventType: string): ProviderOutcome {
  return EVENT_TYPE_OUTCOMES[eventType] ?? 'unknown'
}

export interface IngestInput {
  readonly raw: string
  readonly headers: Readonly<Record<string, string>>
  readonly actor: PrincipalRef
  /**
   * How the settlement is found from the payload. Injected because the payload
   * shape is the provider's, not ours, and a real adapter will read a different
   * field from this simulator.
   */
  readonly resolveSettlementId: (payload: Record<string, unknown>) => string | null
  /**
   * Stage 6's half of a return event — `N01`.
   *
   * Optional, and injected rather than imported, because the two layers own
   * different facts and Stage 5's contract must keep working without it. The
   * payout attempt reaching `RETURNED` is a rails-level fact about an execution
   * (`P08`); opening a `SettlementReturn` is a new aggregate against a settled
   * settlement. A webhook handler that always did both would make the payout
   * layer depend on reconciliation, and the attempt-level tests would then be
   * testing Stage 6.
   *
   * Called only after `applyPayoutOutcome` has accepted the return, so a sink
   * that opens a return can rely on the attempt already carrying `RETURNED`.
   */
  readonly onReturn?: (input: ReturnSinkInput) => Promise<void>
}

/** What the edge knows about a return, before the return aggregate exists. */
export interface ReturnSinkInput {
  readonly settlementId: string
  readonly providerEventId: string
  readonly rawCode: string
  readonly reasonCode: ReturnReasonCode
  readonly mapped: boolean
  readonly payload: Record<string, unknown>
  /** From the payload, where the provider stated one. */
  readonly amountMinor: bigint | undefined
  /** The provider's own id for this return — `INV-50`'s second key. */
  readonly providerReturnReference: string | undefined
  /** When the rail says it happened, not when we heard about it. */
  readonly occurredAt: Date | undefined
}

/**
 * Ingest one inbound webhook.
 *
 * Never throws on provider data. Every path returns a value the caller can
 * acknowledge with, because `INV-43` requires that an unrecognised input
 * *"never poisons the queue"* — and a handler that can throw is a handler that
 * can block everything behind it on the day a provider ships a new field.
 */
export async function ingestPayoutWebhook(
  tx: Db,
  scope: TenantScope,
  provider: PayoutProvider,
  mapping: ProviderMappingTable,
  input: IngestInput,
): Promise<WebhookResult> {
  // (2, 3) Verify. The provider's own verifier owns the timestamp tolerance and
  // the constant-time comparison, because both are provider-specific.
  const verdict = provider.verifySignature(input.raw, input.headers)

  // A malformed body has no provider event id to key on, so there is nothing to
  // deduplicate and nothing to store idempotently. It is refused at the edge —
  // the one case that does not reach the store, because it cannot be filed.
  if (!verdict.valid && verdict.reason === 'malformed') {
    await eventSink(tx).audit(scope, {
      actor: input.actor,
      action: 'payout.webhook_malformed',
      subjectType: 'provider_event',
      subjectId: 'unparseable',
      reason: 'body could not be parsed or carried no provider event id',
    })
    return { ok: false, reason: 'malformed' }
  }

  const providerEventId = verdict.valid
    ? verdict.providerEventId
    : readProviderEventId(input.raw) ?? `unverified_${newId('providerEvent')}`
  const eventType = verdict.valid ? verdict.eventType : readEventType(input.raw) ?? 'unknown'
  const payload = verdict.valid ? verdict.payload : safeParse(input.raw)

  // (5) Deduplicate. The unique index on (provider_id, provider_event_id) is
  // the real guarantee; this read turns a constraint violation into an answer.
  const existing = (await tx.execute(sql`
    SELECT id, interpreted_at FROM provider_events
    WHERE provider_id = ${provider.id} AND provider_event_id = ${providerEventId}`)) as unknown as
    { id: string; interpreted_at: Date | null }[]
  if (existing.length > 0) {
    // A replay is a recorded no-op, exactly as the frozen document says.
    return { ok: true, providerEventId, duplicate: true, applied: false }
  }

  const settlementId = input.resolveSettlementId(payload)

  // (4) Persist raw, before interpretation and whatever the verdict.
  const eventRowId = newId('providerEvent')
  await tx.insert(schema.providerEvents).values({
    id: eventRowId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    providerId: provider.id,
    providerEventId,
    eventType,
    payload: payload as never,
    signatureValid: verdict.valid,
    subjectType: settlementId ? 'settlement' : null,
    subjectId: settlementId,
  })

  // Untrusted evidence is stored and alarmed, and stops here. `SECURITY.md
  // § 4.2` is explicit that it must not be dropped: a forged event and a
  // provider's misconfiguration are indistinguishable at the edge, and only a
  // stored copy can tell them apart afterwards.
  if (!verdict.valid) {
    await tx
      .update(schema.providerEvents)
      .set({ interpretedAt: new Date(), interpretation: `untrusted:${verdict.reason}` })
      .where(sql`id = ${eventRowId}`)
    await eventSink(tx).audit(scope, {
      actor: input.actor,
      action: 'payout.webhook_untrusted',
      subjectType: 'provider_event',
      subjectId: eventRowId,
      after: { provider_event_id: providerEventId, reason: verdict.reason },
      reason: `signature verification failed: ${verdict.reason}`,
    })
    return {
      ok: true,
      providerEventId,
      duplicate: false,
      applied: false,
      alarm: 'untrusted_event',
    }
  }

  if (!settlementId) {
    await tx
      .update(schema.providerEvents)
      .set({ interpretedAt: new Date(), interpretation: 'no_subject' })
      .where(sql`id = ${eventRowId}`)
    return { ok: true, providerEventId, duplicate: false, applied: false }
  }

  // (7) Interpret. Cannot throw, by construction.
  const transportOutcome = outcomeForEventType(eventType)
  const rawCode = String(payload['code'] ?? payload['status'] ?? eventType)
  const interpretation = interpretProviderCode(mapping, rawCode, transportOutcome)

  if (!interpretation.mapped) {
    // The alarm, made queryable rather than only logged.
    await tx
      .update(schema.providerEvents)
      .set({
        unmappedCode: interpretation.rawCode,
        interpretation: `unmapped:${interpretation.outcome}`,
      })
      .where(sql`id = ${eventRowId}`)
    await eventSink(tx).audit(scope, {
      actor: input.actor,
      action: 'payout.unmapped_provider_code',
      subjectType: 'settlement',
      subjectId: settlementId,
      after: {
        raw_code: interpretation.rawCode,
        mapping_version: interpretation.mappingVersion,
        routed_to: interpretation.exceptionCode,
      },
      reason:
        'provider vocabulary not present in the mapping table; routed to the safe default and alarmed (INV-43)',
    })
  }

  const outcome = interpretation.outcome
  const exceptionCode: ExceptionCode | undefined =
    'exceptionCode' in interpretation ? interpretation.exceptionCode : undefined

  // An `unknown` outcome is ingested, persisted and alarmed — and applied to
  // nothing. A provider's silence, or its novel vocabulary on a topic we cannot
  // classify, must not move the machine; the SLA sweeper and the status pull
  // are what resolve it.
  if (outcome === 'unknown') {
    await tx
      .update(schema.providerEvents)
      .set({ interpretedAt: new Date(), interpretation: 'unknown_outcome_not_applied' })
      .where(sql`id = ${eventRowId}`)
    return {
      ok: true,
      providerEventId,
      duplicate: false,
      applied: false,
      outcome,
      ...(interpretation.mapped ? {} : { alarm: 'unmapped_provider_code' as const }),
    }
  }

  // (6) The webhook proposes; the state machine decides.
  const applied = await applyPayoutOutcome(tx, scope, {
    settlementId,
    outcome,
    actor: input.actor,
    trusted: true,
    utr: typeof payload['utr'] === 'string' ? payload['utr'] : undefined,
    creditedMinor: readMinorUnits(payload['credited_minor']),
    rawCode,
    exceptionCode,
    providerReference: typeof payload['reference'] === 'string' ? payload['reference'] : undefined,
    mappingVersion: interpretation.mappingVersion,
  })

  await tx
    .update(schema.providerEvents)
    .set({
      interpretedAt: new Date(),
      interpretation: applied.ok
        ? `applied:${outcome}${applied.idempotent === true ? ':idempotent' : ''}`
        : `refused:${applied.reason}`,
    })
    .where(sql`id = ${eventRowId}`)

  // Stage 6's half, and only once the attempt-level fact is recorded. A sink
  // that ran on a refused outcome would open a return against a payout the
  // machine had declined to mark returned.
  if (outcome === 'returned' && applied.ok && input.onReturn) {
    await input.onReturn({
      settlementId,
      providerEventId,
      rawCode,
      reasonCode: returnReasonOf(interpretation),
      mapped: interpretation.mapped,
      payload,
      amountMinor: readMinorUnits(payload['amount_minor']),
      providerReturnReference:
        typeof payload['return_id'] === 'string' ? payload['return_id'] : undefined,
      occurredAt:
        typeof payload['occurred_at'] === 'string' && !Number.isNaN(Date.parse(payload['occurred_at']))
          ? new Date(payload['occurred_at'])
          : undefined,
    })
  }

  return {
    ok: true,
    providerEventId,
    duplicate: false,
    applied: applied.ok && applied.idempotent !== true,
    outcome,
    ...(interpretation.mapped ? {} : { alarm: 'unmapped_provider_code' as const }),
  }
}

/* ── Reading an unverified body ─────────────────────────────────────────── */
//
// An event whose signature failed still has to be *filed*, and filing needs an
// id. These read the body without trusting it: whatever comes out is used only
// as a storage key and never as evidence.

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Read a minor-unit amount out of a provider payload, or nothing at all.
 *
 * A string is preferred and a JSON number is accepted only while it is exactly
 * representable, because `JSON.parse` silently rounds past 2^53 and a rounded
 * credit amount is a wrong one that looks right. Anything else — a float, a
 * negative, a word — yields `undefined`, which the column stores as "the
 * provider stated no figure". That is the honest reading: a number we could not
 * trust is not a number we have.
 */
function readMinorUnits(value: unknown): bigint | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = BigInt(value)
    return parsed > 0n ? parsed : undefined
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value)
  }
  return undefined
}

function readProviderEventId(raw: string): string | null {
  const id = safeParse(raw)['id']
  return typeof id === 'string' && id.length > 0 ? id : null
}

function readEventType(raw: string): string | null {
  const type = safeParse(raw)['type']
  return typeof type === 'string' && type.length > 0 ? type : null
}

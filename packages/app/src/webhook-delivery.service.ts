/**
 * Webhook delivery — `ARCHITECTURE.md § 6`, `API_CONTRACT.md § 10.3`.
 *
 * ```
 * transition ──┬─> settlements.status        (same transaction)
 *              ├─> events                    (append-only)
 *              └─> outbox                    (pending deliveries)
 *                         │
 *                    worker picks up
 * ```
 *
 * The outbox has existed since Stage 1 and nothing has read it until now. Two
 * phases, and the split between them is the whole safety property:
 *
 * **`drainOutbox` is a transaction and makes no network call.** It claims
 * pending rows with `FOR UPDATE SKIP LOCKED`, works out which endpoints want
 * each event, writes one delivery row per (event, endpoint), enqueues the job
 * that will attempt it, and commits. Adapters are never called from inside a
 * transaction (`ARCHITECTURE.md § 5`), and a customer's HTTP endpoint is an
 * adapter in every way that matters.
 *
 * **`runWebhookDelivery` makes the call and holds nothing.** It reads what it
 * needs, posts, and records the outcome in a short transaction afterwards. An
 * endpoint that takes thirty seconds to time out costs thirty seconds of
 * nothing.
 *
 * One delivery row per (event, endpoint) rather than one per event, because two
 * endpoints fail independently: an endpoint that is down must not hold back one
 * that is up. That is `INV-30`'s reasoning — a container is not a transaction —
 * applied to delivery.
 */
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm'
import type { Db, Environment } from '@inrsettle/db'
import { schema, withTenant, withoutScope } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import { enqueue } from '@inrsettle/jobs'
import {
  buildSignatureHeader, classifyResponse, endpointHealthAfter, endpointWantsEvent,
  isCustomerEventType, nextAttempt, truncateResponseBody, TEST_EVENT_TYPE,
  type DeliveryOutcome, type TenantScope,
} from '@inrsettle/domain'
import type { FieldCipher } from './crypto/field-encryption.js'
import { liveSecretsFor } from './webhook.service.js'
import { resolveCustomerEventObject } from './public/event-object.js'

export const WEBHOOK_DELIVER_JOB = 'webhook.deliver'

/**
 * The port. A customer's endpoint is reached through this and nothing else, so
 * a test can be an endpoint that is down for an hour without an hour passing.
 */
export interface WebhookTransport {
  post(args: {
    url: string
    body: string
    headers: Readonly<Record<string, string>>
    timeoutMs: number
  }): Promise<{ statusCode: number; body: string } | { error: string }>
}

export interface DeliveryDeps {
  readonly transport: WebhookTransport
  readonly cipher: FieldCipher
  /** Injected so the schedule is assertable and the tolerance testable. */
  readonly now: () => Date
  /** A draw in [0, 1) for backoff jitter. */
  readonly random?: () => number
  readonly timeoutMs?: number
}

export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000

/* ── Phase 0: which tenants have work ───────────────────────────────────── */

/**
 * The scopes with pending outbox rows.
 *
 * Through a definer function that returns scope pairs and nothing else, because
 * a NOBYPASSRLS worker cannot otherwise discover that a workspace it was never
 * told about has events waiting.
 *
 * **This is a worker-only capability.** `pending_outbox_scopes` is the one
 * cross-tenant read in the delivery path: it answers "which workspaces have
 * something waiting" for a caller that is, by construction, allowed to know.
 * `inrsettle_app` is not that caller — an API process holding it could
 * enumerate every workspace in the deployment through a function whose whole
 * purpose is to see past RLS, so migration `0015` revokes EXECUTE from
 * `inrsettle_app` and grants it to `inrsettle_worker` alone. Pass a
 * worker-role pool here; an application pool gets `permission denied`, which
 * is the correct and loud answer.
 *
 * The drain that follows takes the ordinary application pool and runs under
 * normal RLS. Only the *discovery* step is privileged, and it returns scope
 * pairs — never a row, never a payload.
 */
export async function pendingOutboxScopes(
  workerDb: Db, limit = 50,
): Promise<readonly TenantScope[]> {
  const rows = (await withoutScope(workerDb, (conn) =>
    conn.execute(sql`SELECT * FROM pending_outbox_scopes(${limit})`),
  )) as unknown as { workspace_id: string; environment: Environment }[]
  return rows.map((r) => ({ workspaceId: r.workspace_id, environment: r.environment }))
}

/* ── Phase 1: fan out ───────────────────────────────────────────────────── */

export interface DrainResult {
  readonly claimed: number
  readonly deliveriesCreated: number
  /** Events with no endpoint that wanted them — delivered to nobody, on purpose. */
  readonly undeliverable: number
}

export async function drainOutbox(
  db: Db, scope: TenantScope, opts: { batchSize?: number } = {},
): Promise<DrainResult> {
  const batchSize = opts.batchSize ?? 100

  return withTenant(db, scope, async (tx) => {
    const claimed = (await tx.execute(sql`
      SELECT o.id, o.event_id, e.type
        FROM outbox o JOIN events e ON e.id = o.event_id
       WHERE o.status = 'pending' AND o.next_attempt_at <= now()
       ORDER BY o.created_at
       LIMIT ${batchSize}
         FOR UPDATE OF o SKIP LOCKED`)) as unknown as
      { id: string; event_id: string; type: string }[]

    if (claimed.length === 0) {
      return { claimed: 0, deliveriesCreated: 0, undeliverable: 0 }
    }

    const endpoints = await tx.select().from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.status, 'enabled'))

    let created = 0
    let undeliverable = 0

    for (const row of claimed) {
      // The allow-list, applied at the last possible moment. An internal event
      // that reached the outbox — a liquidity movement, a payout attempt — stops
      // here rather than at whoever wrote it, because the guarantee in § 10.2 is
      // about what leaves the system, not about who remembered.
      const wanted = isCustomerEventType(row.type)
        ? endpoints.filter((e) => endpointWantsEvent(e.eventTypes, row.type))
        : []

      if (wanted.length === 0) undeliverable += 1

      for (const endpoint of wanted) {
        const deliveryId = newId('webhookDelivery')
        const inserted = (await tx.execute(sql`
          INSERT INTO webhook_deliveries
            (id, workspace_id, environment, endpoint_id, event_id, origin)
          VALUES (${deliveryId}, ${scope.workspaceId}, ${scope.environment}::environment,
                  ${endpoint.id}, ${row.event_id}, 'outbox')
          ON CONFLICT (endpoint_id, event_id) WHERE origin = 'outbox' DO NOTHING
          RETURNING id`)) as unknown as { id: string }[]

        // Already there: this outbox row was drained before and the fan-out is
        // being repeated. That is a no-op, which is what makes the drain safe to
        // run twice (`ARCHITECTURE.md § 7`).
        if (inserted.length === 0) continue
        created += 1
        await enqueueDelivery(tx, scope, deliveryId)
      }

      await tx.execute(sql`
        UPDATE outbox SET status = 'delivered', delivered_at = now()
         WHERE id = ${row.id}`)
    }

    return { claimed: claimed.length, deliveriesCreated: created, undeliverable }
  })
}

async function enqueueDelivery(
  tx: Db, scope: TenantScope, deliveryId: string, runAt?: Date,
): Promise<void> {
  await enqueue(
    tx,
    WEBHOOK_DELIVER_JOB,
    { deliveryId, workspaceId: scope.workspaceId, environment: scope.environment },
    {
      // Keyed on the delivery, so a re-drain or a double enqueue collapses onto
      // one job rather than posting the same event twice.
      jobKey: `${WEBHOOK_DELIVER_JOB}:${deliveryId}`,
      ...(runAt ? { runAt } : {}),
    },
  )
}

/* ── Phase 2: attempt ───────────────────────────────────────────────────── */

export type AttemptResult =
  | { readonly kind: 'delivered'; readonly statusCode: number; readonly attemptNumber: number }
  | {
      readonly kind: 'retrying'
      readonly attemptNumber: number
      readonly nextAttemptAt: Date
      readonly outcome: DeliveryOutcome
    }
  | { readonly kind: 'gave_up'; readonly attemptNumber: number; readonly outcome: DeliveryOutcome }
  | { readonly kind: 'skipped'; readonly why: 'not_found' | 'already_settled' | 'endpoint_gone' }

/**
 * The envelope — `API_CONTRACT.md § 10.1`.
 *
 * `data.object` is **the public object**, resolved through the same serializers
 * `/v1` uses — never the event row's payload. The payload is what the transition
 * wrote for its own audit purposes, and it is internal by construction: a
 * `settlement.created` payload is `{"transition": "T01", "to": "DRAFT"}`.
 * Delivering that to a customer endpoint would put the internal state machine on
 * the integration surface `§ 10.2` says it must never be, through the very field
 * meant to hold the public object.
 *
 * Resolved at delivery time rather than stored, because `§ 10.1` says
 * `data.object` is *"the full settlement object"* — and § 10.3 tells clients
 * events can arrive out of order and to re-read for anything irreversible, which
 * only makes sense if the object is current rather than a snapshot.
 */
export function buildEnvelope(args: {
  eventId: string
  type: string
  apiVersion: string
  environment: string
  workspaceId: string
  createdAt: Date
  object: unknown
}): string {
  return JSON.stringify({
    id: args.eventId,
    object: 'event',
    type: args.type,
    api_version: args.apiVersion,
    environment: args.environment,
    workspace_id: args.workspaceId,
    created_at: args.createdAt.toISOString(),
    data: { object: args.object },
  })
}

interface DeliveryContext {
  deliveryId: string
  endpointId: string
  url: string
  attemptCount: number
  consecutiveFailures: number
  body: string
  secrets: readonly string[]
}

async function loadContext(
  db: Db, scope: TenantScope, deps: DeliveryDeps, deliveryId: string,
): Promise<DeliveryContext | { skipped: AttemptResult }> {
  return withTenant(db, scope, async (tx) => {
    const [delivery] = await tx.select().from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, deliveryId)).limit(1)
    if (!delivery) return { skipped: { kind: 'skipped', why: 'not_found' } as const }
    if (delivery.status === 'succeeded' || delivery.status === 'exhausted') {
      return { skipped: { kind: 'skipped', why: 'already_settled' } as const }
    }

    const [endpoint] = await tx.select().from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, delivery.endpointId)).limit(1)
    if (!endpoint || endpoint.status === 'disabled') {
      return { skipped: { kind: 'skipped', why: 'endpoint_gone' } as const }
    }

    const [event] = await tx.select().from(schema.events)
      .where(eq(schema.events.id, delivery.eventId)).limit(1)
    if (!event) return { skipped: { kind: 'skipped', why: 'not_found' } as const }

    const [workspace] = await tx.select({
      apiVersion: schema.workspaces.apiVersion,
      numberFormat: schema.workspaces.numberFormat,
    }).from(schema.workspaces).limit(1)

    const secrets = await liveSecretsFor(tx, scope, deps.cipher, endpoint.id, deps.now())
    const object = await resolveCustomerEventObject(tx, scope, {
      type: event.type, subjectType: event.subjectType, subjectId: event.subjectId,
    }, { numberFormat: workspace?.numberFormat === 'indian' ? 'indian' : 'international' })

    return {
      deliveryId,
      endpointId: endpoint.id,
      url: endpoint.url,
      attemptCount: delivery.attemptCount,
      consecutiveFailures: endpoint.consecutiveFailures,
      secrets,
      body: buildEnvelope({
        eventId: event.id,
        type: event.type,
        apiVersion: workspace?.apiVersion ?? '2026-08-31',
        environment: scope.environment,
        workspaceId: scope.workspaceId,
        createdAt: event.createdAt,
        object,
      }),
    }
  })
}

export async function runWebhookDelivery(
  db: Db, scope: TenantScope, deps: DeliveryDeps, input: { deliveryId: string },
): Promise<AttemptResult> {
  const loaded = await loadContext(db, scope, deps, input.deliveryId)
  if ('skipped' in loaded) return loaded.skipped
  const ctx = loaded

  const timestampSeconds = Math.floor(deps.now().getTime() / 1000)
  const signature = buildSignatureHeader({
    secrets: ctx.secrets, timestampSeconds, rawBody: ctx.body,
  })

  const attemptNumber = ctx.attemptCount + 1
  const startedAt = Date.now()
  // Outside every transaction. This is the unbounded part.
  const response = await deps.transport.post({
    url: ctx.url,
    body: ctx.body,
    headers: {
      'Content-Type': 'application/json',
      'INRSettle-Signature': signature,
      'INRSettle-Delivery': ctx.deliveryId,
      'INRSettle-Attempt': String(attemptNumber),
    },
    timeoutMs: deps.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
  })
  const durationMs = Date.now() - startedAt

  const outcome: DeliveryOutcome = 'error' in response
    ? { kind: 'retryable', error: response.error }
    : classifyResponse(response.statusCode)

  const schedule = outcome.kind === 'delivered'
    ? null
    : outcome.kind === 'rejected'
      // A 4xx that is not 408 or 429 will not become a 2xx by being repeated.
      // Fourteen more identical refusals over 24 hours is noise in somebody's
      // error budget, and it delays nothing that was going to succeed.
      ? null
      : nextAttempt(attemptNumber, deps.random?.() ?? Math.random())

  const nextAt = schedule
    ? new Date(deps.now().getTime() + schedule.delaySeconds * 1000)
    : null

  await withTenant(db, scope, async (tx) => {
    await tx.insert(schema.webhookAttempts).values({
      id: newId('webhookAttempt'),
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      deliveryId: ctx.deliveryId,
      attemptNumber,
      statusCode: 'error' in response ? null : response.statusCode,
      responseBody: 'error' in response ? null : truncateResponseBody(response.body),
      error: 'error' in response ? response.error : null,
      durationMs,
    })

    await tx.update(schema.webhookDeliveries).set({
      status: outcome.kind === 'delivered'
        ? 'succeeded'
        : nextAt === null ? 'exhausted' : 'failed',
      attemptCount: attemptNumber,
      ...(nextAt ? { nextAttemptAt: nextAt } : {}),
      ...(ctx.attemptCount === 0 ? { firstAttemptAt: deps.now() } : {}),
      ...(outcome.kind === 'delivered' ? { succeededAt: deps.now() } : {}),
    }).where(eq(schema.webhookDeliveries.id, ctx.deliveryId))

    const health = endpointHealthAfter(ctx.consecutiveFailures, outcome)
    await tx.update(schema.webhookEndpoints).set({
      consecutiveFailures: health.consecutiveFailures,
      ...(health.action === 'open_circuit'
        ? { status: 'circuit_open' as const, circuitOpenedAt: deps.now() }
        : {}),
    }).where(eq(schema.webhookEndpoints.id, ctx.endpointId))

    if (health.action === 'open_circuit') {
      // The workspace is told, in its own event stream, that its endpoint has
      // been taken out of service. `deliver: false` — announcing a broken
      // endpoint through the endpoint that is broken would be circular.
      await tx.insert(schema.events).values({
        id: newId('event'),
        workspaceId: scope.workspaceId,
        environment: scope.environment,
        type: 'webhook_endpoint.circuit_opened',
        subjectType: 'webhook_endpoint',
        subjectId: ctx.endpointId,
        actorType: 'job',
        actorId: WEBHOOK_DELIVER_JOB,
        payload: { consecutive_failures: health.consecutiveFailures },
      })
    }

    if (nextAt) await enqueueDelivery(tx, scope, ctx.deliveryId, nextAt)
  })

  if (outcome.kind === 'delivered') {
    return { kind: 'delivered', statusCode: outcome.statusCode, attemptNumber }
  }
  return nextAt === null
    ? { kind: 'gave_up', attemptNumber, outcome }
    : { kind: 'retrying', attemptNumber, nextAttemptAt: nextAt, outcome }
}

/* ── Replay and test ────────────────────────────────────────────────────── */

/**
 * Re-send one event to one endpoint — `§ 10.3`'s *"with a replay action"*.
 *
 * A new delivery chain, not a reopening of the old one. The original attempts
 * stay exactly as they were, because the question a replay is answering is
 * "did it work this time", and overwriting the history of the first attempt
 * would destroy the answer to "why did it not work last time".
 */
export async function replayEvent(
  tx: Db, scope: TenantScope, args: { eventId: string; endpointId: string },
): Promise<{ deliveryId: string } | null> {
  const [event] = await tx.select().from(schema.events)
    .where(eq(schema.events.id, args.eventId)).limit(1)
  if (!event || !isCustomerEventType(event.type)) return null

  const [endpoint] = await tx.select().from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, args.endpointId)).limit(1)
  if (!endpoint) return null

  const deliveryId = newId('webhookDelivery')
  await tx.insert(schema.webhookDeliveries).values({
    id: deliveryId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    endpointId: args.endpointId,
    eventId: args.eventId,
    origin: 'replay',
  })
  await enqueueDelivery(tx, scope, deliveryId)
  return { deliveryId }
}

/**
 * `POST /v1/webhook_endpoints/{id}/test` — *"Sends a signed test event."*
 *
 * A real event row, so it appears in the event log beside every other delivery
 * and can be replayed like one. Its type is `endpoint.test`, which is
 * deliberately not in the deliverable allow-list: a test event is not something
 * that happened, and an integration that treated it as one would act on a
 * settlement that does not exist.
 */
export async function sendTestEvent(
  tx: Db, scope: TenantScope, args: { endpointId: string; actorId: string },
): Promise<{ deliveryId: string; eventId: string } | null> {
  const [endpoint] = await tx.select().from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, args.endpointId)).limit(1)
  if (!endpoint) return null

  const eventId = newId('event')
  await tx.insert(schema.events).values({
    id: eventId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    type: TEST_EVENT_TYPE,
    subjectType: 'webhook_endpoint',
    subjectId: args.endpointId,
    actorType: 'api_key',
    actorId: args.actorId,
    payload: {
      message: 'This is a test event from INRSettle. Nothing has happened to any settlement.',
    },
  })

  const deliveryId = newId('webhookDelivery')
  await tx.insert(schema.webhookDeliveries).values({
    id: deliveryId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    endpointId: args.endpointId,
    eventId,
    origin: 'test',
  })
  await enqueueDelivery(tx, scope, deliveryId)
  return { deliveryId, eventId }
}

/* ── Reading the log ────────────────────────────────────────────────────── */

export interface AttemptRecord {
  readonly attemptNumber: number
  readonly statusCode: number | null
  readonly error: string | null
  readonly responseBody: string | null
  readonly durationMs: number
  readonly attemptedAt: Date
}

export interface DeliveryRecord {
  readonly id: string
  readonly endpointId: string
  readonly eventId: string
  readonly origin: 'outbox' | 'replay' | 'test'
  readonly status: 'pending' | 'delivering' | 'succeeded' | 'failed' | 'exhausted'
  readonly attemptCount: number
  readonly nextAttemptAt: Date
  readonly attempts: readonly AttemptRecord[]
}

/** Every attempt for an event, which is what "shows every attempt" means. */
export async function deliveriesForEvent(
  tx: Db, _scope: TenantScope, eventId: string,
): Promise<readonly DeliveryRecord[]> {
  const deliveries = await tx.select().from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.eventId, eventId))
  if (deliveries.length === 0) return []

  const attempts = await tx.select().from(schema.webhookAttempts)
    .where(inArray(schema.webhookAttempts.deliveryId, deliveries.map((d) => d.id)))
    // By attempt number, not by id: INV-09 ids are random, and two attempts can
    // share a timestamp.
    .orderBy(schema.webhookAttempts.attemptNumber)

  return deliveries.map((d) => ({
    id: d.id,
    endpointId: d.endpointId,
    eventId: d.eventId,
    origin: d.origin,
    status: d.status,
    attemptCount: d.attemptCount,
    nextAttemptAt: d.nextAttemptAt,
    attempts: attempts.filter((a) => a.deliveryId === d.id).map((a) => ({
      attemptNumber: a.attemptNumber,
      statusCode: a.statusCode,
      error: a.error,
      responseBody: a.responseBody,
      durationMs: a.durationMs,
      attemptedAt: a.attemptedAt,
    })),
  }))
}

/** Deliveries whose next attempt is due — the recovery path after a restart. */
export async function dueDeliveries(
  tx: Db, _scope: TenantScope, now: Date, limit = 100,
): Promise<readonly string[]> {
  const rows = await tx.select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(and(
      or(
        eq(schema.webhookDeliveries.status, 'pending'),
        eq(schema.webhookDeliveries.status, 'failed'),
      ),
      lte(schema.webhookDeliveries.nextAttemptAt, now),
    ))
    .limit(limit)
  return rows.map((r) => r.id)
}

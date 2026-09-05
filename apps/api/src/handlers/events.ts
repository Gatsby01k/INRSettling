/**
 * Event endpoints — `API_CONTRACT.md § 8`, `§ 10.1`, and `PRODUCT.md § 13`'s
 * *"event logs · replay"*.
 *
 * > `GET /v1/events` — Every event the workspace can see
 *
 * "Can see" is the whole design of this file. The workspace's `events` table
 * holds every event the domain emitted, internal ones included: liquidity
 * movements, drawdowns, reservations, payout attempts. `§ 10.2` is unambiguous
 * that those are never delivered to customer endpoints — *"The internal state
 * machine is not the integration surface"* — and an endpoint that listed them
 * would be delivering them by another route.
 *
 * So the same allow-list that gates delivery gates this listing. A test asserts
 * an internal event is invisible here even to a key holding every scope.
 *
 * Each event carries its delivery history, which is what makes `§ 10.3`'s *"Every
 * attempt, its response code and its body are visible in Developers → Event
 * logs, with a replay action"* true of the API and not only of a screen.
 */
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { schema } from '@inrsettle/db'
import { ApiError, CUSTOMER_EVENT_TYPES, isCustomerEventType, notFound } from '@inrsettle/domain'
import { deliveriesForEvent, replayEvent, resolveCustomerEventObject } from '@inrsettle/app-services'
import type { Handler, HandlerContext } from '../pipeline.js'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, listEnvelope } from '../http.js'
import { eventJson, timestamp } from '@inrsettle/app-services'

async function withDeliveries(
  ctx: HandlerContext, row: typeof schema.events.$inferSelect,
): Promise<Record<string, unknown>> {
  const deliveries = await deliveriesForEvent(ctx.tx, ctx.scope, row.id)
  // The same resolver webhook delivery uses. `§ 10.1` says the envelope carries
  // the public object; an event read over the API and the same event delivered
  // to an endpoint have to be the same document, and the only way to be sure of
  // that is for there to be one function.
  const object = await resolveCustomerEventObject(ctx.tx, ctx.scope, {
    type: row.type, subjectType: row.subjectType, subjectId: row.subjectId,
  }, { numberFormat: ctx.numberFormat, purposeLabels: purposeLabels(ctx) })

  return {
    ...eventJson(
      { id: row.id, type: row.type, createdAt: row.createdAt, object },
      ctx.apiVersion, ctx.scope.environment, ctx.scope.workspaceId,
    ),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      endpoint_id: d.endpointId,
      origin: d.origin,
      status: d.status,
      attempt_count: d.attemptCount,
      next_attempt_at: timestamp(d.nextAttemptAt),
      attempts: d.attempts.map((a) => ({
        attempt_number: a.attemptNumber,
        status_code: a.statusCode,
        error: a.error,
        response_body: a.responseBody,
        duration_ms: a.durationMs,
        attempted_at: timestamp(a.attemptedAt),
      })),
    })),
  }
}

export const listEventsHandler: Handler = async (ctx) => {
  const limit = parseLimit(ctx.query['limit'])
  const filters = [inArray(schema.events.type, [...CUSTOMER_EVENT_TYPES])]

  const type = ctx.query['type']
  if (type !== undefined) {
    if (!isCustomerEventType(type)) {
      throw new ApiError({
        type: 'invalid_request_error', code: 'unknown_event_type',
        message: `"${type}" is not an event type this workspace can see.`,
        detail: `Filter on one of: ${CUSTOMER_EVENT_TYPES.join(', ')}.`,
        param: 'type',
      })
    }
    filters.push(eq(schema.events.type, type))
  }

  const after = ctx.query['starting_after']
  if (after !== undefined) {
    const [anchor] = await ctx.tx.select({ createdAt: schema.events.createdAt })
      .from(schema.events).where(eq(schema.events.id, after)).limit(1)
    if (!anchor) throw notFound('event named by starting_after')
    filters.push(lt(schema.events.createdAt, anchor.createdAt))
  }

  const rows = await ctx.tx.select().from(schema.events)
    .where(and(...filters))
    .orderBy(desc(schema.events.createdAt))
    .limit(limit + 1)

  const serialized = await Promise.all(rows.map((r) => withDeliveries(ctx, r)))
  return { status: 200, body: listEnvelope(serialized, limit, (row) => String(row['id'])) }
}

export const getEventHandler: Handler = async (ctx) => {
  const [row] = await ctx.tx.select().from(schema.events)
    .where(eq(schema.events.id, ctx.params['id']!)).limit(1)
  // An internal event is not "forbidden", it is not part of this surface at
  // all — and saying so with a 403 would confirm it exists.
  if (!row || !isCustomerEventType(row.type)) throw notFound('event')
  return { status: 200, body: await withDeliveries(ctx, row) }
}

/** Kept beside the event handlers because replay is an event-log action. */
export async function replayToEndpoint(
  ctx: HandlerContext, eventId: string, endpointId: string,
): Promise<{ deliveryId: string }> {
  const result = await replayEvent(ctx.tx, ctx.scope, { eventId, endpointId })
  if (!result) throw notFound('event or endpoint')
  return result
}

/** The rule set's purpose labels, so an event's settlement reads like the API's. */
function purposeLabels(ctx: HandlerContext): ReadonlyMap<string, string> {
  return new Map(ctx.deps.ruleSet.purposeCodes.map((p) => [p.code, p.label]))
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

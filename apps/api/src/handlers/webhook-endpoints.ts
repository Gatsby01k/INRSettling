/**
 * Webhook endpoint management — `API_CONTRACT.md § 8`, `§ 10`.
 *
 * The signing secret is returned **once**, on creation, and never again by a
 * `GET`. That is the same rule the API key follows and for the same reason: a
 * secret a listing endpoint hands back is a secret that lives in every log,
 * every screenshot and every cached response between here and the customer.
 * A customer who has lost it rotates, which is a deliberate act with an overlap
 * window rather than a lookup.
 */
import { ApiError, notFound } from '@inrsettle/domain'
import {
  createWebhookEndpoint, deleteWebhookEndpoint, getWebhookEndpoint, sendTestEvent,
} from '@inrsettle/app-services'
import type { Handler } from '../pipeline.js'
import { timestamp } from '@inrsettle/app-services'
import { requireBody, requireString, stringArrayField, stringField } from './body.js'

function endpointJson(e: {
  id: string
  url: string
  description: string | null
  eventTypes: readonly string[]
  status: string
  consecutiveFailures: number
  circuitOpenedAt: Date | null
  createdAt: Date
}): Record<string, unknown> {
  return {
    id: e.id,
    object: 'webhook_endpoint',
    url: e.url,
    description: e.description,
    // An empty array means every customer-visible type, and the field says so
    // rather than the client having to know.
    event_types: e.eventTypes,
    subscribes_to_all: e.eventTypes.length === 0,
    status: e.status,
    consecutive_failures: e.consecutiveFailures,
    circuit_opened_at: timestamp(e.circuitOpenedAt),
    created_at: timestamp(e.createdAt),
  }
}

export const createWebhookEndpointHandler: Handler = async (ctx) => {
  const body = requireBody(ctx)
  const created = await createWebhookEndpoint(
    ctx.tx, ctx.scope, ctx.deps.webhookCipher,
    {
      url: requireString(body, 'url'),
      description: stringField(body, 'description'),
      eventTypes: stringArrayField(body, 'event_types'),
      actor: ctx.key.principal,
      // The key already had to hold `webhook:manage` to reach this handler.
      actorCapabilities: new Set(['apikey:manage', 'webhook:manage'] as const),
    },
  )
  return {
    status: 201,
    subjectId: created.id,
    body: {
      ...endpointJson(created),
      // Once. Store it now; there is no endpoint that will give it back.
      secret: created.secret,
      secret_note:
        'This is the only time this secret is shown. Store it in your secret manager now — ' +
        'verification snippets are in the reference. If you lose it, rotate the endpoint.',
    },
  }
}

export const getWebhookEndpointHandler: Handler = async (ctx) => {
  const endpoint = await getWebhookEndpoint(ctx.tx, ctx.params['id']!)
  if (!endpoint) throw notFound('webhook endpoint')
  return { status: 200, body: endpointJson(endpoint) }
}

export const deleteWebhookEndpointHandler: Handler = async (ctx) => {
  const removed = await deleteWebhookEndpoint(ctx.tx, ctx.scope, {
    endpointId: ctx.params['id']!,
    actor: ctx.key.principal,
    actorCapabilities: new Set(['apikey:manage', 'webhook:manage'] as const),
  })
  if (!removed) throw notFound('webhook endpoint')
  return { status: 200, body: { id: ctx.params['id']!, object: 'webhook_endpoint', deleted: true } }
}

/**
 * `POST /v1/webhook_endpoints/{id}/test` — *"Sends a signed test event."*
 *
 * Signed identically to a real delivery, so what it exercises is the customer's
 * actual verification code rather than a special case of it. Its type is
 * `endpoint.test`, which is deliberately not a deliverable customer event: a
 * test event is not something that happened, and an integration that treated it
 * as one would act on a settlement that does not exist.
 */
export const testWebhookEndpointHandler: Handler = async (ctx) => {
  const result = await sendTestEvent(ctx.tx, ctx.scope, {
    endpointId: ctx.params['id']!,
    actorId: ctx.key.keyId,
  })
  if (!result) throw notFound('webhook endpoint')
  return {
    status: 202,
    subjectId: ctx.params['id']!,
    body: {
      object: 'webhook_test',
      endpoint_id: ctx.params['id']!,
      event_id: result.eventId,
      delivery_id: result.deliveryId,
      note: 'Queued. Watch the delivery attempts on this event in the event log.',
    },
  }
}

export const webhookEndpointRefusal = (message: string): ApiError =>
  new ApiError({
    type: 'invalid_request_error',
    code: 'invalid_parameter',
    message,
    detail: 'Check the endpoint URL and the event types against the reference.',
  })

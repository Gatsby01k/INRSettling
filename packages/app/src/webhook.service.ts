/**
 * Webhook endpoints — `API_CONTRACT.md § 10`, `SECURITY.md § 4.1`.
 *
 * The signing secret is the one customer-facing secret in the system, and it has
 * two properties that pull against each other: it must be **retrievable**,
 * because a customer configures their verifier with it, and a disclosure of it
 * would let anyone forge a `settlement.settled` at that endpoint. So it is
 * stored under the same envelope encryption a payout destination uses — the
 * database holds ciphertext, the key lives outside it, and a table dump yields
 * nothing usable.
 *
 * **Two secrets, not one.** `§ 4.1`: *"Secrets are rotatable with dual-secret
 * overlap so rotation never drops an event."* A delivery during the overlap is
 * signed with both, and a verifier accepts if either matches, so the customer
 * cuts over on their own schedule instead of on ours.
 */
import { randomBytes } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  ApiError, CUSTOMER_EVENT_TYPES, isCustomerEventType,
  type Capability, type PrincipalRef, type TenantScope,
} from '@inrsettle/domain'
import type { FieldCipher } from './crypto/field-encryption.js'
import { eventSink } from './events.js'

export const WEBHOOK_SECRET_PREFIX = 'whsec_'
/** The window in which a rotated-out secret still verifies. */
export const SECRET_OVERLAP_HOURS = 24

const secretField = (scope: TenantScope) => ({
  field: 'webhook_endpoint.secret',
  workspaceId: scope.workspaceId,
  environment: scope.environment,
})

export interface WebhookEndpointView {
  readonly id: string
  readonly url: string
  readonly description: string | null
  readonly eventTypes: readonly string[]
  readonly status: 'enabled' | 'disabled' | 'circuit_open' | 'deleted'
  readonly consecutiveFailures: number
  readonly circuitOpenedAt: Date | null
  readonly createdAt: Date
}

export interface CreatedWebhookEndpoint extends WebhookEndpointView {
  /** Shown once at creation and once on an explicit, audited reveal. */
  readonly secret: string
}

const unknownEventType = (type: string): ApiError =>
  new ApiError({
    type: 'invalid_request_error',
    code: 'unknown_event_type',
    message: `"${type}" is not an event type you can subscribe to.`,
    detail:
      'Subscribe to one of the customer event types listed in the reference, or send no ' +
      `event_types at all to receive every one of them. Known types: ${CUSTOMER_EVENT_TYPES.join(', ')}.`,
    param: 'event_types',
  })

const notHttps = (): ApiError =>
  new ApiError({
    type: 'invalid_request_error',
    code: 'invalid_parameter',
    message: 'A webhook endpoint URL must use https.',
    detail:
      'Events carry settlement and beneficiary data, and a signature does not make plaintext ' +
      'transport private. Use an https URL.',
    param: 'url',
  })

const missingCapability = (): ApiError =>
  new ApiError({
    type: 'permission_error',
    code: 'insufficient_scope',
    message: 'This principal cannot manage webhook endpoints.',
    detail: 'Webhook endpoints are managed by an admin or a developer (SECURITY.md § 3.2).',
  })

function newSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`
}

/**
 * Subscribing to an event type the customer cannot see is refused, not ignored.
 *
 * Silently dropping it would leave a customer waiting for `payout.dispatched` to
 * arrive. Refusing tells them the truth: the internal state machine is not the
 * integration surface (`§ 10.2`).
 */
function validateEventTypes(types: readonly string[]): void {
  for (const t of types) if (!isCustomerEventType(t)) throw unknownEventType(t)
}

export async function createWebhookEndpoint(
  tx: Db,
  scope: TenantScope,
  cipher: FieldCipher,
  args: {
    url: string
    description?: string | undefined
    eventTypes?: readonly string[] | undefined
    actor: PrincipalRef
    actorCapabilities: ReadonlySet<Capability>
  },
): Promise<CreatedWebhookEndpoint> {
  if (!args.actorCapabilities.has('apikey:manage')) throw missingCapability()
  if (!args.url.startsWith('https://')) throw notHttps()
  const eventTypes = args.eventTypes ?? []
  validateEventTypes(eventTypes)

  const id = newId('webhookEndpoint')
  const secret = newSecret()

  const [row] = await tx.insert(schema.webhookEndpoints).values({
    id,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    url: args.url,
    description: args.description ?? null,
    eventTypes: [...eventTypes],
    secretCiphertext: cipher.encrypt(secret, secretField(scope)),
    createdBy: args.actor.id,
  }).returning()

  await eventSink(tx).audit(scope, {
    actor: args.actor,
    action: 'webhook_endpoint.created',
    subjectType: 'webhook_endpoint',
    subjectId: id,
    // The secret is not in the audit record. An audit trail that contains the
    // credential it is auditing is a second copy of the credential.
    after: { url: args.url, event_types: [...eventTypes] },
  })

  return { ...toView(row!), secret }
}

function toView(row: typeof schema.webhookEndpoints.$inferSelect): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.eventTypes,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    circuitOpenedAt: row.circuitOpenedAt,
    createdAt: row.createdAt,
  }
}

/**
 * No `scope` parameter, on purpose: RLS scopes this query, and a parameter the
 * function does not use would suggest it were the thing doing the scoping.
 *
 * Removed endpoints are **not** listed by default. A customer who deleted an
 * endpoint expects it gone from the list, and `GET /v1/webhook_endpoints` gives
 * them that. `includeRemoved` is for the Developers screen, which offers the
 * history deliberately rather than by leaving it lying in the collection.
 */
export async function listWebhookEndpoints(
  tx: Db, opts: { includeRemoved?: boolean } = {},
): Promise<readonly WebhookEndpointView[]> {
  const query = tx.select().from(schema.webhookEndpoints)
  const rows = opts.includeRemoved === true
    ? await query.orderBy(desc(schema.webhookEndpoints.createdAt))
    : await query
      .where(sql`status <> 'deleted'`)
      .orderBy(desc(schema.webhookEndpoints.createdAt))
  return rows.map(toView)
}

/**
 * One endpoint, removed or not.
 *
 * Readable after removal on purpose: its delivery history is retained, and a
 * delivery view that could not name the endpoint it was sent to would be a
 * history the customer cannot read.
 */
export async function getWebhookEndpoint(
  tx: Db, id: string,
): Promise<WebhookEndpointView | null> {
  const [row] = await tx.select().from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, id)).limit(1)
  return row ? toView(row) : null
}

/**
 * The secrets a delivery is signed with, and a verifier must accept.
 *
 * The previous secret is included only while its overlap window is open —
 * expiry is checked here rather than by a sweeper, so a secret that should have
 * stopped working has stopped working even if nothing has run.
 */
export async function liveSecretsFor(
  tx: Db, scope: TenantScope, cipher: FieldCipher, endpointId: string, now: Date,
): Promise<readonly string[]> {
  const [row] = await tx.select().from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, endpointId)).limit(1)
  if (!row) return []
  const secrets = [cipher.decrypt(row.secretCiphertext, secretField(scope))]
  if (
    row.previousSecretCiphertext !== null &&
    row.previousSecretExpiresAt !== null &&
    row.previousSecretExpiresAt > now
  ) {
    secrets.push(cipher.decrypt(row.previousSecretCiphertext, secretField(scope)))
  }
  return secrets
}

/** Reveal the current secret. Audited, because a reveal is a credential access. */
export async function revealWebhookSecret(
  tx: Db,
  scope: TenantScope,
  cipher: FieldCipher,
  args: { endpointId: string; actor: PrincipalRef; actorCapabilities: ReadonlySet<Capability> },
): Promise<string | null> {
  if (!args.actorCapabilities.has('apikey:manage')) throw missingCapability()
  const [row] = await tx.select().from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, args.endpointId)).limit(1)
  if (!row) return null

  await eventSink(tx).audit(scope, {
    actor: args.actor,
    action: 'webhook_endpoint.secret_revealed',
    subjectType: 'webhook_endpoint',
    subjectId: args.endpointId,
  })
  return cipher.decrypt(row.secretCiphertext, secretField(scope))
}

export async function rotateWebhookSecret(
  tx: Db,
  scope: TenantScope,
  cipher: FieldCipher,
  args: {
    endpointId: string
    now: Date
    actor: PrincipalRef
    actorCapabilities: ReadonlySet<Capability>
  },
): Promise<{ secret: string; previousExpiresAt: Date } | null> {
  if (!args.actorCapabilities.has('apikey:manage')) throw missingCapability()
  const [row] = await tx.select().from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, args.endpointId)).limit(1)
  if (!row) return null

  const secret = newSecret()
  const previousExpiresAt = new Date(args.now.getTime() + SECRET_OVERLAP_HOURS * 3600_000)

  await tx.update(schema.webhookEndpoints).set({
    secretCiphertext: cipher.encrypt(secret, secretField(scope)),
    // The secret being rotated out, not whatever was already in the previous
    // slot: two rotations inside one overlap window must not resurrect a secret
    // the customer has already retired.
    previousSecretCiphertext: row.secretCiphertext,
    previousSecretExpiresAt: previousExpiresAt,
  }).where(eq(schema.webhookEndpoints.id, args.endpointId))

  await eventSink(tx).audit(scope, {
    actor: args.actor,
    action: 'webhook_endpoint.secret_rotated',
    subjectType: 'webhook_endpoint',
    subjectId: args.endpointId,
    after: { previous_secret_expires_at: previousExpiresAt.toISOString() },
  })
  return { secret, previousExpiresAt }
}

/**
 * Delete an endpoint — `DELETE /v1/webhook_endpoints/{id}`.
 *
 * **A soft delete**, and the row is what makes the history readable.
 *
 * The first cut really deleted, and `webhook_deliveries` cascaded — so removing
 * an endpoint erased every delivery and every attempt made to it. That is the
 * wrong half of the system to optimise for tidiness. `§ 10.3` promises *"every
 * attempt, its response code and its body are visible in Developers → Event
 * logs"*, and the moment a customer most needs that history is right after they
 * have torn down the endpoint that was failing: *what did you try to send me,
 * and what did my server say*.
 *
 * So the endpoint is marked `deleted`, keeps its id and its URL, and stops being
 * selected for delivery. It is the same shape a beneficiary already has —
 * disabled, never removed, because something was sent against it — and the
 * migration backs it: `DELETE` is not granted on either table, so a real delete
 * is not available to reach for.
 */
export async function deleteWebhookEndpoint(
  tx: Db,
  scope: TenantScope,
  args: { endpointId: string; actor: PrincipalRef; actorCapabilities: ReadonlySet<Capability> },
): Promise<boolean> {
  if (!args.actorCapabilities.has('apikey:manage')) throw missingCapability()
  const updated = await tx.update(schema.webhookEndpoints)
    .set({ status: 'deleted', disabledAt: new Date() })
    .where(and(
      eq(schema.webhookEndpoints.id, args.endpointId),
      sql`status <> 'deleted'`,
    ))
    .returning({ id: schema.webhookEndpoints.id })
  if (updated.length === 0) return false

  await eventSink(tx).audit(scope, {
    actor: args.actor,
    action: 'webhook_endpoint.deleted',
    subjectType: 'webhook_endpoint',
    subjectId: args.endpointId,
    after: { retained: 'delivery history is kept and remains readable in the event log' },
  })
  return true
}

/**
 * Re-enable an endpoint whose circuit opened.
 *
 * Manual on purpose. A circuit that closed itself on a timer would re-deliver
 * into an endpoint nobody has looked at, fail again, and repeat — and the
 * customer's first sign of the problem would be the second outage rather than
 * the first.
 */
export async function reopenWebhookEndpoint(
  tx: Db,
  scope: TenantScope,
  args: { endpointId: string; actor: PrincipalRef; actorCapabilities: ReadonlySet<Capability> },
): Promise<boolean> {
  if (!args.actorCapabilities.has('apikey:manage')) throw missingCapability()
  const updated = await tx.update(schema.webhookEndpoints).set({
    status: 'enabled', consecutiveFailures: 0, circuitOpenedAt: null,
  }).where(and(
    eq(schema.webhookEndpoints.id, args.endpointId),
    sql`status <> 'enabled'`,
    // Removal is not a circuit that reopens. Retaining the history of a removed
    // endpoint must not also retain a way to start sending to that URL again —
    // the customer took it down, and the safe way back is a new endpoint with a
    // new secret they chose to create.
    sql`status <> 'deleted'`,
  )).returning({ id: schema.webhookEndpoints.id })
  if (updated.length === 0) return false

  await eventSink(tx).audit(scope, {
    actor: args.actor,
    action: 'webhook_endpoint.reopened',
    subjectType: 'webhook_endpoint',
    subjectId: args.endpointId,
  })
  return true
}

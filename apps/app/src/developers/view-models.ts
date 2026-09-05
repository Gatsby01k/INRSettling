/**
 * Developers — `PRODUCT.md § 13`.
 *
 * > Sandbox and Live environments · API keys · webhook endpoints and signing
 * > secrets · request logs · event logs · replay and test-webhook actions · API
 * > reference · copyable examples in curl, TypeScript and Python.
 *
 * View-models only: pure functions from data to what a screen shows, with no
 * React and no database, tested as functions. The same discipline the
 * settlement, beneficiary, liquidity and batch surfaces already follow.
 *
 * Two rules run through the whole file, and both are `SECURITY.md`:
 *
 * **A secret is shown once.** An API key and a webhook signing secret are
 * returned at creation and never again; every later view renders the searchable
 * prefix and nothing else. A screen that could re-display a secret is a screen
 * that puts it in a screenshot, a support ticket and a cache.
 *
 * **A log is not an exception to the logging rules.** The request log carries no
 * request body and no response body, because a settlement request body carries
 * beneficiary details and `§ 8` does not stop applying because the log has a UI.
 */

/* ── API keys ───────────────────────────────────────────────────────────── */

export interface ApiKeyInput {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly environment: 'sandbox' | 'live'
  readonly scopes: readonly string[]
  readonly createdAt: Date
  readonly lastUsedAt: Date | null
  readonly revokedAt: Date | null
}

export interface ApiKeyRow {
  readonly id: string
  readonly name: string
  /** `sk_test_••••` — the searchable prefix and a mask, never the secret. */
  readonly masked: string
  readonly environmentLabel: string
  readonly scopeSummary: string
  readonly state: 'active' | 'revoked' | 'unused'
  readonly stateLabel: string
  readonly lastUsedLabel: string
}

export function apiKeyRow(key: ApiKeyInput, now: Date): ApiKeyRow {
  const state = key.revokedAt !== null
    ? 'revoked'
    : key.lastUsedAt === null ? 'unused' : 'active'

  return {
    id: key.id,
    name: key.name,
    masked: `${key.prefix}••••`,
    environmentLabel: key.environment === 'live' ? 'Live' : 'Sandbox',
    scopeSummary: key.scopes.length === 0
      ? 'No scopes — this key can read nothing'
      : `${key.scopes.length} ${key.scopes.length === 1 ? 'scope' : 'scopes'}`,
    state,
    stateLabel: state === 'revoked'
      ? 'Revoked'
      : state === 'unused' ? 'Never used' : 'Active',
    lastUsedLabel: key.lastUsedAt === null
      ? 'Never used'
      : `Last used ${relativeTime(key.lastUsedAt, now)}`,
  }
}

/**
 * The one moment a secret is on screen.
 *
 * The copy says plainly that it will not be shown again, because the failure it
 * prevents is a customer who assumes they can come back for it and finds they
 * have to rotate an endpoint in production instead.
 */
export interface RevealedSecret {
  readonly secret: string
  readonly title: string
  readonly warning: string
  readonly action: string
}

export function revealedApiKey(plaintext: string): RevealedSecret {
  return {
    secret: plaintext,
    title: 'Copy this key now',
    warning:
      'This is the only time it is shown. We store a hash, not the key, so we ' +
      'cannot show it to you again — if you lose it, create a new one and revoke this.',
    action: 'Copy key',
  }
}

export function revealedWebhookSecret(secret: string): RevealedSecret {
  return {
    secret,
    title: 'Copy this signing secret now',
    warning:
      'This is the only time it is shown. Store it in your secret manager and ' +
      'use it with the verification snippet in the reference. If you lose it, rotate ' +
      'the endpoint — rotation keeps the old secret working for 24 hours, so nothing drops.',
    action: 'Copy secret',
  }
}

/* ── Webhook endpoints ──────────────────────────────────────────────────── */

export interface WebhookEndpointInput {
  readonly id: string
  readonly url: string
  readonly description: string | null
  readonly eventTypes: readonly string[]
  readonly status: 'enabled' | 'disabled' | 'circuit_open' | 'deleted'
  readonly consecutiveFailures: number
  readonly circuitOpenedAt: Date | null
}

export interface WebhookEndpointCard {
  readonly id: string
  readonly url: string
  readonly description: string | null
  readonly subscriptionLabel: string
  readonly health: 'healthy' | 'failing' | 'circuit_open' | 'disabled' | 'deleted'
  readonly healthLabel: string
  /** Present only when there is genuinely something for the customer to do. */
  readonly attention: { readonly title: string; readonly detail: string; readonly action: string } | null
}

export function webhookEndpointCard(
  endpoint: WebhookEndpointInput, now: Date,
): WebhookEndpointCard {
  const subscriptionLabel = endpoint.eventTypes.length === 0
    ? 'All events'
    : `${endpoint.eventTypes.length} event ${endpoint.eventTypes.length === 1 ? 'type' : 'types'}`

  if (endpoint.status === 'circuit_open') {
    return {
      id: endpoint.id,
      url: endpoint.url,
      description: endpoint.description,
      subscriptionLabel,
      health: 'circuit_open',
      healthLabel: 'Paused after repeated failures',
      attention: {
        title: 'We stopped sending to this endpoint',
        detail:
          `${endpoint.consecutiveFailures} deliveries in a row failed` +
          `${endpoint.circuitOpenedAt ? `, and we paused it ${relativeTime(endpoint.circuitOpenedAt, now)}` : ''}. ` +
          'Every event is still in the event log and can be replayed once the endpoint is back.',
        action: 'Re-enable endpoint',
      },
    }
  }

  if (endpoint.status === 'disabled' || endpoint.status === 'deleted') {
    return {
      id: endpoint.id,
      url: endpoint.url,
      description: endpoint.description,
      subscriptionLabel,
      health: endpoint.status,
      // A removed endpoint is still listed, greyed, because its delivery history
      // is still readable and a customer looking for "what did you try to send
      // me" needs somewhere to click.
      healthLabel: endpoint.status === 'deleted' ? 'Removed — history kept' : 'Disabled',
      attention: null,
    }
  }

  if (endpoint.consecutiveFailures > 0) {
    return {
      id: endpoint.id,
      url: endpoint.url,
      description: endpoint.description,
      subscriptionLabel,
      health: 'failing',
      healthLabel: `${endpoint.consecutiveFailures} recent ${endpoint.consecutiveFailures === 1 ? 'failure' : 'failures'}`,
      attention: {
        title: 'Recent deliveries are failing',
        detail:
          'We are still retrying, and nothing has been dropped. Check the attempts ' +
          'in the event log to see what your endpoint returned.',
        action: 'Send a test event',
      },
    }
  }

  return {
    id: endpoint.id, url: endpoint.url, description: endpoint.description, subscriptionLabel,
    health: 'healthy', healthLabel: 'Healthy', attention: null,
  }
}

/* ── Request log ────────────────────────────────────────────────────────── */

export interface RequestLogInput {
  readonly requestId: string
  readonly method: string
  readonly path: string
  readonly status: number
  readonly errorCode: string | null
  readonly durationMs: number
  readonly idempotencyReplayed: boolean
  readonly createdAt: Date
}

export interface RequestLogRow {
  readonly requestId: string
  readonly summary: string
  readonly outcome: 'ok' | 'client_error' | 'server_error'
  readonly outcomeLabel: string
  readonly durationLabel: string
  readonly replayed: boolean
  readonly at: string
}

export function requestLogRow(entry: RequestLogInput): RequestLogRow {
  const outcome = entry.status < 400
    ? 'ok'
    : entry.status < 500 ? 'client_error' : 'server_error'

  return {
    requestId: entry.requestId,
    summary: `${entry.method} ${entry.path}`,
    outcome,
    // A status code and its own code, because "400" alone sends a developer to
    // the docs and `idempotency_key_reuse` sends them to the line that caused it.
    outcomeLabel: entry.errorCode === null
      ? String(entry.status)
      : `${entry.status} ${entry.errorCode}`,
    durationLabel: entry.durationMs < 1000
      ? `${entry.durationMs} ms`
      : `${(entry.durationMs / 1000).toFixed(1)} s`,
    replayed: entry.idempotencyReplayed,
    at: entry.createdAt.toISOString(),
  }
}

/* ── Event log ──────────────────────────────────────────────────────────── */

export interface AttemptInput {
  readonly attemptNumber: number
  readonly statusCode: number | null
  readonly error: string | null
  readonly responseBody: string | null
  readonly durationMs: number
  readonly attemptedAt: Date
}

export interface DeliveryInput {
  readonly id: string
  readonly endpointUrl: string
  readonly origin: 'outbox' | 'replay' | 'test'
  readonly status: 'pending' | 'delivering' | 'succeeded' | 'failed' | 'exhausted'
  readonly attemptCount: number
  readonly nextAttemptAt: Date
  readonly attempts: readonly AttemptInput[]
}

export interface DeliveryView {
  readonly id: string
  readonly endpointUrl: string
  readonly originLabel: string
  readonly stateLabel: string
  readonly canReplay: boolean
  readonly attempts: readonly {
    readonly label: string
    readonly outcome: string
    readonly detail: string
  }[]
}

export function deliveryView(delivery: DeliveryInput, now: Date): DeliveryView {
  const originLabel = delivery.origin === 'replay'
    ? 'Replayed'
    : delivery.origin === 'test' ? 'Test event' : 'Automatic'

  const stateLabel = ((): string => {
    switch (delivery.status) {
      case 'succeeded': return `Delivered after ${plural(delivery.attemptCount, 'attempt')}`
      case 'exhausted': return `Gave up after ${plural(delivery.attemptCount, 'attempt')}`
      case 'delivering': return 'Sending now'
      case 'failed': return `Retrying ${relativeTime(delivery.nextAttemptAt, now)}`
      case 'pending': return 'Queued'
    }
  })()

  return {
    id: delivery.id,
    endpointUrl: delivery.endpointUrl,
    originLabel,
    stateLabel,
    // Replay is for something that finished and did not work. Replaying while a
    // delivery is still being retried would send the same event twice for no
    // reason, and the customer would have to work out which one their system saw.
    canReplay: delivery.status === 'exhausted' || delivery.status === 'succeeded',
    attempts: delivery.attempts.map((a) => ({
      label: `Attempt ${a.attemptNumber} · ${a.attemptedAt.toISOString()}`,
      outcome: a.statusCode === null ? 'No response' : String(a.statusCode),
      // What the endpoint actually said, verbatim and truncated — not our
      // paraphrase of it. The customer is debugging their own server.
      detail: a.error ?? a.responseBody ?? '(empty response)',
    })),
  }
}

/**
 * One row of the event log.
 *
 * The delivery summary is the whole reason this screen exists: a customer
 * looking at an event wants to know whether their system was told, and the
 * honest answers are "yes", "not yet", "we gave up" and "nobody was
 * subscribed" — the last of which is a configuration mistake that otherwise
 * looks exactly like silence.
 */
export interface EventLogInput {
  readonly id: string
  readonly type: string
  readonly createdAt: Date
  readonly deliveries: readonly {
    readonly status: 'pending' | 'delivering' | 'succeeded' | 'failed' | 'exhausted'
  }[]
}

export interface EventLogRow {
  readonly id: string
  readonly type: string
  readonly at: string
  /** The state, named. The surface owns the colour, as everywhere else here. */
  readonly delivery: 'delivered' | 'sending' | 'gave_up' | 'unsubscribed'
  readonly deliveryLabel: string
  readonly canReplay: boolean
}

export function eventLogRow(event: EventLogInput): EventLogRow {
  const count = (...want: readonly string[]): number =>
    event.deliveries.filter((d) => want.includes(d.status)).length

  const exhausted = count('exhausted')
  const inFlight = count('pending', 'delivering', 'failed')
  const delivered = count('succeeded')

  const state = ((): Pick<EventLogRow, 'delivery' | 'deliveryLabel'> => {
    if (event.deliveries.length === 0) {
      // Not an error. An event with no subscriber is a normal thing that a
      // customer nonetheless needs told, because the alternative is them
      // waiting for a webhook that was never going to arrive.
      return { delivery: 'unsubscribed', deliveryLabel: 'No endpoint subscribed' }
    }
    if (exhausted > 0) {
      return { delivery: 'gave_up', deliveryLabel: `Gave up on ${plural(exhausted, 'endpoint')}` }
    }
    if (inFlight > 0) return { delivery: 'sending', deliveryLabel: 'Sending' }
    return { delivery: 'delivered', deliveryLabel: `Delivered to ${plural(delivered, 'endpoint')}` }
  })()

  return {
    id: event.id,
    type: event.type,
    at: event.createdAt.toISOString(),
    ...state,
    // Replay is for an event that finished trying. Offering it while a delivery
    // is still being retried invites a duplicate the customer has to reconcile.
    canReplay: event.deliveries.length > 0 && inFlight === 0,
  }
}

/* ── Shared ─────────────────────────────────────────────────────────────── */

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * A relative time, in the product's own register.
 *
 * Past and future both, because a delivery log shows "3 minutes ago" beside
 * "in 4 hours" and a formatter that only knew one direction would render the
 * other as nonsense.
 */
export function relativeTime(at: Date, now: Date): string {
  const deltaSeconds = Math.round((at.getTime() - now.getTime()) / 1000)
  const future = deltaSeconds > 0
  const seconds = Math.abs(deltaSeconds)

  const phrase = ((): string => {
    if (seconds < 60) return 'less than a minute'
    if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute')
    if (seconds < 86400) return plural(Math.round(seconds / 3600), 'hour')
    return plural(Math.round(seconds / 86400), 'day')
  })()

  return future ? `in ${phrase}` : `${phrase} ago`
}

/**
 * The Developers surface — `PRODUCT.md § 13`.
 *
 * The assertions worth making here are all about what the screen refuses to say:
 * a secret it cannot re-show, a log line with no request body in it, a replay
 * action that is not offered while a retry is still in flight.
 */
import { describe, expect, it } from 'vitest'
import {
  apiKeyRow, deliveryView, relativeTime, requestLogRow, revealedApiKey,
  revealedWebhookSecret, webhookEndpointCard,
} from './view-models.js'

const NOW = new Date('2026-09-05T12:00:00Z')

describe('API keys', () => {
  const base = {
    id: 'key_1', name: 'Production sync', prefix: 'sk_live_',
    environment: 'live' as const, scopes: ['settlement:read', 'settlement:create'],
    createdAt: new Date('2026-08-01T00:00:00Z'),
    lastUsedAt: new Date('2026-09-05T11:58:00Z'),
    revokedAt: null,
  }

  it('shows the prefix and a mask, never anything that could be a key', () => {
    const row = apiKeyRow(base, NOW)
    expect(row.masked).toBe('sk_live_••••')
    // Nothing on the row is long enough or random enough to be a secret.
    expect(JSON.stringify(row)).not.toMatch(/sk_live_[A-Za-z0-9_-]{4,}/)
  })

  it('distinguishes a key that was never used from one that is working', () => {
    expect(apiKeyRow({ ...base, lastUsedAt: null }, NOW).state).toBe('unused')
    expect(apiKeyRow(base, NOW).state).toBe('active')
    expect(apiKeyRow({ ...base, revokedAt: NOW }, NOW).state).toBe('revoked')
  })

  it('says plainly when a key holds no scopes at all', () => {
    // A key with no scopes is a mistake somebody will otherwise debug as an
    // outage. "0 scopes" would be technically true and useless.
    expect(apiKeyRow({ ...base, scopes: [] }, NOW).scopeSummary)
      .toBe('No scopes — this key can read nothing')
  })

  it('tells the customer the secret is not retrievable, and why', () => {
    // `sk_live_` plus 24 alphanumerics is Stripe's live-key format exactly, and
    // GitHub push protection blocks it on sight — correctly, since a scanner
    // cannot know the alphabet is not a key. The hyphen ends the run.
    const revealed = revealedApiKey('sk_live_EXAMPLE-NOT-A-REAL-KEY')
    expect(revealed.warning).toContain('only time it is shown')
    // The reason matters: a customer who thinks we are being awkward will ask
    // support for it; one who knows we store a hash will store it themselves.
    expect(revealed.warning).toContain('hash')
  })

  it('tells a customer rotating a webhook secret that nothing will drop', () => {
    expect(revealedWebhookSecret('whsec_x').warning).toContain('24 hours')
  })
})

describe('webhook endpoints', () => {
  const base = {
    id: 'whe_1', url: 'https://example.test/hooks', description: null,
    eventTypes: [] as string[], status: 'enabled' as const,
    consecutiveFailures: 0, circuitOpenedAt: null,
  }

  it('says "All events" rather than an empty list', () => {
    expect(webhookEndpointCard(base, NOW).subscriptionLabel).toBe('All events')
    expect(webhookEndpointCard({ ...base, eventTypes: ['settlement.settled'] }, NOW)
      .subscriptionLabel).toBe('1 event type')
  })

  it('offers no attention card when there is nothing to attend to', () => {
    expect(webhookEndpointCard(base, NOW).attention).toBeNull()
    expect(webhookEndpointCard({ ...base, status: 'disabled' }, NOW).attention).toBeNull()
  })

  it('says nothing has been dropped while retries are still running', () => {
    const card = webhookEndpointCard({ ...base, consecutiveFailures: 3 }, NOW)
    expect(card.health).toBe('failing')
    expect(card.attention?.detail).toContain('nothing has been dropped')
    expect(card.attention?.action).toBe('Send a test event')
  })

  it('explains a broken circuit with a named action, not a status word', () => {
    const card = webhookEndpointCard({
      ...base, status: 'circuit_open', consecutiveFailures: 20,
      circuitOpenedAt: new Date('2026-09-05T09:00:00Z'),
    }, NOW)
    expect(card.health).toBe('circuit_open')
    expect(card.attention).toMatchObject({ action: 'Re-enable endpoint' })
    expect(card.attention?.detail).toContain('3 hours ago')
    // The customer's first question is "what did I lose". Answer it before
    // they ask.
    expect(card.attention?.detail).toContain('still in the event log')
  })
})

describe('the request log', () => {
  const base = {
    requestId: 'req_1', method: 'POST', path: '/v1/settlements', status: 201,
    errorCode: null, durationMs: 142, idempotencyReplayed: false,
    createdAt: new Date('2026-09-05T11:00:00Z'),
  }

  it('carries no request body and no response body', () => {
    // SECURITY.md § 8 does not stop applying because the log has a UI: a
    // settlement request body carries beneficiary details.
    const row = requestLogRow(base)
    expect(Object.keys(row)).toEqual([
      'requestId', 'summary', 'outcome', 'outcomeLabel', 'durationLabel', 'replayed', 'at',
    ])
  })

  it('shows the error code beside the status, because the number alone is a lookup', () => {
    expect(requestLogRow({ ...base, status: 409, errorCode: 'idempotency_key_reuse' }).outcomeLabel)
      .toBe('409 idempotency_key_reuse')
    expect(requestLogRow(base).outcomeLabel).toBe('201')
  })

  it('separates our fault from theirs', () => {
    expect(requestLogRow(base).outcome).toBe('ok')
    expect(requestLogRow({ ...base, status: 404 }).outcome).toBe('client_error')
    expect(requestLogRow({ ...base, status: 500 }).outcome).toBe('server_error')
  })

  it('marks a replayed request, so a developer is not hunting a duplicate', () => {
    expect(requestLogRow({ ...base, idempotencyReplayed: true }).replayed).toBe(true)
  })
})

describe('the event log', () => {
  const attempt = (n: number, statusCode: number | null, body: string | null, error: string | null) => ({
    attemptNumber: n, statusCode, responseBody: body, error,
    durationMs: 120, attemptedAt: new Date(`2026-09-05T10:0${n}:00Z`),
  })

  const base = {
    id: 'whd_1', endpointUrl: 'https://example.test/hooks', origin: 'outbox' as const,
    status: 'failed' as const, attemptCount: 2,
    nextAttemptAt: new Date('2026-09-05T12:05:00Z'),
    attempts: [
      attempt(1, 503, 'upstream unavailable', null),
      attempt(2, null, null, 'ETIMEDOUT'),
    ],
  }

  it('shows every attempt, with what the endpoint actually said', () => {
    const view = deliveryView(base, NOW)
    expect(view.attempts).toHaveLength(2)
    expect(view.attempts[0]!.detail).toBe('upstream unavailable')
    expect(view.attempts[1]!.outcome).toBe('No response')
    expect(view.attempts[1]!.detail).toBe('ETIMEDOUT')
  })

  it('says when the next attempt is, rather than only that it failed', () => {
    expect(deliveryView(base, NOW).stateLabel).toBe('Retrying in 5 minutes')
  })

  it('offers replay only once a delivery has stopped moving', () => {
    // Replaying mid-retry sends the same event twice for no reason, and the
    // customer then has to work out which one their system saw.
    expect(deliveryView(base, NOW).canReplay).toBe(false)
    expect(deliveryView({ ...base, status: 'pending' }, NOW).canReplay).toBe(false)
    expect(deliveryView({ ...base, status: 'exhausted' }, NOW).canReplay).toBe(true)
    expect(deliveryView({ ...base, status: 'succeeded' }, NOW).canReplay).toBe(true)
  })

  it('names a replay and a test event as what they are', () => {
    expect(deliveryView({ ...base, origin: 'replay' }, NOW).originLabel).toBe('Replayed')
    expect(deliveryView({ ...base, origin: 'test' }, NOW).originLabel).toBe('Test event')
    expect(deliveryView(base, NOW).originLabel).toBe('Automatic')
  })
})

describe('relative time', () => {
  it('reads correctly in both directions', () => {
    // A delivery log shows "3 minutes ago" beside "in 4 hours"; a formatter that
    // knew only one direction would render the other as nonsense.
    expect(relativeTime(new Date('2026-09-05T11:57:00Z'), NOW)).toBe('3 minutes ago')
    expect(relativeTime(new Date('2026-09-05T16:00:00Z'), NOW)).toBe('in 4 hours')
    expect(relativeTime(new Date('2026-09-05T11:59:40Z'), NOW)).toBe('less than a minute ago')
    expect(relativeTime(new Date('2026-09-02T12:00:00Z'), NOW)).toBe('3 days ago')
  })

  it('says "1 minute", never "1 minutes"', () => {
    expect(relativeTime(new Date('2026-09-05T11:59:00Z'), NOW)).toBe('1 minute ago')
  })
})

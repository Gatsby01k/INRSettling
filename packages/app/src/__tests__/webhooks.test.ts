/**
 * Stage 8 exit criterion 4 — *"Webhook delivery survives an endpoint that is
 * down for an hour and shows every attempt in the event log."*
 *
 * The hour passes in milliseconds, because the schedule is pure and the clock is
 * injected. That is the point of `webhooks/delivery.ts` having no clock and no
 * network: a delivery policy you can only test by waiting is a delivery policy
 * nobody tests.
 *
 * Also here: the allow-list that keeps the internal state machine off the
 * integration surface, the circuit breaker, dual-secret rotation, and replay.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { runMigrations } from 'graphile-worker'
import {
  createTestDatabase, installJobQueue, seedWorkspace, workerConnectionString, type Harness,
} from '@inrsettle/testing'
import { createClient, withTenant, type Db } from '@inrsettle/db'
import {
  CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES, MAX_ATTEMPTS, RETRY_SCHEDULE_SECONDS,
  scheduleHorizonSeconds, verifySignature, type TenantScope,
} from '@inrsettle/domain'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { eventSink } from '../events.js'
import {
  createWebhookEndpoint, liveSecretsFor, rotateWebhookSecret,
} from '../webhook.service.js'
import {
  deliveriesForEvent, drainOutbox, pendingOutboxScopes, replayEvent, runWebhookDelivery,
  sendTestEvent, type DeliveryDeps, type WebhookTransport,
} from '../webhook-delivery.service.js'

let h: Harness
/**
 * A second pool, connected as `inrsettle_worker`.
 *
 * `pending_outbox_scopes` is a worker-only capability (migration `0015`): the
 * application role cannot execute it, so the cross-tenant discovery step needs
 * the queue role's own connection. The scoped drain that follows still runs on
 * `h.db` under ordinary RLS — the privilege buys the worker one question, not a
 * way around tenant isolation.
 */
let workerDb: Db
let closeWorkerDb: () => Promise<void>
const WS = 'ws_hook'
const scope: TenantScope = { workspaceId: WS, environment: 'sandbox' }
const DB = `inrsettle_test_webhooks_${process.pid}`
const actor = { type: 'api_key', id: 'key_test' } as const
const capabilities = new Set(['apikey:manage', 'webhook:manage'] as const)

const cipher = createFieldCipher({ activeKeyId: 'w1', keks: { w1: randomBytes(32) } })

const live = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  withTenant(h.db, scope, fn as never)

/** A transport whose behaviour a test dictates, attempt by attempt. */
class ScriptedTransport implements WebhookTransport {
  readonly calls: { url: string; body: string; headers: Record<string, string> }[] = []
  constructor(private script: (n: number) => { statusCode: number; body: string } | { error: string }) {}

  async post(args: {
    url: string; body: string; headers: Readonly<Record<string, string>>; timeoutMs: number
  }) {
    this.calls.push({ url: args.url, body: args.body, headers: { ...args.headers } })
    return this.script(this.calls.length)
  }
}

/** A controllable clock, so "down for an hour" costs no time. */
function clockFrom(start: Date) {
  let now = new Date(start)
  return {
    now: () => new Date(now),
    advanceSeconds: (s: number) => { now = new Date(now.getTime() + s * 1000) },
  }
}

function depsWith(transport: WebhookTransport, clock: { now: () => Date }): DeliveryDeps {
  return { transport, cipher, now: clock.now, random: () => 0.5 }
}

async function emitSettlementSettled(subjectId: string): Promise<string> {
  return live(async (tx) => {
    await eventSink(tx as never).event(scope, {
      type: 'settlement.settled',
      subjectType: 'settlement',
      subjectId,
      actor,
      payload: { id: subjectId, status: 'settled' },
      deliver: true,
    })
    const rows = (await (tx as never as { execute: (q: unknown) => Promise<unknown> }).execute(sql`
      SELECT id FROM events WHERE subject_id = ${subjectId} ORDER BY created_at DESC LIMIT 1`))
    return (rows as unknown as { id: string }[])[0]!.id
  })
}

/** The one delivery for an event, which every test here creates exactly one of. */
async function onlyDeliveryFor(eventId: string): Promise<string> {
  const deliveries = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
  expect(deliveries).toHaveLength(1)
  return deliveries[0]!.id
}

async function makeEndpoint(url: string, eventTypes?: readonly string[]) {
  return live((tx) => createWebhookEndpoint(tx as never, scope, cipher, {
    url,
    ...(eventTypes === undefined ? {} : { eventTypes }),
    actor, actorCapabilities: capabilities,
  }))
}

beforeAll(async () => {
  h = await createTestDatabase('webhooks')
  await installJobQueue(h.admin, runMigrations, DB)
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin'],
  })
  const worker = createClient(workerConnectionString(DB), { max: 2 })
  workerDb = worker.db
  closeWorkerDb = worker.close
})
afterAll(async () => {
  await closeWorkerDb()
  await h.close()
})

beforeEach(async () => {
  await h.admin`DELETE FROM webhook_attempts`
  await h.admin`DELETE FROM webhook_deliveries`
  await h.admin`DELETE FROM webhook_endpoints`
  await h.admin`DELETE FROM outbox`
  await h.admin`DELETE FROM events`
})

/* ── The exit criterion ─────────────────────────────────────────────────── */

describe('an endpoint that is down for an hour', () => {
  it('recovers, and every attempt is in the log', async () => {
    await makeEndpoint('https://example.test/down')
    const eventId = await emitSettlementSettled('stl_down')

    const clock = clockFrom(new Date('2026-09-05T09:00:00Z'))
    // Down for an hour: 503 until the clock has advanced past 3600s, then 200.
    const start = clock.now().getTime()
    const transport = new ScriptedTransport(() =>
      clock.now().getTime() - start < 3600_000
        ? { statusCode: 503, body: 'upstream unavailable' }
        : { statusCode: 200, body: 'ok' })

    await drainOutbox(h.db, scope)
    const deps = depsWith(transport, clock)

    const deliveryId = await onlyDeliveryFor(eventId)

    let attempts = 0
    let delivered = false
    while (!delivered && attempts < MAX_ATTEMPTS) {
      const result = await runWebhookDelivery(h.db, scope, deps, { deliveryId })
      attempts += 1
      if (result.kind === 'delivered') { delivered = true; break }
      expect(result.kind).toBe('retrying')
      if (result.kind !== 'retrying') break
      // Jump the clock to the moment the schedule says to try again.
      clock.advanceSeconds(Math.ceil((result.nextAttemptAt.getTime() - clock.now().getTime()) / 1000))
    }

    expect(delivered).toBe(true)

    const [record] = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
    expect(record!.status).toBe('succeeded')
    // Every attempt, not only the one that worked.
    expect(record!.attempts).toHaveLength(attempts)
    expect(record!.attempts.map((a) => a.attemptNumber))
      .toEqual(Array.from({ length: attempts }, (_, i) => i + 1))
    // And each failure kept what the endpoint actually said.
    for (const a of record!.attempts.slice(0, -1)) {
      expect(a.statusCode).toBe(503)
      expect(a.responseBody).toBe('upstream unavailable')
    }
    expect(record!.attempts.at(-1)!.statusCode).toBe(200)
  })

  it('has a schedule that covers about 24 hours', () => {
    // § 10.3: "retried with exponential backoff and jitter for about 24 hours".
    const hours = scheduleHorizonSeconds() / 3600
    expect(hours).toBeGreaterThan(23)
    expect(hours).toBeLessThan(25)
    // Strictly increasing: an endpoint down for six hours is not fixed by
    // asking again in thirty seconds.
    for (let i = 1; i < RETRY_SCHEDULE_SECONDS.length; i += 1) {
      expect(RETRY_SCHEDULE_SECONDS[i]!).toBeGreaterThanOrEqual(RETRY_SCHEDULE_SECONDS[i - 1]!)
    }
  })
})

/* ── Signing ────────────────────────────────────────────────────────────── */

describe('signing', () => {
  it('signs "{t}.{raw_body}" with the endpoint secret', async () => {
    const endpoint = await makeEndpoint('https://example.test/signed')
    const eventId = await emitSettlementSettled('stl_sign')
    const clock = clockFrom(new Date('2026-09-05T10:00:00Z'))
    const transport = new ScriptedTransport(() => ({ statusCode: 200, body: 'ok' }))

    await drainOutbox(h.db, scope)
    const deliveryId = await onlyDeliveryFor(eventId)
    await runWebhookDelivery(h.db, scope, depsWith(transport, clock), { deliveryId })

    const call = transport.calls[0]!
    const verdict = verifySignature({
      header: call.headers['INRSettle-Signature']!,
      rawBody: call.body,
      secrets: [endpoint.secret],
      nowSeconds: Math.floor(clock.now().getTime() / 1000),
    })
    expect(verdict.ok).toBe(true)
  })

  it('signs with both secrets during a rotation overlap, so nothing is dropped', async () => {
    const endpoint = await makeEndpoint('https://example.test/rotate')
    const now = new Date('2026-09-05T11:00:00Z')
    const rotated = await live((tx) => rotateWebhookSecret(tx as never, scope, cipher, {
      endpointId: endpoint.id, now, actor, actorCapabilities: capabilities,
    }))
    expect(rotated).not.toBeNull()

    const secrets = await live((tx) => liveSecretsFor(tx as never, scope, cipher, endpoint.id, now))
    expect(secrets).toHaveLength(2)
    expect(secrets).toContain(rotated!.secret)
    expect(secrets).toContain(endpoint.secret)

    // …and only one once the overlap has passed.
    const after = new Date(rotated!.previousExpiresAt.getTime() + 1000)
    const later = await live((tx) => liveSecretsFor(tx as never, scope, cipher, endpoint.id, after))
    expect(later).toEqual([rotated!.secret])
  })

  it('stores the secret encrypted, never in clear', async () => {
    const endpoint = await makeEndpoint('https://example.test/secret')
    const rows = await h.admin<{ secret_ciphertext: string }[]>`
      SELECT secret_ciphertext FROM webhook_endpoints WHERE id = ${endpoint.id}`
    expect(rows[0]!.secret_ciphertext).not.toContain(endpoint.secret)
    expect(rows[0]!.secret_ciphertext.startsWith('v1.')).toBe(true)
  })
})

/* ── The allow-list ─────────────────────────────────────────────────────── */

describe('the internal state machine is not the integration surface', () => {
  it('never delivers an internal event, even to an endpoint subscribed to everything', async () => {
    await makeEndpoint('https://example.test/all')
    await live(async (tx) => {
      await eventSink(tx as never).event(scope, {
        type: 'liquidity.drawdown_confirmed',
        subjectType: 'drawdown', subjectId: 'drw_1', actor,
        payload: { amount: '1' }, deliver: true,
      })
    })

    const result = await drainOutbox(h.db, scope)
    expect(result.claimed).toBe(1)
    expect(result.deliveriesCreated).toBe(0)
    expect(result.undeliverable).toBe(1)
  })

  it('delivers only the types an endpoint subscribed to', async () => {
    await makeEndpoint('https://example.test/settled-only', ['settlement.settled'])
    await live(async (tx) => {
      const sink = eventSink(tx as never)
      await sink.event(scope, {
        type: 'settlement.created', subjectType: 'settlement', subjectId: 'stl_a',
        actor, payload: {}, deliver: true,
      })
    })
    await emitSettlementSettled('stl_b')

    const result = await drainOutbox(h.db, scope)
    expect(result.claimed).toBe(2)
    expect(result.deliveriesCreated).toBe(1)
  })

  it('refuses a subscription to an event type customers cannot see', async () => {
    await expect(makeEndpoint('https://example.test/nope', ['liquidity.drawdown_confirmed']))
      .rejects.toThrow(/not an event type you can subscribe to/)
  })

  it('refuses a plaintext endpoint URL', async () => {
    await expect(makeEndpoint('http://example.test/insecure')).rejects.toThrow(/https/)
  })
})

/* ── The drain ─────────────────────────────────────────────────────────── */

describe('the outbox drain', () => {
  it('finds the scopes with pending work without seeing the work', async () => {
    await makeEndpoint('https://example.test/scopes')
    await emitSettlementSettled('stl_scope')
    const scopes = await pendingOutboxScopes(workerDb)
    expect(scopes).toContainEqual({ workspaceId: WS, environment: 'sandbox' })
  })

  it('is a worker capability the application role does not have', async () => {
    await makeEndpoint('https://example.test/denied')
    await emitSettlementSettled('stl_denied')

    // The function sees past RLS by design — that is what makes it useful to a
    // worker and dangerous everywhere else. An `api` process holding EXECUTE
    // could enumerate every workspace in the deployment, so the grant is the
    // boundary and this is the test of it.
    await expect(pendingOutboxScopes(h.db)).rejects.toThrow(/permission denied/i)
  })

  it('leaves the drain itself under ordinary RLS', async () => {
    await makeEndpoint('https://example.test/rls')
    await emitSettlementSettled('stl_rls')

    // Discovery is privileged; the work is not. The drain runs on the
    // application pool, inside `withTenant`, and a scope it was not given
    // yields nothing rather than everything.
    const other: TenantScope = { workspaceId: WS, environment: 'live' }
    expect((await drainOutbox(h.db, other)).claimed).toBe(0)
    expect((await drainOutbox(h.db, scope)).deliveriesCreated).toBe(1)
  })

  it('is safe to run twice', async () => {
    await makeEndpoint('https://example.test/twice')
    await emitSettlementSettled('stl_twice')

    const first = await drainOutbox(h.db, scope)
    expect(first.deliveriesCreated).toBe(1)
    // The outbox row is marked delivered, so a second drain claims nothing —
    // and even if it did, the (endpoint, event) unique index makes the fan-out
    // a no-op rather than a second delivery.
    const second = await drainOutbox(h.db, scope)
    expect(second.claimed).toBe(0)
    expect(second.deliveriesCreated).toBe(0)
  })

  it('gives every endpoint its own delivery, so one being down does not hold up another', async () => {
    await makeEndpoint('https://example.test/one')
    await makeEndpoint('https://example.test/two')
    const eventId = await emitSettlementSettled('stl_fanout')

    await drainOutbox(h.db, scope)
    const deliveries = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
    expect(deliveries).toHaveLength(2)
    expect(new Set(deliveries.map((d) => d.endpointId)).size).toBe(2)
  })
})

/* ── Outcomes ──────────────────────────────────────────────────────────── */

describe('what one response means', () => {
  it('does not retry a 4xx that will never become a 2xx', async () => {
    await makeEndpoint('https://example.test/rejects')
    const eventId = await emitSettlementSettled('stl_400')
    await drainOutbox(h.db, scope)
    const deliveryId = await onlyDeliveryFor(eventId)

    const clock = clockFrom(new Date('2026-09-05T12:00:00Z'))
    const transport = new ScriptedTransport(() => ({ statusCode: 422, body: 'cannot process' }))
    const result = await runWebhookDelivery(h.db, scope, depsWith(transport, clock), { deliveryId })

    expect(result.kind).toBe('gave_up')
    const [record] = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
    expect(record!.status).toBe('exhausted')
    expect(record!.attempts).toHaveLength(1)
  })

  it('does retry a 429, because that is the endpoint asking for less traffic', async () => {
    await makeEndpoint('https://example.test/429')
    const eventId = await emitSettlementSettled('stl_429')
    await drainOutbox(h.db, scope)
    const deliveryId = await onlyDeliveryFor(eventId)

    const clock = clockFrom(new Date('2026-09-05T12:00:00Z'))
    const transport = new ScriptedTransport(() => ({ statusCode: 429, body: 'slow down' }))
    const result = await runWebhookDelivery(h.db, scope, depsWith(transport, clock), { deliveryId })
    expect(result.kind).toBe('retrying')
  })

  it('records a transport failure as an attempt with no status code', async () => {
    await makeEndpoint('https://example.test/timeout')
    const eventId = await emitSettlementSettled('stl_timeout')
    await drainOutbox(h.db, scope)
    const deliveryId = await onlyDeliveryFor(eventId)

    const clock = clockFrom(new Date('2026-09-05T12:00:00Z'))
    const transport = new ScriptedTransport(() => ({ error: 'ETIMEDOUT after 10000ms' }))
    await runWebhookDelivery(h.db, scope, depsWith(transport, clock), { deliveryId })

    const [record] = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
    expect(record!.attempts[0]).toMatchObject({ statusCode: null, error: 'ETIMEDOUT after 10000ms' })
  })
})

/* ── The circuit ───────────────────────────────────────────────────────── */

describe('a consistently failing endpoint', () => {
  it('is circuit-broken, and the workspace is told in its own event stream', async () => {
    const endpoint = await makeEndpoint('https://example.test/broken')
    const clock = clockFrom(new Date('2026-09-05T13:00:00Z'))
    const transport = new ScriptedTransport(() => ({ statusCode: 500, body: 'boom' }))
    const deps = depsWith(transport, clock)

    for (let i = 0; i < CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES; i += 1) {
      const eventId = await emitSettlementSettled(`stl_broken_${i}`)
      await drainOutbox(h.db, scope)
      const deliveries = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
      if (deliveries.length === 0) break // circuit already open: no new delivery
      await runWebhookDelivery(h.db, scope, deps, { deliveryId: deliveries[0]!.id })
    }

    const rows = await h.admin<{ status: string; consecutive_failures: number }[]>`
      SELECT status, consecutive_failures FROM webhook_endpoints WHERE id = ${endpoint.id}`
    expect(rows[0]!.status).toBe('circuit_open')

    // Announced in the event log, and deliberately not delivered — announcing a
    // broken endpoint through the endpoint that is broken would be circular.
    const events = await h.admin<{ id: string }[]>`
      SELECT e.id FROM events e
       LEFT JOIN outbox o ON o.event_id = e.id
       WHERE e.type = 'webhook_endpoint.circuit_opened' AND o.id IS NULL`
    expect(events.length).toBeGreaterThan(0)
  })
})

/* ── Replay and test ───────────────────────────────────────────────────── */

describe('replay and test', () => {
  it('replays as a new chain, leaving the original attempts intact', async () => {
    const endpoint = await makeEndpoint('https://example.test/replay')
    const eventId = await emitSettlementSettled('stl_replay')
    await drainOutbox(h.db, scope)
    const original = (await live((tx) => deliveriesForEvent(tx as never, scope, eventId)))[0]!

    const clock = clockFrom(new Date('2026-09-05T14:00:00Z'))
    await runWebhookDelivery(h.db, scope, depsWith(
      new ScriptedTransport(() => ({ statusCode: 500, body: 'boom' })), clock,
    ), { deliveryId: original.id })

    const replayed = await live((tx) => replayEvent(tx as never, scope, {
      eventId, endpointId: endpoint.id,
    }))
    expect(replayed).not.toBeNull()

    const all = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
    expect(all).toHaveLength(2)
    const first = all.find((d) => d.id === original.id)!
    // The first chain's history is untouched: "why did it fail last time" is
    // still answerable after a replay.
    expect(first.attempts).toHaveLength(1)
    expect(first.attempts[0]!.statusCode).toBe(500)
    expect(all.find((d) => d.origin === 'replay')).toBeDefined()
  })

  it('sends a test event that is signed like a real one and is not a customer event', async () => {
    const endpoint = await makeEndpoint('https://example.test/test-event')
    const sent = await live((tx) => sendTestEvent(tx as never, scope, {
      endpointId: endpoint.id, actorId: 'key_test',
    }))
    expect(sent).not.toBeNull()

    const clock = clockFrom(new Date('2026-09-05T15:00:00Z'))
    const transport = new ScriptedTransport(() => ({ statusCode: 200, body: 'ok' }))
    const result = await runWebhookDelivery(h.db, scope, depsWith(transport, clock), {
      deliveryId: sent!.deliveryId,
    })
    expect(result.kind).toBe('delivered')

    const body = JSON.parse(transport.calls[0]!.body) as { type: string }
    expect(body.type).toBe('endpoint.test')
    // Signed exactly like a real delivery, so it exercises the customer's real
    // verification code rather than a special case of it.
    expect(verifySignature({
      header: transport.calls[0]!.headers['INRSettle-Signature']!,
      rawBody: transport.calls[0]!.body,
      secrets: [endpoint.secret],
      nowSeconds: Math.floor(clock.now().getTime() / 1000),
    }).ok).toBe(true)
  })
})

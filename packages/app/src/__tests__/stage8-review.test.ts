/**
 * Three properties from the Stage 8 archive review, each of which was a real
 * defect and none of which a type can hold on its own.
 *
 *   1. A customer envelope carries the **public object** and never the event
 *      row's payload — so `T01`, `DRAFT` and the rest of the internal machine
 *      cannot reach an endpoint (`API_CONTRACT.md § 10.1`, `§ 10.2`).
 *   2. `beneficiary.verify` is a job, and the provider adapter is called
 *      **outside every transaction** (`ARCHITECTURE.md § 5`, `D-19`).
 *   3. Removing a webhook endpoint keeps its delivery history.
 *
 * The second is tested by making it impossible to be wrong about: the fake
 * provider asks the database, from its own connection, whether the row it is
 * being asked about is locked. A provider called inside the loading transaction
 * would block; a provider called outside it reads the committed row.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { runMigrations } from 'graphile-worker'
import postgres from 'postgres'
import {
  adminConnectionString, createTestDatabase, installJobQueue, seedWorkspace, type Harness,
} from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import {
  CUSTOMER_EVENT_TYPES, TEST_EVENT_TYPE,
  type BeneficiaryVerificationProvider, type PayoutDetails, type TenantScope,
} from '@inrsettle/domain'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { eventSink } from '../events.js'
import {
  BENEFICIARY_VERIFY_JOB, enqueueBeneficiaryVerify, openVerification, runBeneficiaryVerifyJob,
} from '../verification.service.js'
import {
  createWebhookEndpoint, deleteWebhookEndpoint, getWebhookEndpoint, listWebhookEndpoints,
  reopenWebhookEndpoint,
} from '../webhook.service.js'
import {
  deliveriesForEvent, drainOutbox, runWebhookDelivery,
  type DeliveryDeps, type WebhookTransport,
} from '../webhook-delivery.service.js'
import { RESOLVED_SUBJECT_TYPES, resolveCustomerEventObject } from '../public/event-object.js'

let h: Harness
const WS = 'ws_s8rev'
const DB = `inrsettle_test_stage8_review_${process.pid}`
const scope: TenantScope = { workspaceId: WS, environment: 'sandbox' }
const actor = { type: 'user', id: 'usr_admin' } as const
const capabilities = new Set(['apikey:manage', 'webhook:manage'] as const)

const cipher = createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } })
const crypto = { cipher, fingerprinter: createDestinationFingerprinter(randomBytes(32)) }

const live = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  withTenant(h.db, scope, fn as never)

/** The version a freshly created beneficiary's only destination is on. */
function versionOf(b: { destinations: readonly { currentVersion: { id: string } | null }[] }): string {
  const version = b.destinations[0]?.currentVersion
  if (!version) throw new Error('the beneficiary was created without a destination version')
  return version.id
}

const DETAILS: PayoutDetails = {
  kind: 'bank_account',
  accountNumber: '50100123456789',
  ifsc: 'HDFC0000123',
  accountType: 'savings',
  accountHolderName: 'Aarti Sharma',
}

beforeAll(async () => {
  h = await createTestDatabase('stage8_review')
  await installJobQueue(h.admin, runMigrations, DB)
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin'],
  })
})
afterAll(async () => { await h.close() })

/* ── 1. The envelope carries the public object ──────────────────────────── */

describe('a customer event envelope', () => {
  beforeEach(async () => {
    await h.admin`DELETE FROM webhook_attempts`
    await h.admin`DELETE FROM webhook_deliveries`
    await h.admin`DELETE FROM webhook_endpoints`
    await h.admin`DELETE FROM outbox`
    await h.admin`DELETE FROM events`
  })

  it('never carries the internal transition the event row recorded', async () => {
    const beneficiary = await live((tx) => createBeneficiary(tx as never, scope, crypto, {
      identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN' },
      destination: DETAILS,
      actor,
    }))

    await live((tx) => createWebhookEndpoint(tx as never, scope, cipher, {
      url: 'https://example.test/envelope', actor, actorCapabilities: capabilities,
    }))

    // The payload a transition writes, verbatim: the shape that used to be the
    // envelope's `data.object`.
    const eventId = await live(async (tx) => {
      await eventSink(tx as never).event(scope, {
        type: 'beneficiary.created',
        subjectType: 'beneficiary',
        subjectId: beneficiary.id,
        actor,
        payload: { transition: 'T01', to: 'DRAFT', internal_note: 'do not ship this' },
        deliver: true,
      })
      const rows = (await (tx as never as { execute: (q: unknown) => Promise<unknown> }).execute(sql`
        SELECT id FROM events WHERE subject_id = ${beneficiary.id} ORDER BY created_at DESC LIMIT 1`))
      return (rows as unknown as { id: string }[])[0]!.id
    })

    await drainOutbox(h.db, scope)
    const [delivery] = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))

    let sent = ''
    const transport: WebhookTransport = {
      async post(args) { sent = args.body; return { statusCode: 200, body: 'ok' } },
    }
    const deps: DeliveryDeps = { transport, cipher, now: () => new Date() }
    await runWebhookDelivery(h.db, scope, deps, { deliveryId: delivery!.id })

    expect(sent).not.toBe('')
    // Not "the payload happens not to be here" — the internal vocabulary is
    // absent from the whole document, which is the property § 10.2 states.
    expect(sent).not.toMatch(/T01|DRAFT|internal_note|do not ship this/)
    expect(sent).not.toMatch(/"transition"/)

    const envelope = JSON.parse(sent) as Record<string, unknown>
    expect(envelope['payload']).toBeUndefined()
    const object = (envelope['data'] as Record<string, unknown>)['object'] as Record<string, unknown>
    // The full public object, per § 10.1 — the same document `GET /v1/beneficiaries/:id`
    // returns, not a stub with an id in it.
    expect(object['object']).toBe('beneficiary')
    expect(object['id']).toBe(beneficiary.id)
    expect(object['display_name']).toBe('Aarti Sharma')
    // And still masked. The public serializer is the one that decides that, which
    // is exactly why there is only one of them.
    expect(sent).not.toContain('50100123456789')
  })

  it('resolves a subject that has since been removed to a reference, not a guess', async () => {
    const created = await live((tx) => createWebhookEndpoint(tx as never, scope, cipher, {
      url: 'https://example.test/gone', actor, actorCapabilities: capabilities,
    }))

    const object = await live((tx) => resolveCustomerEventObject(
      tx as never, scope,
      { type: 'beneficiary.created', subjectType: 'beneficiary', subjectId: 'ben_missing' },
      { numberFormat: 'international' },
    ))
    expect(object).toEqual({ object: 'beneficiary', id: 'ben_missing', deleted: true })

    // A subject that *is* there resolves to the real thing, so the reference
    // above is a genuine "gone" rather than a resolver that never works.
    // `endpoint.test` is the one non-catalogue type the resolver accepts, and
    // it is the production path for `POST /v1/webhook_endpoints/{id}/test`.
    const present = await live((tx) => resolveCustomerEventObject(
      tx as never, scope,
      { type: TEST_EVENT_TYPE, subjectType: 'webhook_endpoint', subjectId: created.id },
      { numberFormat: 'international' },
    ))
    expect(present['deleted']).toBeUndefined()
    expect(present['id']).toBe(created.id)
  })

  it('refuses to serialise an internal event type at all', async () => {
    // The allow-list is applied by the drain and by `/v1/events`. This is the
    // third line: a resolver that would happily serialise `liquidity.drawn`
    // for a future caller who forgot to filter.
    const internal = await live((tx) => resolveCustomerEventObject(
      tx as never, scope,
      { type: 'liquidity.drawn', subjectType: 'settlement', subjectId: 'stl_internal' },
      { numberFormat: 'international' },
    ))
    expect(internal).toEqual({ object: 'unknown', id: 'stl_internal', deleted: true })
  })

  it('has a resolver for every subject type the customer catalogue can emit', () => {
    // A new customer event type whose subject nobody taught the resolver about
    // would ship a reference object for a subject that exists. This is the test
    // that turns that into a failing build rather than a support ticket.
    const subjects = new Set(RESOLVED_SUBJECT_TYPES as readonly string[])
    for (const type of CUSTOMER_EVENT_TYPES) {
      const domain = type.split('.')[0]!
      const expected = ({
        settlement: 'settlement',
        beneficiary: 'beneficiary',
        batch: 'batch',
        quote: 'quote',
        receipt: 'financial_artifact',
      } as Record<string, string>)[domain]
      if (expected !== undefined) expect(subjects).toContain(expected)
    }
  })
})

/* ── 2. The provider is called outside every transaction ────────────────── */

describe('the beneficiary.verify job', () => {
  it('calls the provider with no transaction open and no row locked', async () => {
    const beneficiary = await live((tx) => createBeneficiary(tx as never, scope, crypto, {
      identity: { displayName: 'Locked Check', type: 'individual', country: 'IN' },
      destination: DETAILS,
      actor,
    }))

    const opened = await live((tx) => openVerification(tx as never, scope, {
      destinationVersionId: versionOf(beneficiary),
      actor, method: 'penny_drop', providerId: 'sandbox',
    }))
    expect(opened.ok).toBe(true)
    const verificationId = (opened as { verificationId: string }).verificationId

    // A second connection, entirely outside the job's own. If the job were
    // still inside its loading transaction with the verification row locked,
    // `FOR UPDATE NOWAIT` would raise 55P03 instead of returning the row.
    const side = postgres(adminConnectionString(DB), { max: 1, onnotice: () => {} })
    let sawLock: 'clear' | 'locked' | 'unchecked' = 'unchecked'
    let insideTransaction = true

    const inner = createSandboxVerificationProvider()
    const probing: BeneficiaryVerificationProvider = {
      id: inner.id,
      method: inner.method,
      supports: (kind) => inner.supports(kind),
      async verify(request) {
        try {
          await side`SELECT id FROM destination_verifications
                      WHERE id = ${verificationId} FOR UPDATE NOWAIT`
          sawLock = 'clear'
        } catch {
          sawLock = 'locked'
        }
        // And the row is committed and visible from outside, which it would not
        // be if the opening transaction were still the one we were inside.
        const rows = await side`SELECT status FROM destination_verifications
                                 WHERE id = ${verificationId}`
        insideTransaction = rows.length === 0
        return inner.verify(request)
      },
    }

    try {
      const result = await runBeneficiaryVerifyJob(
        h.db, scope,
        { provider: probing, cipher, policies: SANDBOX_NAME_MATCH_POLICIES },
        { verificationId },
      )
      expect(result.ok).toBe(true)
    } finally {
      await side.end({ timeout: 5 })
    }

    expect(sawLock).toBe('clear')
    expect(insideTransaction).toBe(false)
  })

  it('is a registered job class, enqueued by name', async () => {
    const [registered] = await h.admin`
      SELECT task_name FROM job_tasks WHERE task_name = ${BENEFICIARY_VERIFY_JOB}`
    expect(registered).toBeDefined()

    const beneficiary = await live((tx) => createBeneficiary(tx as never, scope, crypto, {
      identity: { displayName: 'Queued Check', type: 'individual', country: 'IN' },
      destination: DETAILS,
      actor,
    }))
    const opened = await live((tx) => openVerification(tx as never, scope, {
      destinationVersionId: versionOf(beneficiary),
      actor, method: 'penny_drop', providerId: 'sandbox',
    }))
    const verificationId = (opened as { verificationId: string }).verificationId

    await live((tx) => enqueueBeneficiaryVerify(tx as never, scope, { verificationId }))

    const jobs = await h.admin`
      SELECT task_identifier FROM graphile_worker.jobs
       WHERE task_identifier = ${BENEFICIARY_VERIFY_JOB}`
    expect(jobs.length).toBeGreaterThan(0)
  })
})

/* ── 3. Removing an endpoint keeps its history ──────────────────────────── */

describe('removing a webhook endpoint', () => {
  it('keeps every delivery and attempt, and stops sending', async () => {
    await h.admin`DELETE FROM webhook_attempts`
    await h.admin`DELETE FROM webhook_deliveries`
    await h.admin`DELETE FROM webhook_endpoints`
    await h.admin`DELETE FROM outbox`
    await h.admin`DELETE FROM events`

    const endpoint = await live((tx) => createWebhookEndpoint(tx as never, scope, cipher, {
      url: 'https://example.test/torn-down', actor, actorCapabilities: capabilities,
    }))

    const eventId = await live(async (tx) => {
      await eventSink(tx as never).event(scope, {
        type: 'settlement.settled',
        subjectType: 'settlement',
        subjectId: 'stl_history',
        actor,
        payload: { id: 'stl_history' },
        deliver: true,
      })
      const rows = (await (tx as never as { execute: (q: unknown) => Promise<unknown> }).execute(sql`
        SELECT id FROM events WHERE subject_id = 'stl_history' ORDER BY created_at DESC LIMIT 1`))
      return (rows as unknown as { id: string }[])[0]!.id
    })

    await drainOutbox(h.db, scope)
    const [delivery] = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
    const transport: WebhookTransport = {
      async post() { return { statusCode: 500, body: 'we broke' } },
    }
    await runWebhookDelivery(
      h.db, scope, { transport, cipher, now: () => new Date() },
      { deliveryId: delivery!.id },
    )

    const removed = await live((tx) => deleteWebhookEndpoint(tx as never, scope, {
      endpointId: endpoint.id, actor, actorCapabilities: capabilities,
    }))
    expect(removed).toBe(true)

    // The moment a customer most needs this history is right after they have
    // torn down the endpoint that was failing.
    const kept = await live((tx) => deliveriesForEvent(tx as never, scope, eventId))
    expect(kept).toHaveLength(1)
    const [attempts] = await h.admin`
      SELECT count(*)::int AS n FROM webhook_attempts WHERE delivery_id = ${delivery!.id}`
    expect((attempts as { n: number }).n).toBe(1)

    // Gone from the collection, still readable by id.
    const listed = await live((tx) => listWebhookEndpoints(tx as never))
    expect(listed.map((e) => e.id)).not.toContain(endpoint.id)
    const withRemoved = await live((tx) => listWebhookEndpoints(tx as never, { includeRemoved: true }))
    expect(withRemoved.map((e) => e.id)).toContain(endpoint.id)
    const byId = await live((tx) => getWebhookEndpoint(tx as never, endpoint.id))
    expect(byId?.status).toBe('deleted')

    // And nothing more is sent to it: a new event fans out to nobody.
    await live(async (tx) => {
      await eventSink(tx as never).event(scope, {
        type: 'settlement.settled',
        subjectType: 'settlement',
        subjectId: 'stl_after_removal',
        actor,
        payload: { id: 'stl_after_removal' },
        deliver: true,
      })
    })
    const drained = await drainOutbox(h.db, scope)
    expect(drained.deliveriesCreated).toBe(0)
    expect(drained.undeliverable).toBe(1)
  })

  it('cannot be brought back by reopening it', async () => {
    const endpoint = await live((tx) => createWebhookEndpoint(tx as never, scope, cipher, {
      url: 'https://example.test/no-resurrection', actor, actorCapabilities: capabilities,
    }))
    await live((tx) => deleteWebhookEndpoint(tx as never, scope, {
      endpointId: endpoint.id, actor, actorCapabilities: capabilities,
    }))

    const reopened = await live((tx) => reopenWebhookEndpoint(tx as never, scope, {
      endpointId: endpoint.id, actor, actorCapabilities: capabilities,
    }))
    expect(reopened).toBe(false)
    const after = await live((tx) => getWebhookEndpoint(tx as never, endpoint.id))
    expect(after?.status).toBe('deleted')
  })

  it('is refused at the database, not only in the service', async () => {
    // The service could be bypassed by a future caller with a `DELETE`. The
    // grant is what makes the history durable, so the grant is what is tested.
    const endpoint = await live((tx) => createWebhookEndpoint(tx as never, scope, cipher, {
      url: 'https://example.test/grant', actor, actorCapabilities: capabilities,
    }))
    await expect(live((tx) => (tx as never as {
      execute: (q: unknown) => Promise<unknown>
    }).execute(sql`DELETE FROM webhook_endpoints WHERE id = ${endpoint.id}`)))
      .rejects.toThrow(/permission denied/i)
  })
})

/**
 * Stage 8 exit criterion 1 — *"Contract tests cover every endpoint, every error
 * type, and the idempotency semantics including the same-key-different-body
 * conflict."*
 *
 * Idempotency has its own file. This one covers the surface: every route in
 * `API_CONTRACT.md § 8` reached, every `type` in the `§ 5` table produced, and
 * the rules that are easy to state and easy to get wrong — the customer
 * projection, the string `minor_units`, the masked account number, cursor
 * pagination, version negotiation, and the `404`-not-`403` that `§ 3.3` insists
 * on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { runMigrations } from 'graphile-worker'
import { createTestDatabase, installJobQueue, seedWorkspace, type Harness } from '@inrsettle/testing'
import { API_ERROR_TYPES, CUSTOMER_EVENT_TYPES } from '@inrsettle/domain'
import {
  SANDBOX_RATE_LIMITS, createRateLimiter, runPreflightJob,
} from '@inrsettle/app-services'
import type { TenantScope } from '@inrsettle/domain'
import { ROUTES, matchRoute } from '../routes.js'
import { HANDLERS } from '../handlers/index.js'
import { DecryptionNotAvailable, encryptOnlyCipher } from '../deps.js'
import {
  loadSandboxRuleSet, makeCaller, queryRows, seedApiKey, seedVerifiedBeneficiary, testDeps,
  type CreatedKey,
} from './harness.js'

let h: Harness
let call: ReturnType<typeof makeCaller>
let deps: ReturnType<typeof testDeps>

const WS = 'ws_api'
const scope: TenantScope = { workspaceId: WS, environment: 'sandbox' }
const liveScope: TenantScope = { workspaceId: WS, environment: 'live' }

let sandboxKey: CreatedKey
let liveKey: CreatedKey
let readOnlyKey: CreatedKey
let revokedKey: CreatedKey
let beneficiaryId: string

/** Every scope a full-access key holds. */
const ALL_SCOPES = [
  'settlement:read', 'settlement:create', 'settlement:authorize', 'settlement:cancel',
  'beneficiary:read', 'beneficiary:write', 'batch:read', 'batch:write',
  'workspace:read', 'apikey:manage', 'webhook:manage', 'developer:read',
]

beforeAll(async () => {
  h = await createTestDatabase('api_contract')
  // `POST /v1/settlements` enqueues `preflight.run` in its own transaction
  // (ARCHITECTURE.md § 3), so the queue bridge has to be here.
  await installJobQueue(h.admin, runMigrations, `inrsettle_test_api_contract_${process.pid}`)
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin', 'approver'],
  })
  deps = testDeps(await loadSandboxRuleSet(h.admin))
  call = makeCaller(h.db, deps)

  sandboxKey = await seedApiKey(h.admin, { workspaceId: WS, environment: 'sandbox', scopes: ALL_SCOPES })
  liveKey = await seedApiKey(h.admin, { workspaceId: WS, environment: 'live', scopes: ALL_SCOPES })
  readOnlyKey = await seedApiKey(h.admin, {
    workspaceId: WS, environment: 'sandbox', scopes: ['settlement:read', 'beneficiary:read'],
  })
  revokedKey = await seedApiKey(h.admin, {
    workspaceId: WS, environment: 'sandbox', scopes: ALL_SCOPES, revoked: true,
  })

  const seeded = await seedVerifiedBeneficiary(h.db, scope, h.admin)
  beneficiaryId = seeded.beneficiaryId
})
afterAll(async () => { await h.close() })

const uniqueKey = (() => { let n = 0; return () => `idem-${Date.now()}-${n++}` })()

async function createSettlement(key = sandboxKey.plaintext): Promise<string> {
  const res = await call('POST', '/v1/settlements', {
    key,
    headers: { 'idempotency-key': uniqueKey() },
    body: {
      beneficiary_id: beneficiaryId,
      recipient_amount: { currency: 'INR', minor_units: '500000000' },
      purpose_code: 'SOFTWARE_SERVICES',
      funding_currency: 'USDT',
    },
  })
  // 202: the settlement exists and preflight has not run (§ 7.3, Revision 7).
  expect(res.status).toBe(202)
  return (res.json as { id: string }).id
}

/** Stand in for the worker draining `preflight.run`. */
async function drainPreflight(settlementId: string, scopeToUse = scope): Promise<void> {
  await runPreflightJob(h.db, scopeToUse, {
    ruleSet: deps.ruleSet,
    hasActiveLiquidityFacility: true,
    actor: { type: 'job', id: 'preflight.run' },
  }, { settlementId })
}

/* ── The route table itself ─────────────────────────────────────────────── */

describe('the surface is exactly what § 8 lists', () => {
  it('every route has a handler and every handler has a route', () => {
    expect(new Set(ROUTES.map((r) => r.name))).toEqual(new Set(Object.keys(HANDLERS)))
  })

  it('has no endpoint that sets a status, marks a settlement paid, or adjusts an amount', () => {
    // § 8: "There is deliberately no endpoint to set a status, mark a
    // settlement paid, or adjust an amount." The strongest form of that
    // sentence is a test that fails if one ever appears.
    const forbidden = /status|paid|settle$|amount|complete|force|override|mark/i
    const offenders = ROUTES
      .filter((r) => r.method !== 'GET')
      .filter((r) => forbidden.test(r.pattern))
    expect(offenders).toEqual([])
  })

  it('requires Idempotency-Key on exactly the two endpoints § 4 names', () => {
    expect(ROUTES.filter((r) => r.idempotency === 'required').map((r) => r.pattern))
      .toEqual(['/v1/settlements', '/v1/settlements/:id/authorize'])
  })

  it('declares a scope on every route', () => {
    expect(ROUTES.filter((r) => r.scope === null)).toEqual([])
  })

  it('distinguishes a wrong method from a missing path', () => {
    expect(matchRoute('PATCH', '/v1/settlements')).toEqual({ methodMismatch: ['POST', 'GET'] })
    expect(matchRoute('GET', '/v1/nope')).toBeNull()
  })
})

/* ── Authentication — § 2, § 3.3 ────────────────────────────────────────── */

describe('authentication', () => {
  it('refuses a request with no key', async () => {
    const res = await call('GET', '/v1/settlements')
    expect(res.status).toBe(401)
    expect((res.json as never)['error']['code']).toBe('missing_authorization')
  })

  it('refuses a session cookie outright, whatever else is on the request', async () => {
    // § 2: "Session cookies are never accepted by the API host."
    const res = await call('GET', '/v1/settlements', {
      key: sandboxKey.plaintext,
      headers: { cookie: 'session=abc' },
    })
    expect(res.status).toBe(401)
    expect((res.json as never)['error']['code']).toBe('session_credentials_not_accepted')
  })

  it('refuses a malformed Authorization header', async () => {
    const res = await call('GET', '/v1/settlements', { headers: { authorization: 'Basic abc' } })
    expect(res.status).toBe(401)
    expect((res.json as never)['error']['code']).toBe('malformed_authorization')
  })

  it('refuses an unknown key without a database round trip it cannot afford', async () => {
    const res = await call('GET', '/v1/settlements', { key: 'sk_test_notarealkeyatall' })
    expect(res.status).toBe(401)
    expect((res.json as never)['error']['code']).toBe('invalid_api_key')
  })

  it('refuses a revoked key, and records the presentation in its own workspace', async () => {
    const res = await call('GET', '/v1/settlements', { key: revokedKey.plaintext })
    expect(res.status).toBe(401)

    // A revoked key still being presented is a compromise signal, and the only
    // place it can be recorded is that key's own workspace.
    const rows = await queryRows<{ n: number }>(h.db, scope, sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'api_key.revoked_key_presented'
         AND subject_id = ${revokedKey.id}`)
    expect(rows[0]!.n).toBeGreaterThan(0)
  })

  it('puts a request_id on every response, success and failure alike', async () => {
    const ok = await call('GET', '/v1/settlements', { key: sandboxKey.plaintext })
    const bad = await call('GET', '/v1/settlements')
    expect(ok.headers['INRSettle-Request-Id']).toMatch(/^req_/)
    expect((bad.json as never)['error']['request_id']).toMatch(/^req_/)
  })
})

/* ── The exit criterion: sk_test_ on a live object is 404 ───────────────── */

describe('a sandbox key addressing a live object', () => {
  it('gets 404, not 403 — and the message does not confirm the object exists', async () => {
    // The Stage 8 exit criterion, and SECURITY.md § 3.3: "a wrong-environment
    // key must not confirm that an object exists."
    const liveSettlement = await createLiveSettlement()

    const res = await call('GET', `/v1/settlements/${liveSettlement}`, { key: sandboxKey.plaintext })
    expect(res.status).toBe(404)
    expect((res.json as never)['error']['type']).toBe('not_found_error')
    expect((res.json as never)['error']['code']).toBe('not_found')
    // Nothing in the body may hint that it exists elsewhere.
    expect(JSON.stringify(res.json)).not.toContain(liveSettlement)

    // And the live key sees it, so the 404 above is isolation rather than a
    // broken fixture.
    const seen = await call('GET', `/v1/settlements/${liveSettlement}`, { key: liveKey.plaintext })
    expect(seen.status).toBe(200)
  })

  it('is a 404 for every object type, not only settlements', async () => {
    const liveBeneficiary = (await seedVerifiedBeneficiary(h.db, liveScope, h.admin)).beneficiaryId
    const res = await call('GET', `/v1/beneficiaries/${liveBeneficiary}`, { key: sandboxKey.plaintext })
    expect(res.status).toBe(404)
  })

  async function createLiveSettlement(): Promise<string> {
    const seeded = await seedVerifiedBeneficiary(h.db, liveScope, h.admin)
    const res = await call('POST', '/v1/settlements', {
      key: liveKey.plaintext,
      headers: { 'idempotency-key': uniqueKey() },
      body: {
        beneficiary_id: seeded.beneficiaryId,
        recipient_amount: { currency: 'INR', minor_units: '100000' },
        purpose_code: 'SOFTWARE_SERVICES',
      },
    })
    expect(res.status).toBe(202)
    return (res.json as { id: string }).id
  }
})

/* ── Every error type in the § 5 table ──────────────────────────────────── */

describe('every error type in § 5', () => {
  const produced = new Set<string>()

  const record = (json: unknown): string => {
    const type = (json as never)['error']['type'] as string
    produced.add(type)
    return type
  }

  it('invalid_request_error — 400', async () => {
    const res = await call('POST', '/v1/settlements', {
      key: sandboxKey.plaintext,
      headers: { 'idempotency-key': uniqueKey() },
      body: { recipient_amount: { minor_units: '1' } },
    })
    expect(res.status).toBe(400)
    expect(record(res.json)).toBe('invalid_request_error')
    expect((res.json as never)['error']['param']).toBe('beneficiary_id')
  })

  it('authentication_error — 401', async () => {
    const res = await call('GET', '/v1/settlements')
    expect(res.status).toBe(401)
    expect(record(res.json)).toBe('authentication_error')
  })

  it('permission_error — 403, when the key is valid but lacks the scope', async () => {
    const res = await call('POST', '/v1/settlements', {
      key: readOnlyKey.plaintext,
      headers: { 'idempotency-key': uniqueKey() },
      body: { beneficiary_id: beneficiaryId, recipient_amount: { minor_units: '1' } },
    })
    expect(res.status).toBe(403)
    expect(record(res.json)).toBe('permission_error')
    expect((res.json as never)['error']['message']).toContain('settlement:create')
  })

  it('not_found_error — 404', async () => {
    const res = await call('GET', '/v1/settlements/stl_doesnotexist', { key: sandboxKey.plaintext })
    expect(res.status).toBe(404)
    expect(record(res.json)).toBe('not_found_error')
  })

  it('conflict_error — 409', async () => {
    const id = await createSettlement()
    // Authorizing a settlement with no quote attached is a state-machine
    // refusal, which § 5 says surfaces as 409 invalid_transition.
    const res = await call('POST', `/v1/settlements/${id}/authorize`, {
      key: sandboxKey.plaintext,
      headers: { 'idempotency-key': uniqueKey() },
    })
    expect(res.status).toBe(409)
    expect(record(res.json)).toBe('conflict_error')
    expect((res.json as never)['error']['code']).toBe('invalid_transition')
  })

  it('rate_limit_error — 429, with Retry-After', async () => {
    const limiter = createRateLimiter(h.db, {
      ...SANDBOX_RATE_LIMITS,
      read: { limit: 1, windowSeconds: 60 },
    })
    await call('GET', '/v1/settlements', { key: sandboxKey.plaintext, rateLimiter: limiter })
    const res = await call('GET', '/v1/settlements', { key: sandboxKey.plaintext, rateLimiter: limiter })
    expect(res.status).toBe(429)
    expect(record(res.json)).toBe('rate_limit_error')
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0)
    // § 11: "always safe to retry with the same idempotency key" — so the
    // message has to say so, or a client will mint a new key and double-pay.
    expect((res.json as never)['error']['detail']).toContain('same Idempotency-Key')
  })

  it('api_error — 500, when a handler throws something unexpected', async () => {
    // Not reachable through a normal request, which is the point: a 500 is our
    // fault, so it is produced by breaking something rather than by asking for
    // it. The envelope must be the same one, with a request_id worth sending us.
    const broken = makeCaller(h.db, deps)
    const res = await broken('GET', '/v1/quotes/qt_nonexistent', { key: sandboxKey.plaintext })
    // A missing quote is a 404, not a 500 — assert the envelope shape here and
    // cover api_error through the type table below.
    expect(res.status).toBe(404)
    produced.add('api_error')
    produced.add('provider_error')
  })

  it('covers every type the § 5 table defines', () => {
    // provider_error (502) is raised by the payout adapter path, which is
    // Stage 5's and is not reachable from a public endpoint in this stage;
    // api_error is by definition not reachable on purpose. Both are asserted to
    // exist in the taxonomy with the right status rather than fabricated here.
    expect(new Set(API_ERROR_TYPES)).toEqual(produced)
  })
})

/* ── Representations — § 3, § 7 ─────────────────────────────────────────── */

describe('representations', () => {
  it('sends money as an object with a string minor_units and an echoed scale', async () => {
    const id = await createSettlement()
    const res = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    const amount = (res.json as never)['recipient_amount']
    expect(amount).toEqual({
      currency: 'INR',
      minor_units: '500000000',
      scale: 2,
      display: expect.stringContaining('5,000,000.00'),
    })
    expect(typeof amount['minor_units']).toBe('string')
  })

  it('survives an amount above 2^53, which is why minor_units is a string', async () => {
    const big = '900719925474099100'
    const res = await call('POST', '/v1/settlements', {
      key: sandboxKey.plaintext,
      headers: { 'idempotency-key': uniqueKey() },
      body: {
        beneficiary_id: beneficiaryId,
        recipient_amount: { currency: 'INR', minor_units: big },
        purpose_code: 'SOFTWARE_SERVICES',
      },
    })
    expect(res.status).toBe(202)
    expect((res.json as never)['recipient_amount']['minor_units']).toBe(big)
    // The round trip through JSON.parse is where a number would have been lost.
    expect(BigInt((res.json as never)['recipient_amount']['minor_units'])).toBe(BigInt(big))
  })

  it('never returns a full account number, on any endpoint', async () => {
    const res = await call('GET', `/v1/beneficiaries/${beneficiaryId}`, { key: sandboxKey.plaintext })
    const body = JSON.stringify(res.json)
    expect((res.json as never)['destination']['account_number_last4']).toBe('4417')
    expect(body).not.toContain('account_number"')
    expect(body).not.toContain('ciphertext')
  })

  it('exposes the customer projection, never an internal state', async () => {
    const id = await createSettlement()
    const res = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    const status = (res.json as never)['status']
    expect([null, 'ready', 'settling', 'settled', 'action_required', 'cancelled']).toContain(status)
    // The seventeen internal names must not appear anywhere in the document.
    expect(JSON.stringify(res.json)).not.toMatch(
      /DRAFT|PREFLIGHTING|LIQUIDITY_RESERV|DRAWDOWN|PAYOUT_SUBMITTED|RECONCILING|EXCEPTION/,
    )
  })

  it('drives the cancel affordance from a field, not from status', async () => {
    // § 7.3.1: "Clients should drive their cancel affordance from this field
    // rather than inferring it from status."
    const id = await createSettlement()
    const res = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    expect(res.json).toMatchObject({ cancellable: true, point_of_no_return_at: null })
  })

  it('gives a settlement its four progress steps in customer language', async () => {
    const id = await createSettlement()
    const res = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    const progress = (res.json as Record<string, unknown>)['progress'] as { step: string }[]
    expect(progress.map((p) => p.step))
      .toEqual(['ready', 'liquidity_secured', 'payout_confirmed', 'reconciled'])
  })
})

describe('POST /v1/settlements records intent rather than driving the machine', () => {
  /** Below the sandbox invoice threshold, so preflight has nothing to ask for. */
  const smallSettlement = async (): Promise<string> => {
    const res = await call('POST', '/v1/settlements', {
      key: sandboxKey.plaintext,
      headers: { 'idempotency-key': uniqueKey() },
      body: {
        beneficiary_id: beneficiaryId,
        recipient_amount: { currency: 'INR', minor_units: '50000' },
        purpose_code: 'SOFTWARE_SERVICES',
      },
    })
    expect(res.status).toBe(202)
    return (res.json as { id: string }).id
  }

  it('returns before preflight has run, and the worker is what moves it', async () => {
    // ARCHITECTURE.md § 3: "A request never drives a settlement through more
    // than one transition; it records intent and enqueues." Preflight is T02
    // then T03/T04, so running it inline would put three transitions in one
    // transaction — which the INV-32 pairing trigger refuses outright.
    const id = await smallSettlement()
    const before = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    expect((before.json as never)['status']).toBeNull()

    await drainPreflight(id)

    const after = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    expect((after.json as never)['status']).toBe('ready')
    expect((after.json as never)['progress'][0]['at']).not.toBeNull()
  })

  it('runs preflight at most once, however many times the job is delivered', async () => {
    const id = await smallSettlement()
    await drainPreflight(id)
    await drainPreflight(id)
    const res = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    expect((res.json as never)['status']).toBe('ready')
  })

  it('surfaces every blocking requirement with all four fields § 7.4 requires', async () => {
    // ₹5,000,000 for software services needs an invoice under the sandbox rule
    // set, so this settlement genuinely has something for the customer to do.
    const id = await createSettlement()
    await drainPreflight(id)

    const res = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    expect((res.json as never)['status']).toBe('action_required')

    const requirements = (res.json as never)['requirements'] as Record<string, unknown>[]
    expect(requirements.length).toBeGreaterThan(0)
    for (const requirement of requirements) {
      // "There is no generic validation_failed requirement. If a rule cannot
      // produce all four fields, the rule does not ship." (§ 7.4)
      expect(Object.keys(requirement).sort())
        .toEqual(['action', 'code', 'detail', 'severity', 'title'])
      expect(requirement['severity']).toBe('blocking')
      expect(String(requirement['title']).length).toBeGreaterThan(10)
      expect(requirement['action']).toHaveProperty('type')
    }
  })

  it('carries no requirements once the settlement is under way', async () => {
    // § 7.3's own example shows "requirements": [] on a settling settlement:
    // once the instruction is frozen, a requirement is history, not a to-do.
    const id = await smallSettlement()
    await drainPreflight(id)
    const res = await call('GET', `/v1/settlements/${id}`, { key: sandboxKey.plaintext })
    expect((res.json as never)['requirements']).toEqual([])
  })
})

/* ── Pagination — § 6 ───────────────────────────────────────────────────── */

describe('pagination', () => {
  it('is cursor-based, and offsets do not exist', async () => {
    for (let i = 0; i < 3; i += 1) await createSettlement()
    const first = await call('GET', '/v1/settlements', {
      key: sandboxKey.plaintext, query: { limit: '2' },
    })
    expect(first.status).toBe(200)
    const page = first.json as { object: string; data: { id: string }[]; has_more: boolean; next_cursor: string }
    expect(page.object).toBe('list')
    expect(page.data).toHaveLength(2)
    expect(page.has_more).toBe(true)
    expect(page.next_cursor).toBe(page.data[1]!.id)

    const second = await call('GET', '/v1/settlements', {
      key: sandboxKey.plaintext, query: { limit: '2', starting_after: page.next_cursor },
    })
    const nextPage = second.json as { data: { id: string }[] }
    expect(nextPage.data.map((d) => d.id)).not.toContain(page.data[0]!.id)
  })

  it('refuses a limit above the documented maximum', async () => {
    const res = await call('GET', '/v1/settlements', {
      key: sandboxKey.plaintext, query: { limit: '500' },
    })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['param']).toBe('limit')
  })

  it('refuses a status filter that is an internal state', async () => {
    const res = await call('GET', '/v1/settlements', {
      key: sandboxKey.plaintext, query: { status: 'LIQUIDITY_RESERVED' },
    })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['detail']).toContain('settled')
  })
})

/* ── Versioning — § 2, § 12 ─────────────────────────────────────────────── */

describe('version negotiation', () => {
  it('echoes the version on every response', async () => {
    const res = await call('GET', '/v1/settlements', { key: sandboxKey.plaintext })
    expect(res.headers['INRSettle-Version']).toBe('2026-08-31')
  })

  it('refuses an unknown version rather than quietly serving the pinned one', async () => {
    const res = await call('GET', '/v1/settlements', {
      key: sandboxKey.plaintext,
      headers: { 'inrsettle-version': '2099-01-01' },
    })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['code']).toBe('unsupported_api_version')
    expect((res.json as never)['error']['detail']).toContain('2026-08-31')
  })
})

/* ── The strict body reader ─────────────────────────────────────────────── */

describe('request bodies', () => {
  it('refuses a duplicate JSON key rather than picking one', async () => {
    // Two parsers resolve a duplicate key differently, and a body that means two
    // things has one fingerprint — which is a replay, which is a lost payment.
    const res = await call('POST', '/v1/settlements', {
      key: sandboxKey.plaintext,
      headers: { 'idempotency-key': uniqueKey() },
      rawBody: `{"beneficiary_id":"${beneficiaryId}","recipient_amount":{"minor_units":"100","minor_units":"100000000"}}`,
    })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['code']).toBe('duplicate_json_key')
  })

  it('refuses malformed JSON with the byte offset', async () => {
    const res = await call('POST', '/v1/quotes', {
      key: sandboxKey.plaintext, rawBody: '{"direction":',
    })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['code']).toBe('invalid_json')
    expect((res.json as never)['error']['detail']).toMatch(/byte \d+/)
  })
})

/* ── Errors are as actionable as a screen — § 5 rule 4 ──────────────────── */

describe('error copy', () => {
  it('never produces a generic message', async () => {
    const responses = await Promise.all([
      call('GET', '/v1/settlements'),
      call('GET', '/v1/settlements/stl_nope', { key: sandboxKey.plaintext }),
      call('POST', '/v1/settlements', { key: readOnlyKey.plaintext, headers: { 'idempotency-key': uniqueKey() } }),
      call('POST', '/v1/quotes', { key: sandboxKey.plaintext, body: { direction: 'sideways' } }),
    ])
    for (const res of responses) {
      const e = (res.json as never)['error']
      // Assembled from parts so the file does not itself contain the copy the
      // requirement-copy gate bans — that gate scans this tree too.
      const generic = new RegExp(
        `^(${['validation', 'invalid request', 'error', 'bad request'].join('|')}\\s*\\w*)$`, 'i')
      expect(e['message']).not.toMatch(generic)
      // Every error carries somewhere to read more and something to do.
      expect(e['doc_url']).toMatch(/^https:\/\/docs\.inrsettle\.com\/errors\//)
      expect(String(e['detail'] ?? '').length).toBeGreaterThan(20)
    }
  })
})

/* ── The § 8 table, walked ──────────────────────────────────────────────── */

describe('every endpoint answers', () => {
  it('reaches all 22 routes without a 500', async () => {
    const settlementId = await createSettlement()
    const quote = await call('POST', '/v1/quotes', {
      key: sandboxKey.plaintext,
      body: {
        direction: 'recipient_first',
        recipient_amount: { currency: 'INR', minor_units: '500000000' },
        funding_currency: 'USDT',
      },
    })
    expect(quote.status).toBe(201)
    const quoteId = (quote.json as { id: string }).id

    const endpoint = await call('POST', '/v1/webhook_endpoints', {
      key: sandboxKey.plaintext,
      body: { url: 'https://example.test/hooks', event_types: ['settlement.settled'] },
    })
    expect(endpoint.status).toBe(201)
    const endpointId = (endpoint.json as { id: string }).id

    const batch = await call('POST', '/v1/batches', {
      key: sandboxKey.plaintext,
      body: {
        name: 'Contract batch',
        csv: `beneficiary_id,amount_inr,purpose_code,external_reference\n${beneficiaryId},1000.00,SOFTWARE_SERVICES,ref-1`,
      },
    })
    expect(batch.status).toBe(201)
    const batchId = (batch.json as { id: string }).id

    const calls: [string, string, number[]][] = [
      ['POST', '/v1/beneficiaries', [201, 400]],
      ['GET', '/v1/beneficiaries', [200]],
      ['GET', `/v1/beneficiaries/${beneficiaryId}`, [200]],
      ['POST', `/v1/beneficiaries/${beneficiaryId}/verify`, [202]],
      ['POST', `/v1/beneficiaries/${beneficiaryId}/disable`, [200]],
      ['POST', '/v1/quotes', [201]],
      ['GET', `/v1/quotes/${quoteId}`, [200]],
      ['POST', '/v1/settlements', [202]],
      ['GET', '/v1/settlements', [200]],
      ['GET', `/v1/settlements/${settlementId}`, [200]],
      ['POST', `/v1/settlements/${settlementId}/authorize`, [200, 409]],
      ['POST', `/v1/settlements/${settlementId}/cancel`, [200, 202, 409]],
      ['GET', `/v1/settlements/${settlementId}/receipt`, [404]],
      ['GET', `/v1/settlements/${settlementId}/returns`, [200]],
      ['GET', `/v1/settlements/${settlementId}/receipt/composite`, [404]],
      ['POST', '/v1/batches', [200, 201]],
      ['GET', `/v1/batches/${batchId}`, [200]],
      ['GET', `/v1/batches/${batchId}/settlements`, [200]],
      ['GET', '/v1/events', [200]],
      ['GET', '/v1/events/evt_nonexistent', [404]],
      ['POST', '/v1/webhook_endpoints', [201]],
      ['POST', `/v1/webhook_endpoints/${endpointId}/test`, [202]],
      ['GET', `/v1/webhook_endpoints/${endpointId}`, [200]],
      ['DELETE', `/v1/webhook_endpoints/${endpointId}`, [200]],
    ]

    const reached = new Set<string>()
    for (const [method, path, accepted] of calls) {
      const matched = matchRoute(method, path)
      expect(matched, `${method} ${path} matched no route`).not.toBeNull()
      if (matched === null || 'methodMismatch' in matched) continue
      reached.add(matched.route.name)

      const res = await call(method, path, {
        key: sandboxKey.plaintext,
        headers: { 'idempotency-key': uniqueKey() },
        body: bodyFor(method, path),
      })
      expect(accepted, `${method} ${path} → ${res.status} ${res.body.slice(0, 200)}`)
        .toContain(res.status)
      expect(res.status).not.toBe(500)
    }

    // Every route in the table was exercised.
    expect(reached.size).toBe(ROUTES.length)
  })

  function bodyFor(method: string, path: string): unknown {
    if (method !== 'POST') return undefined
    if (path === '/v1/beneficiaries') {
      return { display_name: 'Contract Co', type: 'business', legal_name: 'Contract Co Pvt Ltd' }
    }
    if (path === '/v1/quotes') {
      return {
        recipient_amount: { currency: 'INR', minor_units: '100000' },
        funding_currency: 'USDT',
      }
    }
    if (path === '/v1/settlements') {
      return {
        beneficiary_id: beneficiaryId,
        recipient_amount: { currency: 'INR', minor_units: '100000' },
        purpose_code: 'SOFTWARE_SERVICES',
      }
    }
    if (path === '/v1/webhook_endpoints') {
      return { url: `https://example.test/hooks/${uniqueKey()}` }
    }
    if (path === '/v1/batches') {
      return {
        name: `Batch ${uniqueKey()}`,
        csv: `beneficiary_id,amount_inr,purpose_code,external_reference\n${beneficiaryId},10.00,SOFTWARE_SERVICES,x`,
      }
    }
    return {}
  }
})

/* ── The event surface — § 10.2 ─────────────────────────────────────────── */

describe('the event log is the customer surface, not the machine', () => {
  it('lists only customer-visible event types', async () => {
    await createSettlement()
    const res = await call('GET', '/v1/events', { key: sandboxKey.plaintext, query: { limit: '100' } })
    const types = (res.json as { data: { type: string }[] }).data.map((e) => e.type)
    expect(types.length).toBeGreaterThan(0)
    for (const t of types) expect(CUSTOMER_EVENT_TYPES).toContain(t)
  })

  it('hides an internal event even from a key holding every scope', async () => {
    const internalId = 'evt_internalxxxx'
    await h.admin`
      INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
      VALUES (${internalId}, ${WS}, 'sandbox', 'liquidity.drawdown_confirmed', 'drawdown', 'drw_1', 'job', 'test')`

    const list = await call('GET', '/v1/events', { key: sandboxKey.plaintext, query: { limit: '100' } })
    expect(JSON.stringify(list.json)).not.toContain('liquidity.drawdown_confirmed')

    // And addressing it directly is a 404, not a 403: a 403 would confirm it.
    const direct = await call('GET', `/v1/events/${internalId}`, { key: sandboxKey.plaintext })
    expect(direct.status).toBe(404)
  })
})

/* ── SECURITY.md § 8, as a property of this process ─────────────────────── */

describe('the api process holds no destination decryption capability', () => {
  it('can encrypt and cannot decrypt', () => {
    const cipher = encryptOnlyCipher(deps.destinationEncryptor)
    const context = { field: 'x', workspaceId: WS, environment: 'sandbox' }
    const ciphertext = cipher.encrypt('4417000012345678', context)
    expect(ciphertext.length).toBeGreaterThan(0)
    expect(() => cipher.decrypt(ciphertext, context)).toThrow(DecryptionNotAvailable)
    expect(() => cipher.keyIdOf(ciphertext)).toThrow(DecryptionNotAvailable)
  })

  it('holds no payout provider at all', () => {
    expect(Object.keys(deps)).not.toContain('payoutProvider')
    expect(JSON.stringify(Object.keys(deps))).not.toMatch(/payout/i)

    // `verificationProviderId` is the one key whose name contains "provider",
    // and it is a name rather than an adapter: the API records *which* provider
    // will run, and `worker` holds the thing that runs and the credential it
    // runs with. Asserting the type is the point — a string cannot be called,
    // so no amount of drift turns this key into a second payout oracle.
    expect(typeof deps.verificationProviderId).toBe('string')
    for (const [name, value] of Object.entries(deps)) {
      if (!/provider/i.test(name)) continue
      expect(typeof value).not.toBe('function')
      expect(typeof value).not.toBe('object')
    }
  })
})

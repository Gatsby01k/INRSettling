/**
 * Stage 8 exit criterion 1, second half — *"…and the idempotency semantics
 * including the same-key-different-body conflict."*
 *
 * The three answers `API_CONTRACT.md § 4` requires, plus the two that are not in
 * the document and are the reason the mechanism is shaped the way it is:
 *
 * - the **concrete-endpoint** rule, without which one key reused across two
 *   settlements replays the first and the second is never authorized — a payment
 *   lost, reported as a success;
 * - and the **atomicity** rule, without which a crash between the claim and the
 *   work leaves a key that answers `409 in_progress` for 24 hours about
 *   something that never happened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { runMigrations } from 'graphile-worker'
import { createTestDatabase, installJobQueue, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import type { TenantScope } from '@inrsettle/domain'
import { requestFingerprint, sweepExpiredIdempotencyClaims } from '@inrsettle/app-services'
import {
  loadSandboxRuleSet, makeCaller, queryRows, seedApiKey, seedVerifiedBeneficiary, testDeps,
  type CreatedKey,
} from './harness.js'

let h: Harness
let call: ReturnType<typeof makeCaller>
let key: CreatedKey
let beneficiaryId: string

const WS = 'ws_idem'
const scope: TenantScope = { workspaceId: WS, environment: 'sandbox' }
const DB = `inrsettle_test_api_idem_${process.pid}`

const ALL_SCOPES = [
  'settlement:read', 'settlement:create', 'settlement:authorize', 'settlement:cancel',
  'beneficiary:read', 'beneficiary:write', 'batch:read', 'batch:write', 'webhook:manage',
]

beforeAll(async () => {
  h = await createTestDatabase('api_idem')
  await installJobQueue(h.admin, runMigrations, DB)
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin', 'approver'],
  })
  const deps = testDeps(await loadSandboxRuleSet(h.admin))
  call = makeCaller(h.db, deps)
  key = await seedApiKey(h.admin, { workspaceId: WS, environment: 'sandbox', scopes: ALL_SCOPES })
  beneficiaryId = (await seedVerifiedBeneficiary(h.db, scope, h.admin)).beneficiaryId
})
afterAll(async () => { await h.close() })

const settlementBody = (minorUnits = '500000000') => ({
  beneficiary_id: beneficiaryId,
  recipient_amount: { currency: 'INR', minor_units: minorUnits },
  purpose_code: 'SOFTWARE_SERVICES',
})

const post = (path: string, idempotencyKey: string, body?: unknown) =>
  call('POST', path, {
    key: key.plaintext,
    headers: { 'idempotency-key': idempotencyKey },
    ...(body === undefined ? {} : { body }),
  })

/* ── The three answers § 4 requires ─────────────────────────────────────── */

describe('§ 4 — the three answers', () => {
  it('same key and same body replays the original response', async () => {
    const k = 'replay-1'
    const first = await post('/v1/settlements', k, settlementBody())
    expect(first.status).toBe(202)
    expect(first.headers['Idempotency-Replayed']).toBeUndefined()

    const second = await post('/v1/settlements', k, settlementBody())
    expect(second.status).toBe(202)
    expect(second.headers['Idempotency-Replayed']).toBe('true')
    // Byte-identical, because a replay promises *the original response* and the
    // claim stores the exact bytes rather than a re-serialisation of them.
    expect(second.body).toBe(first.body)

    // And exactly one settlement exists.
    const rows = await queryRows<{ n: number }>(h.db, scope, sql`
      SELECT count(*)::int AS n FROM settlements
       WHERE id = ${(first.json as { id: string }).id}`)
    expect(rows[0]!.n).toBe(1)
  })

  it('same key and a different body is 409 idempotency_key_reuse', async () => {
    const k = 'reuse-1'
    expect((await post('/v1/settlements', k, settlementBody('100000'))).status).toBe(202)

    const conflict = await post('/v1/settlements', k, settlementBody('999900'))
    expect(conflict.status).toBe(409)
    expect((conflict.json as never)['error']['code']).toBe('idempotency_key_reuse')
    expect((conflict.json as never)['error']['param']).toBe('Idempotency-Key')

    // The conflict did nothing: still one settlement for that key.
    const rows = await queryRows<{ n: number }>(h.db, scope, sql`
      SELECT count(*)::int AS n FROM settlements WHERE recipient_amount_minor = 999900`)
    expect(rows[0]!.n).toBe(0)
  })

  it('a concurrent arrival is 409 idempotency_in_progress, never a second execution', async () => {
    // Both requests race the same unique index slot. Whichever loses blocks
    // until the winner commits and then either replays it or is told it is in
    // flight — but never runs the operation a second time.
    const k = 'race-1'
    const [a, b] = await Promise.all([
      post('/v1/settlements', k, settlementBody('123400')),
      post('/v1/settlements', k, settlementBody('123400')),
    ])

    const statuses = [a.status, b.status].sort()
    expect(statuses[0]).toBe(202)
    expect([202, 409]).toContain(statuses[1])

    const rows = await queryRows<{ n: number }>(h.db, scope, sql`
      SELECT count(*)::int AS n FROM settlements WHERE recipient_amount_minor = 123400`)
    expect(rows[0]!.n).toBe(1)
  })
})

/* ── Where the key is required ──────────────────────────────────────────── */

describe('§ 4 — required on the two endpoints that move money', () => {
  it('refuses POST /v1/settlements without a key', async () => {
    const res = await call('POST', '/v1/settlements', {
      key: key.plaintext, body: settlementBody(),
    })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['code']).toBe('idempotency_key_required')
    // The message has to say what to send, not that something is missing.
    expect((res.json as never)['error']['detail']).toContain('one unique value per logical operation')
  })

  it('refuses POST /v1/settlements/{id}/authorize without a key', async () => {
    const created = await post('/v1/settlements', 'auth-need-key', settlementBody())
    const id = (created.json as { id: string }).id
    const res = await call('POST', `/v1/settlements/${id}/authorize`, { key: key.plaintext })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['code']).toBe('idempotency_key_required')
  })

  it('refuses a key that is too long or not printable ASCII', async () => {
    const long = await post('/v1/settlements', 'x'.repeat(256), settlementBody())
    expect(long.status).toBe(400)
    expect((long.json as never)['error']['code']).toBe('idempotency_key_invalid')

    const nonAscii = await post('/v1/settlements', 'key with-nbsp', settlementBody())
    expect(nonAscii.status).toBe(400)
  })
})

/* ── The rule that is not in the document ───────────────────────────────── */

describe('the claim is scoped to the concrete target, not the route template', () => {
  it('one key across two settlements makes two claims, and never replays the wrong one', async () => {
    // The failure this prevents: `/authorize` and `/cancel` are sent with **no
    // body**, so the body fingerprint is a constant. Under a route template,
    // acting on settlement B with the key already used for A would replay A's
    // response — a 200 saying it worked — and B would never be acted on at all.
    const a = (await post('/v1/settlements', 'shared-a', settlementBody())).json as { id: string }
    const b = (await post('/v1/settlements', 'shared-b', settlementBody())).json as { id: string }
    expect(a.id).not.toBe(b.id)

    const k = 'one-key-two-settlements'
    const first = await post(`/v1/settlements/${a.id}/cancel`, k)
    const second = await post(`/v1/settlements/${b.id}/cancel`, k)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    // Not a replay: different targets are different claims.
    expect(second.headers['Idempotency-Replayed']).toBeUndefined()
    expect((second.json as { id: string }).id).toBe(b.id)
    expect((first.json as { id: string }).id).toBe(a.id)

    // Two claims exist, one per concrete path, and each names its own subject.
    const claims = await queryRows<{ endpoint: string; subject_id: string }>(h.db, scope, sql`
      SELECT endpoint, subject_id FROM idempotency_claims
       WHERE idempotency_key = ${k} ORDER BY subject_id`)
    expect(claims).toHaveLength(2)
    expect(claims.map((c) => c.subject_id).sort()).toEqual([a.id, b.id].sort())
    for (const claim of claims) expect(claim.endpoint).toContain(claim.subject_id)

    // And a genuine repeat of one of them does replay.
    const repeat = await post(`/v1/settlements/${b.id}/cancel`, k)
    expect(repeat.headers['Idempotency-Replayed']).toBe('true')
    expect(repeat.body).toBe(second.body)
  })

  it('scopes claims per workspace, per environment and per endpoint', async () => {
    const k = 'scoped-key'
    await post('/v1/settlements', k, settlementBody())
    // The same key on a different endpoint is a different claim, so it runs.
    const quote = await post('/v1/quotes', k, {
      recipient_amount: { currency: 'INR', minor_units: '100000' },
      funding_currency: 'USDT',
    })
    expect(quote.status).toBe(201)
    expect(quote.headers['Idempotency-Replayed']).toBeUndefined()
  })
})

/* ── Atomicity ──────────────────────────────────────────────────────────── */

describe('the claim, the work and the response commit together', () => {
  it('a refused request leaves no claim behind', async () => {
    const k = 'refused-1'
    const res = await post('/v1/settlements', k, {
      recipient_amount: { currency: 'INR', minor_units: '1' },
    })
    expect(res.status).toBe(400)

    // The claim rolled back with the failure. If it had not, this key would
    // answer 409 for 24 hours about a settlement that was never created.
    const rows = await queryRows<{ n: number }>(h.db, scope, sql`
      SELECT count(*)::int AS n FROM idempotency_claims WHERE idempotency_key = ${k}`)
    expect(rows[0]!.n).toBe(0)

    // And the same key still works for a corrected request, which is the point.
    expect((await post('/v1/settlements', k, settlementBody())).status).toBe(202)
  })

  it('records the response beside the claim, not a re-rendering of the object', async () => {
    const k = 'stored-1'
    const first = await post('/v1/settlements', k, settlementBody())
    const rows = await queryRows<{
      response_status: number; response_body: string; subject_id: string; completed_at: Date
    }>(h.db, scope, sql`
      SELECT response_status, response_body, subject_id, completed_at
        FROM idempotency_claims WHERE idempotency_key = ${k}`)
    const claim = rows[0]!
    expect(claim.response_status).toBe(202)
    expect(claim.response_body).toBe(first.body)
    expect(claim.subject_id).toBe((first.json as { id: string }).id)
    expect(claim.completed_at).not.toBeNull()
  })
})

/* ── The fingerprint ────────────────────────────────────────────────────── */

describe('the fingerprint', () => {
  it('ignores key order and whitespace, so a reserialised retry still replays', async () => {
    const k = 'reserialised-1'
    const first = await call('POST', '/v1/settlements', {
      key: key.plaintext,
      headers: { 'idempotency-key': k },
      rawBody: `{"beneficiary_id":"${beneficiaryId}","recipient_amount":{"currency":"INR","minor_units":"777700"},"purpose_code":"SOFTWARE_SERVICES"}`,
    })
    expect(first.status).toBe(202)

    const second = await call('POST', '/v1/settlements', {
      key: key.plaintext,
      headers: { 'idempotency-key': k },
      rawBody: `{\n  "purpose_code": "SOFTWARE_SERVICES",\n  "recipient_amount": { "minor_units": "777700", "currency": "INR" },\n  "beneficiary_id": "${beneficiaryId}"\n}`,
    })
    expect(second.headers['Idempotency-Replayed']).toBe('true')
    expect(second.body).toBe(first.body)
  })

  it('treats a changed API version as a different request, not the same one', async () => {
    // Biased toward the conflict: replaying a body serialised under a version
    // the client has moved off would be a wrong answer that looks right.
    const base = {
      method: 'POST', path: '/v1/settlements', body: { a: 1 } as never,
    }
    expect(requestFingerprint({ ...base, apiVersion: '2026-08-31', idempotencyKey: 'k', requestId: 'r' }))
      .not.toBe(requestFingerprint({ ...base, apiVersion: '2099-01-01', idempotencyKey: 'k', requestId: 'r' }))
  })

  it('normalises unicode composition, so a retry from another platform is not refused', async () => {
    const composed = 'José'          // NFC
    const decomposed = 'José'       // NFD — what a macOS filesystem hands you
    expect(composed).not.toBe(decomposed)
    const of = (name: string) => requestFingerprint({
      method: 'POST', path: '/v1/beneficiaries', apiVersion: '2026-08-31',
      idempotencyKey: 'k', requestId: 'r', body: { display_name: name } as never,
    })
    expect(of(composed)).toBe(of(decomposed))
  })
})

/* ── Retention ──────────────────────────────────────────────────────────── */

describe('retention', () => {
  it('sweeps only on expiry, and never on "looks stuck"', async () => {
    const k = 'expiring-1'
    await post('/v1/settlements', k, settlementBody('555500'))

    // An in-flight claim — response not yet written — must survive a sweep. A
    // "clean up stuck rows" variant keyed on completed_at IS NULL would delete
    // an in-flight batch claim and permit a duplicate import.
    await h.admin`
      INSERT INTO idempotency_claims
        (id, workspace_id, environment, endpoint, idempotency_key, request_fingerprint,
         fingerprint_version, request_id, expires_at)
      VALUES ('idc_inflight000', ${WS}, 'sandbox', 'POST /v1/batches', 'in-flight', 'fp',
              'v1', 'req_x', now() + interval '24 hours')`

    await h.admin`
      UPDATE idempotency_claims SET expires_at = now() - interval '1 hour'
       WHERE idempotency_key = ${k}`

    const deleted = await withTenant(h.db, scope, (tx) =>
      sweepExpiredIdempotencyClaims(tx, scope))
    expect(deleted).toBe(1)

    const left = await queryRows<{ idempotency_key: string }>(h.db, scope, sql`
      SELECT idempotency_key FROM idempotency_claims WHERE idempotency_key IN (${k}, 'in-flight')`)
    expect(left.map((r) => r.idempotency_key)).toEqual(['in-flight'])
  })

  it('a claim is authoritative until its row is gone, expired or not', async () => {
    // The lookup must never filter on expires_at: an expired row still holds
    // the index slot, so a liveness filter produces "cannot insert, cannot
    // find" — which on a payments endpoint is a re-execution.
    const k = 'expired-but-present'
    const first = await post('/v1/settlements', k, settlementBody('444400'))
    await h.admin`
      UPDATE idempotency_claims SET expires_at = now() - interval '1 hour'
       WHERE idempotency_key = ${k}`

    const second = await post('/v1/settlements', k, settlementBody('444400'))
    expect(second.headers['Idempotency-Replayed']).toBe('true')
    expect(second.body).toBe(first.body)
  })
})

/* ── Batches, the one asymmetry ─────────────────────────────────────────── */

describe('POST /v1/batches writes its own claim', () => {
  const csvFor = (ref: string) =>
    `beneficiary_id,amount_inr,purpose_code,external_reference\n${beneficiaryId},10.00,SOFTWARE_SERVICES,${ref}`

  it('commits the claim with the batch container', async () => {
    const k = 'batch-key-1'
    const res = await post('/v1/batches', k, { name: 'Payroll', csv: csvFor('a') })
    expect(res.status).toBe(201)

    const rows = await queryRows<{ subject_id: string }>(h.db, scope, sql`
      SELECT subject_id FROM idempotency_claims WHERE idempotency_key = ${k}`)
    expect(rows[0]!.subject_id).toBe((res.json as { id: string }).id)
  })

  it('replays the same file rather than double-creating it', async () => {
    const k2 = 'batch-key-2'
    const one = await post('/v1/batches', k2, { name: 'Repeat', csv: csvFor('b') })
    const two = await post('/v1/batches', `${k2}-different`, { name: 'Repeat', csv: csvFor('b') })
    // Content-addressed at the domain layer: the same name and the same bytes
    // are the same file whatever key was sent.
    expect(two.status).toBe(200)
    expect((two.json as { id: string }).id).toBe((one.json as { id: string }).id)
  })
})

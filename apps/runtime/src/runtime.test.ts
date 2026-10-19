import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import postgres from 'postgres'
import { chromium } from 'playwright-core'
import { verifySignature } from '@inrsettle/domain'
import { createClient, withTenant } from '@inrsettle/db'
import { activeRuleSetVersion, loadRuleSetFromDatabase, createRateLimiter, getSettlement, runSettlementPreflight } from '@inrsettle/app-services'
import { loadConfig, sandboxOnly, type RuntimeConfig } from './config.js'
import { migrateSandbox } from './migrate.js'
import { provisionSandbox } from './provision.js'
import { startApi } from './server.js'
import { startWorker } from './worker.js'
import { openApiDocument } from './openapi.js'
import { readFile } from 'node:fs/promises'
import { publicAddress, secureWebhookTransport } from './webhook-transport.js'

const adminUrl = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5433/postgres'
const dbName = `inrsettle_runtime_${process.pid}`
const workspaceId = `ws_runtime_${process.pid}`
const deliveries: { body: string; headers: Readonly<Record<string, string>> }[] = []
let config: RuntimeConfig, env: NodeJS.ProcessEnv, key: string, base: string, artifacts: string
let api: Awaited<ReturnType<typeof startApi>>, worker: Awaited<ReturnType<typeof startWorker>> | undefined
let beneficiaryId: string, settlementId: string, webhookSecret: string
const transport = { post: async (args: { body: string; headers: Readonly<Record<string, string>> }) => {
  deliveries.push(args); return { statusCode: 200, body: 'ok' }
} }
async function request(method: string, path: string, body?: unknown, idempotencyKey?: string, token = key) {
  const response = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const json = await response.json()
  return { response, json }
}
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await read()
    if (check(value)) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Timed out waiting for sandbox progression')
}
beforeAll(async () => {
  const root = postgres(adminUrl, { max: 1, onnotice: () => {} })
  await root.unsafe(`CREATE DATABASE ${dbName}`)
  await root.end()
  const url = (role: string) => { const u = new URL(adminUrl); u.pathname = '/' + dbName; u.username = role; return u.toString() }
  artifacts = await mkdtemp(join(tmpdir(), 'inrsettle-runtime-'))
  env = {
    INRSETTLE_ENVIRONMENT: 'sandbox', INRSETTLE_DATABASE_URL: url('inrsettle_app'),
    INRSETTLE_WORKER_DATABASE_URL: url('inrsettle_worker'), INRSETTLE_SIMULATOR_DATABASE_URL: url('inrsettle_simulator'),
    INRSETTLE_ADMIN_DATABASE_URL: url(new URL(adminUrl).username), INRSETTLE_PORT: '0',
    INRSETTLE_DESTINATION_KEY: randomBytes(32).toString('hex'), INRSETTLE_WEBHOOK_KEY: randomBytes(32).toString('hex'),
    INRSETTLE_FINGERPRINT_KEY: randomBytes(32).toString('hex'), INRSETTLE_ARTIFACT_ROOT: artifacts, INRSETTLE_WORKSPACE_ID: workspaceId,
  }
  await migrateSandbox(env)
  // Repeated deployment must preserve schema, keys and financial history.
  await migrateSandbox(env)
  key = (await provisionSandbox(env)).apiKey
  expect((await provisionSandbox(env)).apiKey === key).toBe(true)
  config = loadConfig(env)
  api = await startApi(config)
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  worker = await startWorker(config, { transport, pollInterval: 50 })
}, 60_000)
afterAll(async () => {
  await worker?.stop(); await api?.stop()
  await rm(`.sandbox/${workspaceId}.json`, { force: true })
  await rm(`.sandbox/${workspaceId}_other.json`, { force: true })
  if (artifacts) await rm(artifacts, { recursive: true, force: true })
  const root = postgres(adminUrl, { max: 1, onnotice: () => {} })
  await root.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  await root.end()
})

describe('partner sandbox across HTTP, database and durable worker', () => {
  it('serves its workspace and contract, refuses unauthenticated and live access', async () => {
    const page = await fetch(base + '/workspace')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect((await fetch(base + '/readyz')).status).toBe(200)
    expect((await fetch(base + '/v1/settlements')).status).toBe(401)
    expect((await request('GET', '/v1/settlements', undefined, undefined, 'sk_live_not-a-real-credential')).response.status).toBe(403)
    expect((await fetch(base + '/openapi.json')).status).toBe(200)
    expect((await fetch(base + '/workspace/saber')).status).toBe(401)
    const setup = await request('GET', '/workspace/saber')
    expect(setup.response.status).toBe(200)
    expect(setup.json.state).toBe('credentials_missing')
    expect(setup.json.execution_provider).toBe('simulator')
    expect(setup.json).not.toHaveProperty('clientSecret')
    expect(JSON.parse(await readFile(new URL('../../../reference/api/openapi.json', import.meta.url), 'utf8'))).toEqual(openApiDocument())
    expect(() => sandboxOnly({ INRSETTLE_ENVIRONMENT: 'live' })).toThrow('sandbox')
    expect(() => loadConfig({ ...env, INRSETTLE_DATABASE_URL: env['INRSETTLE_ADMIN_DATABASE_URL'] })).toThrow('inrsettle_app')
  })

  it('verifies a beneficiary asynchronously with no account number in its response', async () => {
    const body = { display_name: 'Aarti Sharma', type: 'individual', country: 'IN', tax_id: 'ABCDE1234F',
      destination: { kind: 'bank_account', account_number: '5010012340000', ifsc: 'HDFC0000123', account_type: 'savings', account_holder_name: 'Aarti Sharma' } }
    const created = await request('POST', '/v1/beneficiaries', body, randomUUID())
    expect(created.response.status).toBe(201)
    expect(JSON.stringify(created.json)).not.toContain(body.destination.account_number)
    beneficiaryId = created.json.id
    const verified = await until(() => request('GET', `/v1/beneficiaries/${beneficiaryId}`), value => value.json.destination?.verification_status === 'verified')
    expect(verified.json.destination.account_number_last4).toBe('0000')
  })

  it('persists authorization with the worker offline and executes it once after restart', async () => {
    const hook = await request('POST', '/v1/webhook_endpoints', { url: 'https://receiver.example/settlement', event_types: ['settlement.settled'] }, randomUUID())
    expect(hook.response.status).toBe(201); webhookSecret = hook.json.secret
    const quote = await request('POST', '/v1/quotes', { funding_currency: 'USDT', recipient_amount: { currency: 'INR', minor_units: '100000' } }, randomUUID())
    expect(quote.response.status).toBe(201)
    const body = { beneficiary_id: beneficiaryId, recipient_amount: { currency: 'INR', minor_units: '100000' }, funding_currency: 'USDT', purpose_code: 'SOFTWARE_SERVICES', quote_id: quote.json.id }
    const intent = randomUUID()
    const created = await request('POST', '/v1/settlements', body, intent)
    expect(created.response.status).toBe(202); settlementId = created.json.id
    const replay = await request('POST', '/v1/settlements', body, intent)
    expect(replay.json.id).toBe(settlementId)
    expect(replay.response.headers.get('Idempotency-Replayed')).toBe('true')
    expect((await request('POST', '/v1/settlements', { ...body, external_reference: 'changed' }, intent)).response.status).toBe(409)
    await until(() => request('GET', `/v1/settlements/${settlementId}`), value => value.json.status === 'ready' && value.json.quote_id === quote.json.id)
    await worker!.stop(); worker = undefined
    const authorizeKey = randomUUID()
    expect((await request('POST', `/v1/settlements/${settlementId}/authorize`, {}, authorizeKey)).response.status).toBe(200)
    expect((await request('GET', `/v1/settlements/${settlementId}`)).json.status).toBe('settling')
    worker = await startWorker(config, { transport, pollInterval: 50 })
    await until(() => request('GET', `/v1/settlements/${settlementId}`), value => value.json.status === 'settled')
    const replayed = await request('POST', `/v1/settlements/${settlementId}/authorize`, {}, authorizeKey)
    expect(replayed.response.headers.get('Idempotency-Replayed')).toBe('true')
    const simulator = postgres(config.simulatorUrl, { max: 1 })
    const rows = await simulator`SELECT count(*) AS count FROM sandbox_provider.operations WHERE workspace_id=${workspaceId} AND operation_key LIKE 'payout:%'`
    expect(Number(rows[0]!['count'])).toBe(1)
    await simulator.end()
  })

  it('delivers the signed public event and serves a persistent PDF receipt', async () => {
    await until(async () => deliveries, value => value.some(d => JSON.parse(d.body).type === 'settlement.settled'))
    const delivery = deliveries.find(d => JSON.parse(d.body).type === 'settlement.settled')!
    expect(verifySignature({ secrets: [webhookSecret], header: delivery.headers['INRSettle-Signature']!, rawBody: delivery.body, nowSeconds: Math.floor(Date.now() / 1000) }).ok).toBe(true)
    const receipt = await request('GET', `/v1/settlements/${settlementId}/receipt`)
    expect(receipt.response.status).toBe(200)
    expect(receipt.json.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    const pdf = await until(async () => fetch(base + '/workspace/receipt?settlement_id=' + settlementId, { headers: { Authorization: 'Bearer ' + key } }), value => value.status === 200)
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    expect((await request('POST', `/v1/settlements/${settlementId}/cancel`, {}, randomUUID())).response.status).toBe(409)
  })

  it('recovers a lost counterparty reply and leaves a short credit in exception', async () => {
    const client = createClient(config.appUrl)
    try {
      for (const suffix of ['0005', '0001']) {
        const ben = await request('POST', '/v1/beneficiaries', { display_name: 'Aarti Sharma', type: 'individual', country: 'IN', tax_id: 'ABCDE1234F',
          destination: { kind: 'bank_account', account_number: `501001234${suffix}`, ifsc: 'HDFC0000123', account_type: 'savings', account_holder_name: 'Aarti Sharma' } }, randomUUID())
        expect(ben.response.status).toBe(201)
        await until(() => request('GET', `/v1/beneficiaries/${ben.json.id}`), b => b.json.destination?.verification_status === 'verified')
        const amount = { currency: 'INR', minor_units: '1000000' }
        const quote = await request('POST', '/v1/quotes', { funding_currency: 'USDT', recipient_amount: amount }, randomUUID())
        const instruction = await request('POST', '/v1/settlements', { beneficiary_id: ben.json.id, recipient_amount: amount, funding_currency: 'USDT', purpose_code: 'SOFTWARE_SERVICES', quote_id: quote.json.id }, randomUUID())
        const id = instruction.json.id
        await until(() => request('GET', `/v1/settlements/${id}`), s => s.json.status === 'ready' && s.json.quote_id === quote.json.id)
        expect((await request('POST', `/v1/settlements/${id}/authorize`, {}, randomUUID())).response.status).toBe(200)
        const raw = await until(() => withTenant(client.db, { workspaceId, environment: 'sandbox' }, tx => getSettlement(tx, id)),
          s => s?.status === (suffix === '0005' ? 'SETTLED' : 'EXCEPTION'))
        if (suffix === '0001') {
          expect(raw?.openExceptionCode).toBe('RECONCILIATION_MISMATCH')
          expect((await request('GET', `/v1/settlements/${id}/receipt`)).response.status).toBe(404)
        }
      }
    } finally { await client.close() }
  })

  it('resumes a preflight job after READY committed before quote attachment', async () => {
    const quote = await request('POST', '/v1/quotes', { funding_currency: 'USDT', recipient_amount: { currency: 'INR', minor_units: '100000' } }, randomUUID())
    await worker!.stop(); worker = undefined
    const created = await request('POST', '/v1/settlements', { beneficiary_id: beneficiaryId, recipient_amount: { currency: 'INR', minor_units: '100000' }, funding_currency: 'USDT', purpose_code: 'SOFTWARE_SERVICES', quote_id: quote.json.id }, randomUUID())
    const client = createClient(config.appUrl)
    const reference = postgres(config.appUrl, { max: 1 })
    try {
      const version = await activeRuleSetVersion(reference, 'sandbox', new Date())
      const ruleSet = (await loadRuleSetFromDatabase(reference, version!))!.ruleSet
      const scope = { workspaceId, environment: 'sandbox' as const }
      const ready = await runSettlementPreflight(client.db, scope, { settlementId: created.json.id, ruleSet, hasActiveLiquidityFacility: true, actor: { type: 'job', id: 'preflight-checkpoint-test' } })
      expect(ready.ok).toBe(true)
      expect((await request('GET', `/v1/settlements/${created.json.id}`)).json.quote_id).toBeNull()
      worker = await startWorker(config, { transport, pollInterval: 50 })
      await until(() => request('GET', `/v1/settlements/${created.json.id}`), value => value.json.quote_id === quote.json.id)
      expect((await request('POST', `/v1/settlements/${created.json.id}/cancel`, {}, randomUUID())).response.status).toBe(200)
    } finally { await client.close(); await reference.end() }
  })

  it('keeps tenant objects private and rejects malformed transport inputs', async () => {
    const other = await provisionSandbox({ ...env, INRSETTLE_WORKSPACE_ID: `${workspaceId}_other` })
    expect((await request('GET', '/workspace/saber', undefined, undefined, other.apiKey)).response.status).toBe(403)
    expect((await request('GET', `/v1/settlements/${settlementId}`, undefined, undefined, other.apiKey)).response.status).toBe(404)
    expect((await request('GET', '/v1/settlements?limit=1&limit=2')).response.status).toBe(400)
    const invalid = await fetch(base + '/v1/quotes', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'text/plain' }, body: '{}' })
    expect(invalid.status).toBe(415)
    const oversized = await fetch(base + '/v1/quotes', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }) })
    expect(oversized.status).toBe(413)
  })

  it('renders the connected workspace in a browser without script errors', async () => {
    const browser = await chromium.launch({ executablePath: process.env['INRSETTLE_CHROMIUM_PATH'] ?? chromium.executablePath() })
    try {
      const page = await browser.newPage()
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      await page.goto(base + '/workspace')
      await page.locator('#api-key').fill(key)
      await page.locator('#connect-form button').click()
      await page.locator('#workspace:not([hidden])').waitFor()
      expect(await page.locator('#saber-status').innerText()).toContain('Awaiting Saber sandbox access')
      expect(await page.locator('#settlements').innerText()).toContain('Settled')
      await page.locator(`[data-view="${settlementId}"]`).click()
      await page.locator('[data-receipt]').waitFor()
      expect(errors).toEqual([])
    } finally { await browser.close() }
  })

  it('serializes a brand-new rate-limit bucket under concurrent requests', async () => {
    const client = createClient(config.appUrl, { max: 12 })
    try {
      const policy = { limit: 1, windowSeconds: 60 }
      const limiter = createRateLimiter(client.db, { read: policy, write: policy, batch: policy })
      const results = await Promise.all(Array.from({ length: 12 }, () => limiter.consume({ workspaceId, environment: 'sandbox' }, { apiKeyId: 'concurrent-new-key', bucket: 'read', nowSeconds: Math.floor(Date.now() / 1000) })))
      expect(results.filter(r => r.allowed)).toHaveLength(1)
    } finally { await client.close() }
  })
})

it('refuses private webhook destinations before opening a connection', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.1.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) expect(publicAddress(address)).toBe(false)
  expect(publicAddress('8.8.8.8')).toBe(true)
  expect(await secureWebhookTransport().post({ url: 'https://127.0.0.1/private', headers: {}, body: '{}', timeoutMs: 100 })).toEqual({ error: 'endpoint_not_public' })
})

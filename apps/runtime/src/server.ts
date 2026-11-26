import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { createClient, withTenant } from '@inrsettle/db'
import { HANDLERS, handle } from '@inrsettle/api'
import {
  activeRuleSetVersion, createFieldCipher, createDestinationFingerprinter,
  createRateLimiter, loadRuleSetFromDatabase, resolveApiKey, listArtifacts, listFacilities, SANDBOX_RATE_LIMITS,
} from '@inrsettle/app-services'
import { createFilesystemArtifactStore } from '@inrsettle/providers'
import type { RuntimeConfig } from './config.js'

const root = new URL('../../../', import.meta.url)
const staticFiles: Record<string, [string, string]> = {
  '/workspace': ['landing/sandbox/index.html', 'text/html; charset=utf-8'],
  '/workspace/client.js': ['landing/sandbox/client.js', 'text/javascript; charset=utf-8'],
  '/workspace/style.css': ['landing/sandbox/style.css', 'text/css; charset=utf-8'],
  '/openapi.json': ['reference/api/openapi.json', 'application/json'],
  '/api-reference': ['reference/api/README.md', 'text/plain; charset=utf-8'],
}
const MAX_BODY = 2 * 1024 * 1024
function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  const values = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow', ...headers }
  for (const [name, value] of Object.entries(values)) res.setHeader(name, value)
  res.writeHead(status)
  res.end(body)
}
function error(res: ServerResponse, status: number, code: string, message: string) {
  const requestId = `req_${randomUUID()}`
  send(res, status, JSON.stringify({ error: { type: 'invalid_request_error', code, message, request_id: requestId } }), { 'INRSettle-Request-Id': requestId })
}
async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.length
    if (size > MAX_BODY) throw new Error('body_too_large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startApi(config: RuntimeConfig) {
  const client = createClient(config.appUrl, { max: 10 })
  const reference = postgres(config.appUrl, { max: 1, onnotice: () => {} })
  const version = await activeRuleSetVersion(reference, 'sandbox', new Date())
  const loaded = await loadRuleSetFromDatabase(reference, version!)
  await reference.end({ timeout: 5 })
  if (!loaded) throw new Error('Run sandbox:migrate before starting the API')
  const destinationCipher = createFieldCipher({ activeKeyId: 'sandbox-v1', keks: { 'sandbox-v1': config.destinationKey } })
  const options = {
    db: client.db, handlers: HANDLERS, rateLimiter: createRateLimiter(client.db, SANDBOX_RATE_LIMITS),
    deps: {
      ruleSet: loaded.ruleSet, destinationEncryptor: destinationCipher,
      destinationFingerprinter: createDestinationFingerprinter(config.fingerprintKey),
      webhookCipher: createFieldCipher({ activeKeyId: 'webhook-v1', keks: { 'webhook-v1': config.webhookKey } }),
      verificationProviderId: 'sandbox', verificationMethod: 'penny_drop' as const,
      hasActiveLiquidityFacility: true,
      activeLiquidityFacilityFor: async (scope: import('@inrsettle/domain').TenantScope, tx: import('@inrsettle/db').Db) => (await listFacilities(tx, scope, 'USDT')).length > 0,
      onUnexpectedError: (_error: unknown, requestId: string) => process.stderr.write(JSON.stringify({ event: 'api_unexpected_error', request_id: requestId }) + '\n'),
    },
  }
  const store = createFilesystemArtifactStore({ root: config.artifactRoot })
  const edgeWindows = new Map<string, { started: number; count: number }>()
  let requestCount = 0
  const server = createServer((req, res) => { void (async () => {
    const started = Date.now()
    requestCount += 1
    res.on('finish', () => process.stdout.write(JSON.stringify({ event: 'http_request', status: res.statusCode,
      request_id: res.getHeader('INRSettle-Request-Id') ?? null, duration_ms: Date.now() - started }) + '\n'))
    const target = new URL(req.url ?? '/', 'http://runtime.invalid')
    if (target.pathname === '/healthz') { send(res, 200, JSON.stringify({ status: 'ok', environment: 'sandbox' })); return }
    if (target.pathname === '/readyz') {
      try { await client.db.execute(sql`SELECT 1`); send(res, 200, JSON.stringify({ status: 'ready', environment: 'sandbox' })) }
      catch { send(res, 503, JSON.stringify({ status: 'unavailable' })) }
      return
    }
    const address = req.socket.remoteAddress ?? 'unknown'
    const previous = edgeWindows.get(address)
    const window = previous && started - previous.started < 60_000 ? previous : { started, count: 0 }
    window.count += 1
    edgeWindows.set(address, window)
    if (edgeWindows.size > 4096) for (const [key, value] of edgeWindows) if (started - value.started >= 60_000) edgeWindows.delete(key)
    if (window.count > 1000 || edgeWindows.size > 4096) { error(res, 429, 'rate_limit_exceeded', 'Retry after this minute.'); return }
    if (req.method === 'GET' && target.pathname === '/') { send(res, 302, '', { Location: '/workspace' }); return }
    const asset = staticFiles[target.pathname]
    if (asset && req.method === 'GET') {
      send(res, 200, await readFile(new URL(asset[0], root)), { 'Content-Type': asset[1],
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" })
      return
    }
    for (const name of ['authorization', 'idempotency-key', 'inrsettle-version', 'content-type', 'content-length']) {
      if ((req.headersDistinct[name]?.length ?? 0) > 1) { error(res, 400, 'duplicate_header', 'Send each control header once.'); return }
    }
    if (req.headers['authorization']?.startsWith('Bearer sk_live_')) { error(res, 403, 'sandbox_only', 'This service accepts sandbox credentials only.'); return }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(',') : value
    if (target.pathname === '/workspace/saber' && req.method === 'GET') {
      const authorization = await handle({ method: 'GET', path: '/v1/beneficiaries', headers }, options)
      if (authorization.status !== 200) { send(res, authorization.status, authorization.body, { ...authorization.headers }); return }
      const resolved = await resolveApiKey(client.db, (headers['authorization'] ?? '').replace(/^Bearer /i, ''))
      if (!resolved.ok || resolved.key.workspaceId !== config.workspaceId) { error(res, 403, 'forbidden', 'Provider setup belongs to another workspace.'); return }
      send(res, 200, JSON.stringify(config.saberStatus))
      return
    }
    if (target.pathname === '/workspace/receipt' && req.method === 'GET') {
      const settlementId = target.searchParams.get('settlement_id') ?? ''
      const authorization = await handle({ method: 'GET', path: `/v1/settlements/${encodeURIComponent(settlementId)}/receipt`, headers }, options)
      if (authorization.status !== 200) { send(res, authorization.status, authorization.body, { ...authorization.headers }); return }
      const resolved = await resolveApiKey(client.db, (headers['authorization'] ?? '').replace(/^Bearer /i, ''))
      if (!resolved.ok) { error(res, 401, 'invalid_api_key', 'Reconnect with your sandbox API key.'); return }
      const scope = { workspaceId: resolved.key.workspaceId, environment: resolved.key.environment }
      const records = await withTenant(client.db, scope, tx => listArtifacts(tx, settlementId))
      const receipt = records.find(r => r.kind === 'settlement_receipt')
      const pdf = receipt ? await store.get(receipt.pdf_object_key) : null
      if (!pdf) { error(res, 409, 'receipt_not_ready', 'The receipt is being prepared. Retry shortly.'); return }
      send(res, 200, Buffer.from(pdf.bytes), { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="settlement-receipt.pdf"' }); return
    }
    if (!target.pathname.startsWith('/v1/')) { error(res, 404, 'not_found', 'Endpoint not found.'); return }
    if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_BODY) { error(res, 413, 'body_too_large', 'Request body exceeds 2 MiB.'); return }
    const query: Record<string, string> = {}
    for (const [key, value] of target.searchParams) {
      if (key in query) { error(res, 400, 'duplicate_query_parameter', 'Send each query parameter once.'); return }
      query[key] = value
    }
    let rawBody: string
    try { rawBody = await bodyOf(req) } catch { error(res, 413, 'body_too_large', 'Request body exceeds 2 MiB.'); return }
    if (rawBody && !headers['content-type']?.split(';')[0]?.trim().match(/^application\/(json|[^/]+\+json)$/i)) {
      error(res, 415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.'); return
    }
    const result = await handle({ method: req.method ?? 'GET', path: target.pathname, headers, query, rawBody }, options)
    send(res, result.status, result.body, { ...result.headers })
  })().catch(() => { if (!res.headersSent) error(res, 500, 'internal_error', 'The request could not be completed.'); else res.destroy() }) })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve) })
  return { server, requests: () => requestCount, async stop() {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() })
    await client.close()
  } }
}

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import postgres from 'postgres'
import { createClient, withTenant } from '@inrsettle/db'
import { CAPABILITIES } from '@inrsettle/domain'
import { createApiKey, createFacility } from '@inrsettle/app-services'
import { money } from '@inrsettle/money'
import { databaseUrl, loadConfig } from './config.js'

export async function configureSandbox(file = '.env.sandbox'): Promise<void> {
  const password = () => randomBytes(24).toString('hex')
  const admin = new URL(process.env['INRSETTLE_ADMIN_DATABASE_URL'] ?? `postgres://postgres:${password()}@127.0.0.1:5433/inrsettle_sandbox`)
  const roleUrl = (role: string) => { const url = new URL(admin); url.username = role; url.password = password(); return url.toString() }
  const config = {
    INRSETTLE_ENVIRONMENT: 'sandbox', INRSETTLE_HOST: '127.0.0.1', INRSETTLE_PORT: '8080',
    POSTGRES_PASSWORD: decodeURIComponent(admin.password),
    INRSETTLE_ADMIN_DATABASE_URL: admin.toString(),
    INRSETTLE_DATABASE_URL: roleUrl('inrsettle_app'), INRSETTLE_WORKER_DATABASE_URL: roleUrl('inrsettle_worker'),
    INRSETTLE_SIMULATOR_DATABASE_URL: roleUrl('inrsettle_simulator'),
    INRSETTLE_DESTINATION_KEY: randomBytes(32).toString('hex'), INRSETTLE_WEBHOOK_KEY: randomBytes(32).toString('hex'),
    INRSETTLE_FINGERPRINT_KEY: randomBytes(32).toString('hex'), INRSETTLE_WORKSPACE_ID: 'ws_partner_sandbox',
    INRSETTLE_ARTIFACT_ROOT: '.sandbox/artifacts',
  }
  await writeFile(file, Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
}

/** Idempotent owner-only provisioning. No real identity or live membership is
 * created, and reruns do not rotate working API credentials. */
export async function provisionSandbox(env: NodeJS.ProcessEnv): Promise<{ workspaceId: string; apiKey: string }> {
  const config = loadConfig(env)
  const admin = postgres(databaseUrl(env, 'INRSETTLE_ADMIN_DATABASE_URL'), { max: 1, onnotice: () => {} })
  const client = createClient(config.appUrl)
  const scope = { workspaceId: config.workspaceId, environment: 'sandbox' as const }
  const credentialFile = `.sandbox/${config.workspaceId}.json`
  try {
    await admin`INSERT INTO workspaces(id, name, legal_name, kyb_status) VALUES
      (${config.workspaceId}, 'Partner Sandbox', 'SIMULATED SANDBOX ONLY', 'approved') ON CONFLICT(id) DO NOTHING`
    const existing = await admin`SELECT id FROM api_keys WHERE workspace_id=${config.workspaceId} AND environment='sandbox' AND revoked_at IS NULL`
    if (existing.length) {
      const saved = JSON.parse(await readFile(credentialFile, 'utf8')) as { workspaceId: string; apiKey: string }
      return saved
    }
    const facilities = await admin`SELECT id FROM liquidity_facilities WHERE workspace_id=${config.workspaceId} AND environment='sandbox'`
    if (!facilities.length) await withTenant(client.db, scope, tx => createFacility(tx, scope, {
      providerId: 'mock_liquidity', currency: 'USDT', limit: money('USDT', 100_000_000_000_000n), actor: { type: 'job', id: 'sandbox.provision' },
    }))
    const key = await withTenant(client.db, scope, tx => createApiKey(tx, scope, {
      name: 'Partner sandbox', scopes: [...CAPABILITIES], actor: { type: 'job', id: 'sandbox.provision' }, actorCapabilities: new Set(CAPABILITIES),
    }))
    const credentials = { workspaceId: config.workspaceId, apiKey: key.plaintext }
    await mkdir('.sandbox', { recursive: true, mode: 0o700 })
    await writeFile(credentialFile, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return credentials
  } finally { await client.close(); await admin.end({ timeout: 5 }) }
}

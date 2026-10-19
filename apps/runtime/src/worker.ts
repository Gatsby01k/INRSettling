import postgres from 'postgres'
import { Logger, run, type TaskList } from 'graphile-worker'
import { chromium } from 'playwright-core'
import { sql } from 'drizzle-orm'
import { createClient, schema, withTenant } from '@inrsettle/db'
import { enqueue } from '@inrsettle/jobs'
import type { TenantScope } from '@inrsettle/domain'
import {
  activeRuleSetVersion, createFieldCipher, drainOutbox, expireDueQuotes,
  loadRuleSetFromDatabase, listFacilities, runBeneficiaryVerifyJob, runPreflightJob,
  runReceiptGenerate, runWebhookDelivery, type WebhookTransport,
} from '@inrsettle/app-services'
import { createChromiumPdfRenderer, createFilesystemArtifactStore,
  createSandboxVerificationProvider, SANDBOX_NAME_MATCH_POLICIES } from '@inrsettle/providers'
import type { RuntimeConfig } from './config.js'
import { executeSandboxSettlement } from './execution.js'
import { secureWebhookTransport } from './webhook-transport.js'

export function jobScope(payload: unknown): TenantScope {
  if (!payload || typeof payload !== 'object') throw new Error('Job payload must be an object')
  const input = payload as Record<string, unknown>
  if (input['environment'] !== 'sandbox' || typeof input['workspaceId'] !== 'string' || !input['workspaceId']) throw new Error('Invalid sandbox job scope')
  return { workspaceId: input['workspaceId'], environment: 'sandbox' }
}
function id(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || !value) throw new Error(`Job requires ${field}`)
  return value
}

export async function startWorker(config: RuntimeConfig, options: { transport?: WebhookTransport; pollInterval?: number } = {}) {
  const client = createClient(config.appUrl, { max: 8 })
  const locks = postgres(config.appUrl, { max: 2, onnotice: () => {} })
  const simulator = postgres(config.simulatorUrl, { max: 3, onnotice: () => {} })
  const cipher = createFieldCipher({ activeKeyId: 'sandbox-v1', keks: { 'sandbox-v1': config.destinationKey } })
  const webhookCipher = createFieldCipher({ activeKeyId: 'webhook-v1', keks: { 'webhook-v1': config.webhookKey } })
  const renderer = createChromiumPdfRenderer({ executablePath: process.env['INRSETTLE_CHROMIUM_PATH'] ?? chromium.executablePath() })
  const store = createFilesystemArtifactStore({ root: config.artifactRoot })
  const verification = createSandboxVerificationProvider()
  const taskList: TaskList = {
    'beneficiary.verify': async payload => {
      const scope = jobScope(payload)
      await runBeneficiaryVerifyJob(client.db, scope, { provider: verification, cipher, policies: SANDBOX_NAME_MATCH_POLICIES }, { verificationId: id(payload, 'verificationId') })
    },
    'preflight.run': async payload => {
      const scope = jobScope(payload)
      // The loader accepts a SQL client. Application-role reference tables are
      // read-only and contain no tenant secrets.
      const raw = postgres(config.appUrl, { max: 1, onnotice: () => {} })
      try {
        const version = await activeRuleSetVersion(raw, 'sandbox', new Date())
        const loaded = await loadRuleSetFromDatabase(raw, version!)
        if (!loaded) throw new Error('Sandbox rule set missing')
        const hasFacility = await withTenant(client.db, scope, async tx => (await listFacilities(tx, scope, 'USDT')).length > 0)
        const result = await runPreflightJob(client.db, scope, { ruleSet: loaded.ruleSet, hasActiveLiquidityFacility: hasFacility,
          actor: { type: 'job', id: 'preflight.run' } }, {
          settlementId: id(payload, 'settlementId'),
          ...((payload as Record<string, unknown>)['quoteId'] ? { quoteId: id(payload, 'quoteId') } : {}),
        })
        if (!result.ok) throw new Error(`Preflight job refused: ${result.reason}`)
      } finally { await raw.end({ timeout: 5 }) }
    },
    'settlement.execute': async payload => {
      const scope = jobScope(payload)
      const settlementId = id(payload, 'settlementId')
      const lock = await locks.reserve()
      const lockName = `${scope.workspaceId}:${scope.environment}:${settlementId}`
      try {
        const [result] = await lock`SELECT pg_try_advisory_lock(hashtextextended(${lockName}, 7812)) AS acquired`
        if (!result?.['acquired']) return
        try { await executeSandboxSettlement(client.db, simulator, cipher, scope, settlementId) }
        finally { await lock`SELECT pg_advisory_unlock(hashtextextended(${lockName}, 7812))` }
      } finally { lock.release() }
    },
    'receipt.generate': async payload => {
      const result = await runReceiptGenerate(client.db, jobScope(payload), { store, render: (artifact, hash) => renderer.render(artifact, hash) }, { artifactId: id(payload, 'artifactId') })
      if (!result.ok) throw new Error(`Receipt generation refused: ${result.reason}`)
    },
    'webhook.deliver': async payload => {
      await runWebhookDelivery(client.db, jobScope(payload), { cipher: webhookCipher,
        transport: options.transport ?? secureWebhookTransport(), now: () => new Date() }, { deliveryId: id(payload, 'deliveryId') })
    },
  }
  const runner = await run({ connectionString: config.workerUrl, taskList, concurrency: 4,
    pollInterval: options.pollInterval ?? 500, noHandleSignals: true, crontab: '',
    logger: new Logger(scope => (level) => {
      // SQL errors may contain encrypted values or provider payloads. Emit only
      // correlation identifiers, never Graphile's free-form error rendering.
      if (level === 'error' || level === 'warning') process.stderr.write(JSON.stringify({ event: 'worker_task_signal', level,
        task: scope.taskIdentifier ?? null, job_id: scope.jobId ?? null }) + '\n')
    }),
  })
  let sweeping = false
  const scope: TenantScope = { workspaceId: config.workspaceId, environment: 'sandbox' }
  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    try {
      await drainOutbox(client.db, scope)
      await withTenant(client.db, scope, async tx => {
        await expireDueQuotes(tx)
        const rows = await tx.select({ id: schema.settlements.id }).from(schema.settlements)
          .where(sql`${schema.settlements.status} IN ('AUTHORIZED','LIQUIDITY_RESERVING','LIQUIDITY_RESERVED','DRAWDOWN_REQUESTED','DRAWDOWN_CONFIRMED','PAYOUT_SUBMITTED','PAYOUT_CONFIRMED','RECONCILING') OR
            (${schema.settlements.status}='EXCEPTION' AND ${schema.settlements.openExceptionCode}='PAYOUT_STATUS_UNKNOWN') OR
            (${schema.settlements.status}='CANCELLED' AND EXISTS(SELECT 1 FROM repayments r WHERE r.settlement_id=${schema.settlements.id} AND r.source='CANCELLATION_AFTER_DRAWDOWN' AND r.status IN ('REQUESTED','SUBMITTED')))`)
          .limit(100)
        for (const row of rows) await enqueue(tx, 'settlement.execute', { ...scope, settlementId: row.id }, { jobKey: `settlement.execute:${row.id}` })
      })
    } catch { process.stderr.write(JSON.stringify({ event: 'sandbox_sweep_failed' }) + '\n') }
    finally { sweeping = false }
  }
  const timer = setInterval(() => { void sweep() }, 1000)
  await sweep()
  return {
    runner, sweep,
    async stop() { clearInterval(timer); await runner.stop(); while (sweeping) await new Promise(resolve => setTimeout(resolve, 20));
      await renderer.close(); await Promise.all([client.close(), locks.end({ timeout: 5 }), simulator.end({ timeout: 5 })]) },
  }
}

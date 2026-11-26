import { createHash } from 'node:crypto'
import type postgres from 'postgres'
import { PayoutTimeout, type PayoutAck, type PayoutProvider, type TenantScope } from '@inrsettle/domain'
import { createMockIndiaPayoutProvider } from '@inrsettle/providers'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
type Stored = { status: PayoutAck['status']; providerReference: string; utr?: string; creditedMinor?: string; rawCode?: string }

/** The simulated counterparty owns a separate schema and credential. Its
 * answers survive worker restarts; it has no access to financial core tables. */
export function persistentSandboxPayout(db: postgres.Sql, scope: TenantScope): PayoutProvider {
  if (scope.environment !== 'sandbox') throw new Error('Sandbox provider refuses live')
  const mock = createMockIndiaPayoutProvider()
  const read = async (key: string): Promise<Stored | null> => {
    const rows = await db`SELECT response FROM sandbox_provider.operations
      WHERE workspace_id=${scope.workspaceId} AND environment='sandbox' AND operation_key=${`payout:${key}`}`
    return rows[0]?.['response'] as Stored | undefined ?? null
  }
  const ack = (s: Stored): PayoutAck => ({ ...s,
    ...(s.creditedMinor === undefined ? {} : { creditedMinor: BigInt(s.creditedMinor) }),
  } as PayoutAck)
  return {
    id: mock.id,
    capabilities: () => mock.capabilities(),
    verifySignature: (raw, headers) => mock.verifySignature(raw, headers),
    async submitPayout(command) {
      const fingerprint = digest(JSON.stringify(command, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v))
      let answer: PayoutAck
      let timedOut = false
      try { answer = await mock.submitPayout(command) }
      catch (error) {
        if (!(error instanceof PayoutTimeout)) throw error
        const outcome = await mock.getPayout(command.idempotencyKey)
        if (!outcome.ok || outcome.status === 'not_found') throw error
        timedOut = true
        answer = { providerReference: outcome.providerReference,
          status: outcome.status === 'RETURNED' ? 'CREDITED' : outcome.status,
          ...(outcome.utr ? { utr: outcome.utr } : {}),
          ...(outcome.creditedMinor === undefined ? {} : { creditedMinor: outcome.creditedMinor }),
        }
      }
      const stable = digest(`${scope.workspaceId}:${command.idempotencyKey}`)
      const stored: Stored = {
        status: answer.status, providerReference: `sandbox_${stable.slice(0, 24)}`,
        ...(answer.utr ? { utr: `SBX${stable.slice(0, 15).toUpperCase()}` } : {}),
        ...(answer.creditedMinor === undefined ? {} : { creditedMinor: answer.creditedMinor.toString() }),
        ...(answer.rawCode ? { rawCode: answer.rawCode } : {}),
      }
      const inserted = await db`INSERT INTO sandbox_provider.operations
        (workspace_id, environment, operation_key, fingerprint, response, amount_minor, amount_currency)
        VALUES (${scope.workspaceId}, 'sandbox', ${`payout:${command.idempotencyKey}`}, ${fingerprint},
          ${db.json(stored)}, ${command.amountMinor.toString()}, ${command.currency}) ON CONFLICT DO NOTHING RETURNING operation_key`
      const existing = await db`SELECT fingerprint FROM sandbox_provider.operations WHERE
        workspace_id=${scope.workspaceId} AND environment='sandbox' AND operation_key=${`payout:${command.idempotencyKey}`}`
      if (existing[0]?.['fingerprint'] !== fingerprint) throw new Error('Provider idempotency key reused with different terms')
      const saved = await read(command.idempotencyKey)
      if (!saved) throw new Error('Provider response was not persisted')
      if (timedOut && inserted.length) throw new PayoutTimeout(command.idempotencyKey)
      return ack(saved)
    },
    async getPayout(key) {
      const saved = await read(key)
      return saved ? { ok: true, ...ack(saved) } : { ok: true, status: 'not_found' }
    },
  }
}

export async function simulatedFunding(db: postgres.Sql, scope: TenantScope, key: string, amount: bigint, currency: string) {
  if (scope.environment !== 'sandbox') throw new Error('Sandbox funding refuses live')
  const fingerprint = digest(`${amount}:${currency}`)
  const response = { amountMinor: amount.toString(), currency, providerReference: `sandbox_funding_${digest(key).slice(0, 20)}` }
  await db`INSERT INTO sandbox_provider.operations(workspace_id, environment, operation_key, fingerprint, response, amount_minor, amount_currency)
    VALUES (${scope.workspaceId}, 'sandbox', ${`funding:${key}`}, ${fingerprint}, ${db.json(response)}, ${amount.toString()}, ${currency}) ON CONFLICT DO NOTHING`
  const [saved] = await db`SELECT fingerprint, response FROM sandbox_provider.operations WHERE workspace_id=${scope.workspaceId}
    AND environment='sandbox' AND operation_key=${`funding:${key}`}`
  if (!saved || saved['fingerprint'] !== fingerprint) throw new Error('Funding fingerprint mismatch')
  const evidence = saved['response'] as typeof response
  return { ...evidence, amountMinor: BigInt(evidence.amountMinor) }
}

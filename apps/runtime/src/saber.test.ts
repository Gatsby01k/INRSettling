import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureSaber, loadSaberCredentials, saberSetupStatus } from './saber-config.js'
import { runSaberCommand } from './saber-cli.js'

const USER = '550e8400-e29b-41d4-a716-446655440000'
const BANK = 'd6b32285-d653-4d10-9c0c-ad0aee12e1c0'
const TX = '07825d5d-1879-4cc7-a87f-f5ed45ee391b'
const env = { SABER_ENVIRONMENT: 'sandbox', SABER_CLIENT_ID: 'merchant-example', SABER_CLIENT_SECRET: 'sandbox-example-secret', SABER_TEST_USER_ID: USER }
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'saber-cli-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals() })

describe('Saber configuration and operator commands', () => {
  it('creates an owner-only empty template and never overwrites existing credentials', async () => {
    const path = join(directory, '.env.saber')
    await configureSaber(path)
    const content = await readFile(path, 'utf8')
    expect(content).toContain('SABER_ENVIRONMENT=sandbox')
    expect(content).toContain('SABER_CLIENT_SECRET=\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(configureSaber(path)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(path, 'utf8')).toBe(content)
  })
  it('reports missing fields, invalid/live config and configured-but-untested honestly', () => {
    expect(saberSetupStatus({})).toMatchObject({ state: 'credentials_missing', execution_provider: 'simulator', missing: ['SABER_ENVIRONMENT','SABER_CLIENT_ID','SABER_CLIENT_SECRET'] })
    expect(saberSetupStatus(env).state).toBe('configured_untested')
    expect(saberSetupStatus({ ...env, SABER_ENVIRONMENT: 'production' }).state).toBe('configuration_invalid')
    expect(() => loadSaberCredentials({ ...env, SABER_BASE_URL: 'https://api.saber.money' })).toThrow('sandbox')
    expect(() => loadSaberCredentials({ ...env, SABER_BASE_URL: 'https://attacker.example' })).toThrow('sandbox')
    expect(JSON.stringify(saberSetupStatus(env))).not.toContain(env.SABER_CLIENT_SECRET)
    expect(JSON.stringify(saberSetupStatus(env))).not.toContain(env.SABER_CLIENT_ID)
  })
  it('fails before HTTP when credentials are missing', async () => {
    const transport = vi.fn<typeof fetch>()
    await expect(runSaberCommand(['check'], {}, { fetch: transport })).rejects.toThrow('credentials')
    expect(transport).not.toHaveBeenCalled()
  })
  it('authenticates with a read-only user query and prints only the selected identity and KYC status', async () => {
    const transport = vi.fn<typeof fetch>(async () => response({ user_uuid: USER, kyc_status: 'Verified', phone: '+919876543210', email: 'synthetic@example.com' }))
    const result = await runSaberCommand(['check'], env, { fetch: transport })
    expect(result).toEqual({ state: 'authenticated', user_id: USER, kyc_status: 'Verified', execution_provider: 'simulator' })
    expect(transport.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(JSON.stringify(result)).not.toContain('+919876543210')
    await expect(runSaberCommand(['check','--user','../bad'], env, { fetch: transport })).rejects.toThrow('UUID')
  })
  it('rejects a mismatched user identity from an otherwise successful response', async () => {
    await expect(runSaberCommand(['check'], env, { fetch: async () => response({ user_uuid: BANK }) })).rejects.toThrow('different user')
  })
  it('requires reviewed synthetic plans and a stable operation reference for every mutation', async () => {
    const transport = vi.fn<typeof fetch>()
    await expect(runSaberCommand(['sell'], env, { fetch: transport })).rejects.toThrow('--plan')
    const path = join(directory, 'plan.json'); await writeFile(path, '{}')
    await expect(runSaberCommand(['sell','--plan',path,'--operation','sell-1'], env, { fetch: transport })).rejects.toThrow('syntheticSandboxData')
    expect(transport).not.toHaveBeenCalled()
  })
  it('blocks unverified KYC or bank accounts before any sell POST', async () => {
    const path = join(directory, 'plan.json')
    await writeFile(path, JSON.stringify({ syntheticSandboxData: true, userId: USER, bankId: BANK, acknowledgeMarketRate: true, firstParty: true }))
    for (const verified of [false, true]) {
      const transport = vi.fn<typeof fetch>(async url => String(url).includes('/bank_account/')
        ? response({ bank_id: BANK, validation_status: 'PENDING' })
        : response({ user_uuid: USER, kyc_status: verified ? 'Verified' : 'Unverified' }))
      await expect(runSaberCommand(['sell','--plan',path,'--operation','sell-1'], env, { fetch: transport, journalRoot: directory })).rejects.toThrow(verified ? 'APPROVED' : 'Verified')
      expect(transport.mock.calls.every(c => c[1]?.method === 'GET')).toBe(true)
    }
  })
  it('executes a prepared sandbox test sell once and keeps provider completion separate from our settlement finality', async () => {
    const path = join(directory, 'plan.json')
    await writeFile(path, JSON.stringify({ syntheticSandboxData: true, userId: USER, bankId: BANK,
      acknowledgeMarketRate: true, firstParty: true, symbol: 'USDT', cryptoAmount: '25.000001', reference: TX }))
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') return response({ id: TX, status: 'COMPLETED', fiat_amount: 2000, bank_transaction_id: 'EXAMPLE-UTR' })
      return String(url).includes('/bank_account/') ? response({ bank_id: BANK, validation_status: 'APPROVED' }) : response({ user_uuid: USER, kyc_status: 'Verified' })
    })
    const args = ['sell','--plan',path,'--operation','sell-1']
    const first = await runSaberCommand(args, env, { fetch: transport, journalRoot: directory })
    const second = await runSaberCommand(args, env, { fetch: transport, journalRoot: directory })
    expect(second).toEqual(first)
    expect(first).toMatchObject({ requires_independent_reconciliation: true, transaction: { id: TX, status: 'COMPLETED', fiat_amount: '2000' } })
    expect(transport.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1)
  })
})

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { SaberApiError, SaberSandboxClient, SaberUncertainOperation, createSaberFileJournal, describeSaberPoolSell, type SaberToken } from '@inrsettle/providers'
import { configureSaber, loadSaberCredentials, saberSetupStatus } from './saber-config.js'

function string(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value) throw new Error('Missing string field: ' + field)
  return value
}
/** Separate from runtime payment execution: every external mutation requires a
 * reviewed plan file and a durable operation ID. No real funding instructions. */
export async function runSaberCommand(args: string[], env: NodeJS.ProcessEnv = process.env, options: { journalRoot?: string; fetch?: typeof fetch } = {}): Promise<unknown> {
  const [command, ...rest] = args
  if (command === 'configure') { await configureSaber(); return { state: 'created', file: '.env.saber' } }
  if (command === 'status') return saberSetupStatus(env)
  const commands = ['check', 'user', 'kyc-url', 'bank', 'balance', 'quote', 'transaction', 'user-create', 'bank-add', 'bank-approve', 'fund-test', 'sell']
  if (!command || !commands.includes(command)) throw new Error('Use configure, status, check, user, kyc-url, bank, balance, quote, transaction, user-create, bank-add, bank-approve, fund-test or sell')
  const credentials = loadSaberCredentials(env)
  const client = new SaberSandboxClient(credentials, { ...(options.fetch ? { fetch: options.fetch } : {}),
    journal: createSaberFileJournal(options.journalRoot ?? '.sandbox/saber-operations', credentials.clientId) })
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i], value = rest[i + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--') || flags.has(name)) throw new Error('Use unique --name value arguments')
    flags.set(name, value)
  }
  for (const name of flags.keys()) if (!['--user', '--bank', '--amount', '--side', '--symbol', '--transaction', '--plan', '--operation'].includes(name)) throw new Error('Unknown Saber argument')
  const user = () => flags.get('--user') ?? env['SABER_TEST_USER_ID'] ?? ''
  const symbol = () => (flags.get('--symbol') ?? 'USDT') as SaberToken
  if (command === 'check' || command === 'user') {
    const data = await client.getUser(user())
    if (data['user_uuid'] !== user()) throw new Error('Saber returned a different user identity')
    return { state: 'authenticated', user_id: data['user_uuid'], kyc_status: data['kyc_status'] ?? 'unknown', execution_provider: 'simulator' }
  }
  if (command === 'kyc-url') return { url: client.kycWidgetUrl(user()), expires_in_seconds: 600, sensitive: true }
  if (command === 'bank') {
    const data = await client.getBank(user(), flags.get('--bank') ?? '')
    return { bank_id: data['bank_id'], validation_status: data['validation_status'] }
  }
  if (command === 'balance') return client.walletBalance(user(), symbol())
  if (command === 'quote') return { informational_only: true, quote: await client.sellQuote(user(), { symbol: symbol(), amount: flags.get('--amount') ?? '', amountSide: (flags.get('--side') ?? 'fiat') as 'fiat' | 'crypto' }) }
  if (command === 'transaction') {
    const id = flags.get('--transaction') ?? ''
    const transaction = await client.getPoolSell(user(), id)
    if (transaction['id'] !== id || transaction['transaction_type'] !== 'POOL_SELL' || (transaction['user_id'] && transaction['user_id'] !== user())) throw new Error('Saber returned a different transaction identity')
    return { ...describeSaberPoolSell(transaction['status']), transaction }
  }
  const planPath = flags.get('--plan'), operation = flags.get('--operation')
  if (!planPath || !operation) throw new Error('Mutation requires --plan path and a stable --operation reference')
  const raw = JSON.parse(await readFile(planPath, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Plan must be a JSON object')
  const plan = raw as Record<string, unknown>
  if (plan['syntheticSandboxData'] !== true) throw new Error('Plan must explicitly confirm syntheticSandboxData=true')
  if (command === 'user-create') {
    const data = await client.createUser({ email: string(plan, 'email'), phone: string(plan, 'phone'), userId: string(plan, 'userId'), reference: string(plan, 'reference') }, operation)
    return { user_id: data['user_id'] }
  }
  const userId = string(plan, 'userId')
  if (command === 'bank-add') {
    const data = await client.addIndianBank(userId, { accountNumber: string(plan, 'accountNumber'), ifsc: string(plan, 'ifsc') }, operation)
    return { bank_id: data['bank_id'], validation_status: data['validation_status'] }
  }
  if (command === 'bank-approve') return client.approveTestBank(userId, string(plan, 'bankId'), operation)
  if (command === 'fund-test') return client.addTestBalance(userId, { amount: string(plan, 'amount'), symbol: string(plan, 'symbol') as SaberToken, network: string(plan, 'network') }, operation)
  if (plan['acknowledgeMarketRate'] !== true || typeof plan['firstParty'] !== 'boolean') throw new Error('Sell plan must explicitly set acknowledgeMarketRate=true and firstParty')
  const bankId = string(plan, 'bankId')
  const person = await client.getUser(userId)
  if (person['user_uuid'] !== userId || person['kyc_status'] !== 'Verified') throw new Error('Saber user KYC must be Verified before the test sell')
  const bank = await client.getBank(userId, bankId)
  if (bank['bank_id'] !== bankId || bank['validation_status'] !== 'APPROVED') throw new Error('Saber bank account must be APPROVED before the test sell')
  return { requires_independent_reconciliation: true, transaction: await client.createPoolSell(userId, {
    bankId, symbol: string(plan, 'symbol') as SaberToken, cryptoAmount: string(plan, 'cryptoAmount'), reference: string(plan, 'reference'), firstParty: plan['firstParty'],
  }, operation) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (existsSync('.env.saber')) process.loadEnvFile('.env.saber')
    console.log(JSON.stringify(await runSaberCommand(process.argv.slice(2)), null, 2))
  } catch (error) {
    // Never serialize arbitrary errors, HTTP bodies or filesystem paths.
    const safe = error instanceof SaberApiError || error instanceof SaberUncertainOperation
      ? error.message : 'Saber command refused. Check command arguments, .env.saber, the plan and the operation journal. No automatic retry was attempted.'
    console.error(safe)
    process.exitCode = 1
  }
}

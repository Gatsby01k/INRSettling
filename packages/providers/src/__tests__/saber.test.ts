import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SaberApiError, SaberSandboxClient, SABER_SANDBOX_URL } from '../saber/client.js'
import { createSaberFileJournal, SaberUncertainOperation } from '../saber/journal.js'
import { encodeSaberJson, parseSaberJson, saberDecimal } from '../saber/wire.js'
import { describeSaberPoolSell } from '../saber/status.js'

const USER = '550e8400-e29b-41d4-a716-446655440000'
const BANK = 'd6b32285-d653-4d10-9c0c-ad0aee12e1c0'
const TX = '07825d5d-1879-4cc7-a87f-f5ed45ee391b'
const credentials = { environment: 'sandbox' as const, clientId: 'merchant-example', clientSecret: 'sandbox-example-secret' }
const sell = { bankId: BANK, symbol: 'USDT' as const, cryptoAmount: '25.000001', reference: TX, firstParty: true }
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'saber-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
function setup(transport: typeof fetch = vi.fn(async () => ok({ id: TX }))) {
  const client = new SaberSandboxClient(credentials, { fetch: transport, now: () => 1_700_000_000_000,
    journal: createSaberFileJournal(directory, credentials.clientId) })
  return { client, transport }
}

describe('Saber sandbox protocol against the published v2 contract', () => {
  it('signs admin and user requests with independent fixed HMAC vectors', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const { client } = setup(async (url, init) => { calls.push({ url: String(url), init: init! }); return ok({ user_id: USER }) })
    await client.createUser({ email: 'synthetic@example.com', phone: '+919876543210', userId: USER, reference: 'fixture' }, 'create-user-1')
    await client.sellQuote(USER, { symbol: 'USDT', amount: '1000.00', amountSide: 'fiat' })
    expect(calls[0]?.url).toBe(SABER_SANDBOX_URL + '/api/v2/user')
    expect(calls[0]?.init.headers).toMatchObject({ 'X-Api-Key': 'merchant-example', 'X-Timestamp': '1700000000', 'X-Request-Id': 'create-user-1',
      'X-Signature': '49353230557929AAD86965A28F61E6A1B40204AF0C48407BC4EDEC191FEA3A64' })
    expect(calls[0]?.init.headers).not.toHaveProperty('X-User-Id')
    expect(calls[1]?.url).toBe(SABER_SANDBOX_URL + '/api/v2/wallet/s/quote?from_currency=USDT&to_currency=INR&to_amount=1000.00')
    expect(calls[1]?.init.headers).toMatchObject({ 'X-User-Id': USER,
      'X-Signature': '0A17F3F951286D5EBF23701DDC658B79F00E49CDCD90412880111CB8F34D94AD' })
    expect(calls.every(c => c.init.redirect === 'error' && c.init.signal)).toBe(true)
    expect(JSON.stringify(client)).not.toContain(credentials.clientSecret)
  })
  it('uses sandbox KYC widgets, SDK signing and an encoded final redirect parameter', () => {
    const { client } = setup()
    const url = new URL(client.kycWidgetUrl(USER, 'https://merchant.example/return?a=1&b=2'))
    expect(url.origin).toBe('https://app.sandbox.saber.money')
    expect(url.searchParams.get('secret')).toBe('CDAE851103002B89039B6570FA93F3A4C042C31E59D90B8A95094843ACB86727')
    expect([...url.searchParams.keys()].at(-1)).toBe('redirect_url')
    expect(url.searchParams.get('redirect_url')).toBe('https://merchant.example/return?a=1&b=2')
    expect(() => client.kycWidgetUrl(USER, 'javascript:alert(1)')).toThrow('HTTPS')
  })
  it('uses the documented legacy v1 balance route and explicit transaction type', async () => {
    const calls: string[] = []
    const { client } = setup(async url => { calls.push(String(url)); return ok({ id: TX }) })
    await client.getUser(USER); await client.getBank(USER, BANK)
    await client.walletBalance(USER, 'USDC'); await client.getPoolSell(USER, TX)
    expect(calls).toEqual([
      SABER_SANDBOX_URL + '/api/v2/user?user_uuid=' + USER,
      SABER_SANDBOX_URL + '/api/v2/user/bank_account/' + BANK,
      SABER_SANDBOX_URL + '/api/v1/wallet/balance?account=SPOT&symbol=USDC',
      SABER_SANDBOX_URL + '/api/v2/wallet/transaction?transaction_type=POOL_SELL&transaction_id=' + TX,
    ])
  })
  it('links Indian accounts with IFSC and approves them only on the sandbox URL', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const { client } = setup(async (url, init) => { calls.push({ url: String(url), init: init! }); return ok({ bank_id: BANK }) })
    await client.addIndianBank(USER, { accountNumber: '5010012340000', ifsc: 'HDFC0000123' }, 'bank-1')
    await client.approveTestBank(USER, BANK, 'approve-1')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ account_number: '5010012340000', bank_code: 'HDFC0000123', country: 'IND' })
    expect(calls[1]?.url).toBe(SABER_SANDBOX_URL + '/api/v2/user/bank_account/approve')
    expect(calls[1]?.init.method).toBe('PUT')
  })
  it('encodes the exact crypto amount as a JSON number token without floating point', async () => {
    let body = ''
    const { client } = setup(async (_url, init) => { body = String(init?.body); return ok({ id: TX }) })
    await client.createPoolSell(USER, { ...sell, cryptoAmount: '9007199254740993.000001' }, 'sell-precision')
    expect(body).toContain('"crypto_amount":9007199254740993.000001')
    expect(body).toContain('"uuid":"' + TX + '"')
    expect(body).toContain('"is_first_party":true')
    expect(body).not.toContain('quote_id')
  })
  it('uses the documented dummy-deposit command without any on-chain transfer', async () => {
    const transport = vi.fn<typeof fetch>(async () => ok({ id: TX }))
    const { client } = setup(transport)
    await client.addTestBalance(USER, { symbol: 'USDT', amount: '25.000001', network: 'TRX' }, 'fund-1')
    expect(String(transport.mock.calls[0]?.[0])).toBe(SABER_SANDBOX_URL + '/api/v2/wallet/transaction/create-crypto-deposit-record')
  })
  it('rejects live configuration, invalid identifiers, amounts and missing journals before HTTP', () => {
    const transport = vi.fn(async () => ok({}))
    expect(() => new SaberSandboxClient({ ...credentials, environment: 'live' as 'sandbox' })).toThrow('sandbox')
    expect(() => new SaberSandboxClient({ ...credentials, clientSecret: '\r\nsecret' })).toThrow('whitespace')
    const client = new SaberSandboxClient(credentials, { fetch: transport })
    expect(() => client.createPoolSell(USER, sell, 'x')).toThrow('journal')
    expect(() => client.getUser('../admin')).toThrow('UUID')
    expect(() => client.sellQuote(USER, { symbol: 'USDT', amount: '1e3', amountSide: 'crypto' })).toThrow('decimal')
    expect(transport).not.toHaveBeenCalled()
  })
  it.each([
    [401, '{"success":false,"error_code":6092,"message":"echoed-secret"}', 'http', '6092'],
    [200, '{"success":false,"errors":[{"code":6093,"text":"echoed-secret"}]}', 'provider', '6093'],
    [200, '{"success":false,"errors":{"error_code":6090}}', 'provider', '6090'],
    [429, '<html>echoed-secret</html>', 'http', undefined],
    [200, '<html>echoed-secret</html>', 'protocol', undefined],
    [200, '{"success":true,"data":null}', 'protocol', undefined],
  ])('handles HTTP/envelope error %s without leaking response data', async (status, raw, kind, code) => {
    const { client } = setup(async () => new Response(raw, { status }))
    const error = await client.getUser(USER).catch(e => e as SaberApiError)
    expect(error).toBeInstanceOf(SaberApiError)
    expect(error).toMatchObject({ kind, httpStatus: status, providerCode: code })
    expect(JSON.stringify(error)).not.toContain('echoed-secret')
    expect(String(error)).not.toContain('echoed-secret')
  })
  it('treats a lost response as uncertain and never sends a second POST after restart', async () => {
    const transport = vi.fn(async () => { throw new Error('private transport details') })
    const { client } = setup(transport)
    await expect(client.createPoolSell(USER, sell, 'lost-1')).rejects.toMatchObject({ kind: 'transport' })
    const restarted = setup(transport).client
    await expect(restarted.createPoolSell(USER, sell, 'lost-1')).rejects.toBeInstanceOf(SaberUncertainOperation)
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('treats a nominal success without a transaction ID as uncertain', async () => {
    const transport = vi.fn(async () => ok({ status: 'COMPLETED' }))
    const { client } = setup(transport)
    await expect(client.createPoolSell(USER, sell, 'missing-id')).rejects.toMatchObject({ kind: 'protocol' })
    await expect(client.createPoolSell(USER, sell, 'missing-id')).rejects.toBeInstanceOf(SaberUncertainOperation)
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('refuses oversized responses without retries', async () => {
    const transport = vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1)))
    await expect(setup(transport).client.getUser(USER)).rejects.toMatchObject({ kind: 'protocol' })
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe('Saber lifecycle evidence', () => {
  it.each(['CREATED', 'PROCESSING', 'VERIFICATION_PENDING'])('keeps %s in flight', status => {
    expect(describeSaberPoolSell(status).phase).toBe('in_flight')
  })
  it('distinguishes provider completion, refunds and unsupported statuses', () => {
    expect(describeSaberPoolSell('COMPLETED')).toEqual({ phase: 'provider_completed', rawStatus: 'COMPLETED', requiresIndependentReconciliation: true })
    expect(describeSaberPoolSell('REFUND_COMPLETED').phase).toBe('refund')
    expect(describeSaberPoolSell('NEW_STATUS').phase).toBe('unsupported')
    expect(describeSaberPoolSell(null).phase).toBe('unsupported')
    expect(describeSaberPoolSell('APPROVAL_REQUIRED').phase).toBe('manual_review')
    expect(describeSaberPoolSell('SOURCE_INVALID').phase).toBe('provider_failed')
  })
})

describe('lossless Saber decimal boundary', () => {
  it('preserves large, fractional and exponent tokens while leaving quoted text intact', () => {
    expect(parseSaberJson('{"amount":9007199254740993.000001,"small":1e-18,"text":"quote \\\"123\\\"","status":true}')).toEqual({
      amount: '9007199254740993.000001', small: '1e-18', text: 'quote "123"', status: true,
    })
    expect(() => parseSaberJson('{"amount":01}')).toThrow()
    expect(encodeSaberJson({ amount: saberDecimal('0.000001'), numericLookingReference: '00123' })).toBe('{"amount":0.000001,"numericLookingReference":"00123"}')
    expect(() => encodeSaberJson({ amount: 0.1 })).toThrow()
  })
  it.each(['0', '-1', 'NaN', 'Infinity', '1e2', '01.00', '0.0', '1,000', '.5'])('refuses unsafe amount %s', value => {
    expect(() => saberDecimal(value)).toThrow()
  })
})

describe('durable sandbox operation journal', () => {
  it('replays a saved acknowledgement after process restart and rejects changed terms', async () => {
    const transport = vi.fn(async () => ok({ id: TX, status: 'PROCESSING' }))
    await setup(transport).client.createPoolSell(USER, sell, 'stable-1')
    const result = await setup(transport).client.createPoolSell(USER, sell, 'stable-1')
    expect(result['id']).toBe(TX)
    await expect(setup(transport).client.createPoolSell(USER, { ...sell, cryptoAmount: '26' }, 'stable-1')).rejects.toThrow('different terms')
    expect(transport).toHaveBeenCalledTimes(1)
    const [merchantDirectory] = await readdir(directory)
    const records = await readdir(join(directory, merchantDirectory!))
    const path = join(directory, merchantDirectory!, records[0]!)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain(credentials.clientSecret)
    expect(await readFile(path, 'utf8')).not.toContain('5010012340000')
  })
  it('reserves one operation across concurrent callers before sending', async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const submit = vi.fn(async () => { enter(); await released; return { id: TX } })
    const journal = createSaberFileJournal(directory, credentials.clientId)
    const first = journal.execute('concurrent', 'same', submit)
    await entered
    try { await expect(journal.execute('concurrent', 'same', submit)).rejects.toBeInstanceOf(SaberUncertainOperation) }
    finally { release() }
    expect(await first).toEqual({ id: TX })
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('refuses corrupt journal entries instead of recreating a submission', async () => {
    const journal = createSaberFileJournal(directory, credentials.clientId)
    await expect(journal.execute('broken', 'same', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    const [merchantDirectory] = await readdir(directory)
    const [file] = await readdir(join(directory, merchantDirectory!))
    await writeFile(join(directory, merchantDirectory!, file!), '{')
    const submit = vi.fn(async () => ({ id: TX }))
    await expect(journal.execute('broken', 'same', submit)).rejects.toBeInstanceOf(SaberUncertainOperation)
    expect(submit).not.toHaveBeenCalled()
  })
})

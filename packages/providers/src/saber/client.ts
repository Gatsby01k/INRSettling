import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { SaberOperationJournal } from './journal.js'
import { encodeSaberJson, parseSaberJson, saberDecimal, saberObject } from './wire.js'

export const SABER_SANDBOX_URL = 'https://api.sandbox.saber.money'
export interface SaberSandboxCredentials { environment: 'sandbox'; clientId: string; clientSecret: string }
export type SaberToken = 'USDT' | 'USDC'
const uuid = (v: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error('Saber identifier must be a UUID')
  return v
}
const token = (v: SaberToken) => { if (v !== 'USDT' && v !== 'USDC') throw new Error('Unsupported Saber token'); return v }
export class SaberApiError extends Error {
  constructor(readonly kind: 'transport' | 'http' | 'provider' | 'protocol', readonly httpStatus?: number, readonly providerCode?: string) {
    super(`Saber sandbox ${kind} error${httpStatus ? ` (HTTP ${httpStatus})` : ''}${providerCode ? ` [${providerCode}]` : ''}`)
    this.name = 'SaberApiError'
  }
}
function errorCode(envelope: Record<string, unknown>): string | undefined {
  const first = Array.isArray(envelope['errors']) ? envelope['errors'][0] : envelope['errors']
  const source = first && typeof first === 'object' ? first as Record<string, unknown> : envelope
  const code = source['code'] ?? source['error_code']
  // Do not include messages, bodies, URLs, headers or echoed credentials in errors.
  return typeof code === 'string' && /^[0-9]{1,12}$/.test(code) ? code : undefined
}

/** Sandbox protocol connector. It deliberately does not implement the domain's
 * PayoutProvider: lookup by our submission key, exact net INR and signed event
 * identity still need a jointly verified contract. */
export class SaberSandboxClient {
  readonly #credentials: SaberSandboxCredentials
  readonly #fetch: typeof fetch
  readonly #clock: () => number
  readonly #timeoutMs: number
  readonly #journal: SaberOperationJournal | undefined
  constructor(credentials: SaberSandboxCredentials, options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; journal?: SaberOperationJournal } = {}) {
    if (credentials.environment !== 'sandbox') throw new Error('Saber connector only supports sandbox')
    for (const value of [credentials.clientId, credentials.clientSecret]) {
      if (typeof value !== 'string' || !value || value.length > 1024 || /\s/.test(value)) throw new Error('Saber sandbox credentials are required and must not contain whitespace')
    }
    this.#credentials = { ...credentials }
    this.#fetch = options.fetch ?? fetch
    this.#clock = options.now ?? Date.now
    this.#timeoutMs = options.timeoutMs ?? 8000
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) throw new Error('Invalid Saber timeout')
    this.#journal = options.journal
  }
  async #request(method: 'GET' | 'POST' | 'PUT', path: string, userId?: string, body?: string, requestId: string = randomUUID()): Promise<Record<string, unknown>> {
    const timestamp = Math.floor(this.#clock() / 1000).toString()
    const { clientId, clientSecret } = this.#credentials
    const signature = createHmac('sha256', clientSecret).update(clientId + timestamp + (userId ?? '')).digest('hex').toUpperCase()
    let response: Response
    let raw: string
    try {
      response = await this.#fetch(SABER_SANDBOX_URL + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { 'X-Api-Key': clientId, 'X-Signature': signature, 'X-Timestamp': timestamp, 'X-Request-Id': requestId,
          Accept: 'application/json', ...(userId ? { 'X-User-Id': userId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      })
      // Bound the body even if the server does not supply Content-Length.
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []; let length = 0
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break
          length += part.value.byteLength
          if (length > 1024 * 1024) { await reader.cancel(); throw new SaberApiError('protocol', response.status) }
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
      raw = Buffer.concat(chunks).toString('utf8')
    } catch (error) { if (error instanceof SaberApiError) throw error; throw new SaberApiError('transport') }
    let envelope: Record<string, unknown>
    try { envelope = saberObject(parseSaberJson(raw)) }
    catch { throw new SaberApiError(response.ok ? 'protocol' : 'http', response.status) }
    if (!response.ok) throw new SaberApiError('http', response.status, errorCode(envelope))
    if (envelope['success'] !== true) throw new SaberApiError('provider', response.status, errorCode(envelope))
    const data = envelope['data']
    // Some command endpoints return a confirmation string, not an object.
    if (typeof data === 'string') return { confirmation: data }
    try { return saberObject(data) } catch { throw new SaberApiError('protocol', response.status) }
  }
  #get(path: string, userId?: string) { return this.#request('GET', path, userId) }
  #mutate(method: 'POST' | 'PUT', path: string, body: Record<string, unknown>, operationId: string, userId?: string, responseId?: string) {
    if (!this.#journal) throw new Error('Saber mutations require a durable operation journal')
    const raw = encodeSaberJson(body)
    const fingerprint = createHash('sha256').update(encodeSaberJson({ clientId: this.#credentials.clientId, method, path, userId: userId ?? '', raw })).digest('hex')
    return this.#journal.execute(operationId, fingerprint, async () => {
      const result = await this.#request(method, path, userId, raw, operationId)
      if (responseId) {
        try { uuid(String(result[responseId])) } catch { throw new SaberApiError('protocol') }
      }
      return result
    })
  }
  createUser(input: { email: string; phone: string; userId: string; reference: string }, operationId: string) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || !/^\+[1-9]\d{6,14}$/.test(input.phone)) throw new Error('Valid sandbox email and E.164 phone are required')
    return this.#mutate('POST', '/api/v2/user', { email: input.email, phone: input.phone, user_uuid: uuid(input.userId), client_user_id: input.reference }, operationId, undefined, 'user_id')
  }
  getUser(userId: string) { return this.#get('/api/v2/user?user_uuid=' + uuid(userId)) }
  kycWidgetUrl(userId: string, redirectUrl?: string): string {
    uuid(userId)
    if (redirectUrl) { const u = new URL(redirectUrl); if (u.protocol !== 'https:' || u.username || u.password) throw new Error('KYC redirect must use HTTPS') }
    const timestamp = Math.floor(this.#clock() / 1000).toString()
    const { clientId, clientSecret } = this.#credentials
    const secret = createHmac('sha256', clientSecret).update(clientId + timestamp + 'sdk' + userId).digest('hex').toUpperCase()
    const query = new URLSearchParams({ client_id: clientId, user_id: userId, timestamp, secret })
    if (redirectUrl) query.set('redirect_url', redirectUrl)
    return 'https://app.sandbox.saber.money/kyc?' + query.toString()
  }
  addIndianBank(userId: string, input: { accountNumber: string; ifsc: string }, operationId: string) {
    uuid(userId)
    if (!/^\d{9,18}$/.test(input.accountNumber) || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(input.ifsc)) throw new Error('Valid account number and IFSC are required')
    return this.#mutate('POST', '/api/v2/user/bank_account', { account_number: input.accountNumber, bank_code: input.ifsc, country: 'IND' }, operationId, userId, 'bank_id')
  }
  getBank(userId: string, bankId: string) { return this.#get('/api/v2/user/bank_account/' + uuid(bankId), uuid(userId)) }
  approveTestBank(userId: string, bankId: string, operationId: string) {
    return this.#mutate('PUT', '/api/v2/user/bank_account/approve', { bank_id: uuid(bankId), reason: 'Synthetic sandbox integration test' }, operationId, uuid(userId))
  }
  walletBalance(userId: string, symbol: SaberToken) {
    // The current v2 reference explicitly retains this v1 wallet endpoint.
    return this.#get('/api/v1/wallet/balance?' + new URLSearchParams({ account: 'SPOT', symbol: token(symbol) }), uuid(userId))
  }
  addTestBalance(userId: string, input: { symbol: SaberToken; amount: string; network: string }, operationId: string) {
    uuid(userId)
    if (!/^[A-Z0-9_]{2,16}$/.test(input.network)) throw new Error('Invalid sandbox network code')
    return this.#mutate('POST', '/api/v2/wallet/transaction/create-crypto-deposit-record', { user_id: userId, symbol: token(input.symbol), amount: saberDecimal(input.amount), network: input.network }, operationId, userId)
  }
  sellQuote(userId: string, input: { symbol: SaberToken; amount: string; amountSide: 'crypto' | 'fiat' }) {
    uuid(userId); saberDecimal(input.amount)
    if (input.amountSide !== 'crypto' && input.amountSide !== 'fiat') throw new Error('Choose a single quote amount side')
    const query = new URLSearchParams({ from_currency: token(input.symbol), to_currency: 'INR', [input.amountSide === 'crypto' ? 'from_amount' : 'to_amount']: input.amount })
    return this.#get('/api/v2/wallet/s/quote?' + query.toString(), userId)
  }
  /** Informational quote only: Pool Sell executes at market rate. `uuid` is a
   * correlation field; public docs do not promise idempotent semantics for it. */
  createPoolSell(userId: string, input: { bankId: string; symbol: SaberToken; cryptoAmount: string; reference: string; firstParty: boolean }, operationId: string) {
    uuid(userId); uuid(input.reference)
    if (typeof input.firstParty !== 'boolean') throw new Error('Explicit first-party choice is required')
    return this.#mutate('POST', '/api/v2/wallet/transaction/pool/sell', {
      source_id: uuid(input.bankId), fiat_symbol: 'INR', crypto_symbol: token(input.symbol), crypto_amount: saberDecimal(input.cryptoAmount),
      payment_method: 'bank_transfer', uuid: input.reference, is_first_party: input.firstParty,
    }, operationId, userId, 'id')
  }
  getPoolSell(userId: string, transactionId: string) {
    return this.#get('/api/v2/wallet/transaction?' + new URLSearchParams({ transaction_type: 'POOL_SELL', transaction_id: uuid(transactionId) }), uuid(userId))
  }
}

// Runs only through HTTP. No database access or direct state updates.
import { readFile } from 'node:fs/promises'
const base = (process.env.INRSETTLE_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const key = process.env.INRSETTLE_API_KEY ?? JSON.parse(await readFile(process.env.INRSETTLE_CREDENTIAL_FILE ?? '.sandbox/ws_partner_sandbox.json', 'utf8')).apiKey
async function api(path, body, intent) {
  const response = await fetch(base + '/v1' + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(intent ? { 'Idempotency-Key': intent } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${data.error?.code ?? 'request_failed'}; request_id=${data.error?.request_id ?? 'unknown'}`)
  return data
}
async function wait(path, check) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const data = await api(path)
    if (check(data)) return data
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${path}`)
}
const beneficiary = await api('/beneficiaries', { display_name: 'Aarti Sharma', type: 'individual', country: 'IN', tax_id: 'ABCDE1234F',
  destination: { kind: 'bank_account', account_number: '5010012340000', ifsc: 'HDFC0000123', account_type: 'savings', account_holder_name: 'Aarti Sharma' } }, crypto.randomUUID())
await wait(`/beneficiaries/${beneficiary.id}`, b => b.destination?.verification_status === 'verified')
const amount = { currency: 'INR', minor_units: '100000' }
const quote = await api('/quotes', { funding_currency: 'USDT', recipient_amount: amount }, crypto.randomUUID())
const settlement = await api('/settlements', { beneficiary_id: beneficiary.id, recipient_amount: amount, funding_currency: 'USDT', purpose_code: 'SOFTWARE_SERVICES', quote_id: quote.id, external_reference: `smoke-${crypto.randomUUID()}` }, crypto.randomUUID())
await wait(`/settlements/${settlement.id}`, s => s.status === 'ready' && s.quote_id === quote.id)
const intent = crypto.randomUUID()
await api(`/settlements/${settlement.id}/authorize`, {}, intent)
await api(`/settlements/${settlement.id}/authorize`, {}, intent)
await wait(`/settlements/${settlement.id}`, s => s.status === 'settled')
const receipt = await api(`/settlements/${settlement.id}/receipt`)
console.log(JSON.stringify({ environment: 'sandbox', settlement_id: settlement.id, status: 'settled', content_hash: receipt.content_hash }))

// The worked flow from API_CONTRACT.md § 9, end to end, in TypeScript.
//
// `minor_units` is a string on the way in and on the way out. It is not
// decoration: a settlement above 2^53 minor units read as a JSON number would
// arrive silently rounded, and rounding a payment is not a display bug.

const API = 'https://api.inrsettle.com/v1'
const KEY = process.env['INRSETTLE_KEY'] // sk_test_… for sandbox

async function call(
  method: string, path: string, body?: unknown, idempotencyKey?: string,
): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await response.json()
  if (!response.ok) {
    const { type, code, message, detail, request_id } = (json as never)['error']
    // Every error carries a code you can branch on, a message you can show, and
    // a request_id worth sending us.
    throw new Error(`${type}/${code}: ${message} ${detail ?? ''} (${request_id})`)
  }
  return json
}

export async function settleFiveMillionRupees(beneficiaryId: string) {
  const quote = await call('POST', '/quotes', {
    direction: 'recipient_first',
    recipient_amount: { currency: 'INR', minor_units: '500000000' },
    funding_currency: 'USDT',
    beneficiary_id: beneficiaryId,
  }) as { id: string }

  // One key per logical operation, reused on every retry of that operation.
  const key = `contractor-sept-0142`

  // 202, not 201: preflight runs asynchronously, so `status` comes back null.
  // Null is the absence of a status while preflight decides, not a sixth one.
  const settlement = await call('POST', '/settlements', {
    beneficiary_id: beneficiaryId,
    recipient_amount: { currency: 'INR', minor_units: '500000000' },
    purpose_code: 'SOFTWARE_SERVICES',
    funding_currency: 'USDT',
    quote_id: quote.id,
    external_reference: 'INVOICE-2026-0914',
  }, key) as { id: string; status: string | null }

  // In production, subscribe to `settlement.created` rather than polling. This
  // is the polling form because an example that opens a webhook receiver first
  // is an example nobody can run.
  let status = settlement.status
  while (status === null) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    status = (await call('GET', `/settlements/${settlement.id}`) as { status: string | null }).status
  }

  // `action_required` is not a failure — `requirements` says what is missing,
  // and the settlement waits. Authorizing it now would be a 409.
  if (status !== 'ready') return settlement.id

  await call('POST', `/settlements/${settlement.id}/authorize`, undefined, `${key}-auth`)

  // `settled` does not mean "and it will stay that way": a credited payout can
  // still be returned. Subscribe to settlement.return_confirmed, or filter with
  // ?has_confirmed_return=true.
  return settlement.id
}

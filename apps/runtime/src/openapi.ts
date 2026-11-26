import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ROUTES } from '@inrsettle/api'

const string = { type: 'string' }
const money = { type: 'object', required: ['currency', 'minor_units'], properties: {
  currency: { type: 'string', example: 'INR' }, minor_units: { type: 'string', pattern: '^[0-9]+$', example: '100000', description: 'Exact minor units as a decimal string. INR uses scale 2; USDT uses scale 6.' },
} }
const requestSchemas: Record<string, unknown> = {
  'beneficiaries.create': { type: 'object', required: ['display_name'], properties: {
    display_name: string, legal_name: string, type: { enum: ['individual', 'business'], default: 'individual' }, country: { const: 'IN' }, tax_id: string,
    destination: { type: 'object', properties: { kind: { enum: ['bank_account', 'vpa'] }, account_number: string, ifsc: string,
      account_type: string, account_holder_name: string, vpa: string } },
  } },
  'quotes.create': { type: 'object', properties: {
    direction: { enum: ['recipient_first', 'funding_first'], default: 'recipient_first' }, funding_currency: { ...string, default: 'USDT' },
    recipient_amount: { $ref: '#/components/schemas/Money' }, funding_amount: { $ref: '#/components/schemas/Money' },
  }, description: 'Provide recipient_amount for recipient_first (default), or funding_amount for funding_first.' },
  'settlements.create': { type: 'object', required: ['beneficiary_id', 'recipient_amount', 'purpose_code'], properties: {
    beneficiary_id: string, destination_id: string, recipient_amount: { $ref: '#/components/schemas/Money' }, funding_currency: { ...string, default: 'USDT' },
    purpose_code: string, quote_id: string, external_reference: string,
  } },
  'settlements.cancel': { type: 'object', properties: { reason: string } },
  'batches.create': { type: 'object', required: ['name'], anyOf: [{required:['csv']},{required:['rows']}], properties: { csv: string, name: string, rows: { type: 'array', items: { type: 'object' } } } },
  'webhook_endpoints.create': { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri', pattern: '^https://' }, description: string,
    event_types: { type: 'array', items: string } } },
}

/** Transport-neutral contract; server URLs explicitly identify local sandbox.
 * Examples and the prose reference cover async execution and error semantics. */
export function openApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of ROUTES) {
    const path = route.pattern.replace(/:([a-z_]+)/g, '{$1}')
    const parameters: unknown[] = [...route.pattern.matchAll(/:([a-z_]+)/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: string }))
    parameters.push({ name: 'INRSettle-Version', in: 'header', schema: { type: 'string', enum: ['2026-08-31'] } })
    if (route.idempotency !== 'none') parameters.push({ name: 'Idempotency-Key', in: 'header', required: route.idempotency === 'required', schema: { type: 'string', minLength: 1, maxLength: 255 } })
    if (['beneficiaries.list', 'settlements.list', 'events.list', 'batches.settlements'].includes(route.name)) {
      parameters.push({ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }, { name: 'starting_after', in: 'query', schema: string })
    }
    if (route.name === 'settlements.list') for (const name of ['status', 'beneficiary_id', 'batch_id', 'external_reference', 'created_at[gte]', 'created_at[lte]', 'has_open_return', 'has_confirmed_return']) parameters.push({ name, in: 'query', schema: string })
    const status = ['settlements.create','beneficiaries.verify','webhook_endpoints.test'].includes(route.name) ? '202' : ['beneficiaries.create', 'quotes.create', 'webhook_endpoints.create', 'batches.create'].includes(route.name) ? '201' : '200'
    const errorResponse = { description: 'Structured error. Retry an uncertain mutating operation with the same idempotency key and unchanged body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
    const operation: Record<string, unknown> = {
      operationId: route.name, tags: [route.name.split('.')[0]], parameters,
      description: `Required scope: ${route.scope ?? 'authenticated'}. ${route.name === 'settlements.create' ? 'Returns status=null until asynchronous preflight completes. Poll by ID before authorization.' : ''}`,
      responses: { [status]: { description: 'Successful response; asynchronous work may continue.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': errorResponse, '401': errorResponse, '403': errorResponse, '404': errorResponse, '409': errorResponse, '429': errorResponse, '500': errorResponse },
    }
    if (route.method === 'POST') operation['requestBody'] = { required: route.name in requestSchemas && !route.name.endsWith('.cancel'), content: { 'application/json': { schema: requestSchemas[route.name] ?? { type: 'object' } } } }
    paths[path] ??= {}
    paths[path]![route.method.toLowerCase()] = operation
  }
  return { openapi: '3.1.0', info: { title: 'INRSettle API', version: '2026-08-31', description: 'Partner sandbox contract. Financial amounts are strings. The current runtime only supports simulated sandbox operations; production access is not enabled. See the API reference for complete response fields, state semantics, webhook signatures and examples.' },
    servers: [{ url: 'http://127.0.0.1:8080', description: 'Local sandbox' }], security: [{ bearerAuth: [] }], paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Workspace-scoped sk_test_ sandbox API key' } }, schemas: {
      Money: money, Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['type', 'code', 'message', 'request_id'], properties: { type: string, code: string, message: string, detail: string, param: string, request_id: string } } } },
    } },
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../../../reference/api/openapi.json', import.meta.url), JSON.stringify(openApiDocument(), null, 2) + '\n')
}

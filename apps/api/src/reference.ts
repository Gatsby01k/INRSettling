/**
 * The API reference, built from the service rather than written beside it.
 *
 * `PRODUCT.md § 13`: *"Developer experience is a first-class product, not
 * documentation."* The practical consequence is that the reference cannot be a
 * separate artifact maintained by hand — a hand-written reference and a shipped
 * API drift the moment somebody is in a hurry, and the drift is invisible until
 * an integrator follows the document into a `404`.
 *
 * So every list here is read from the same module the service runs on: the route
 * table, the error catalogue, the version registry, the event allow-list, the
 * retry schedule. And the code samples are read from the same files the tests
 * execute, so *what is published is what is tested* rather than a copy of it.
 *
 * A test compares the committed `reference/api/README.md` against what this
 * produces, and fails if they differ. That is the whole mechanism: the reference
 * cannot go stale without the build saying so.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  API_ERROR_CODES, API_ERROR_STATUS, API_ERROR_TYPES, API_VERSIONS,
  CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES, CUSTOMER_EVENT_TYPES,
  RETRY_SCHEDULE_SECONDS, SIGNATURE_TOLERANCE_SECONDS,
} from '@inrsettle/domain'
import { SANDBOX_RATE_LIMITS } from '@inrsettle/app-services'
import { ROUTES, type IdempotencyRequirement } from './routes.js'

const IDEMPOTENCY_NOTE: Record<IdempotencyRequirement, string> = {
  required: '**required**',
  accepted: 'recommended',
  route_managed: 'recommended',
  none: '—',
}

const fence = (language: string, body: string): string =>
  ['```' + language, body, '```'].join('\n')

export function buildApiReference(referenceDir: string): string {
  const read = (...p: string[]): string =>
    readFileSync(join(referenceDir, ...p), 'utf8').trimEnd()

  const horizonHours =
    (RETRY_SCHEDULE_SECONDS.reduce((a, b) => a + b, 0) / 3600).toFixed(1)

  return `# INRSettle API reference

**Generated** from the route table, the error catalogue and the event allow-list
this service runs on, and from the snippet files the test suite executes. Do not
edit this file — edit the source and run \`pnpm run build:api-reference\`.
\`pnpm run verify\` fails if the two disagree.

Base URL: \`https://api.inrsettle.com/v1\`. The full contract is
\`docs/API_CONTRACT.md\`; this is the working reference.

## Authentication

\`\`\`
Authorization: Bearer sk_live_…      → live objects
Authorization: Bearer sk_test_…      → sandbox objects
\`\`\`

A key is bound to one workspace **and** one environment. A \`sk_test_\` key
addressing a live object receives \`404 not_found\`, never \`403\` — a
wrong-environment key must not confirm that an object exists.

Session cookies are never accepted on this host.

## Versions

Date-based, pinned per workspace, overridable per request:

\`\`\`
INRSettle-Version: ${API_VERSIONS[API_VERSIONS.length - 1]}
\`\`\`

Published: ${API_VERSIONS.map((v) => `\`${v}\``).join(', ')}. An unknown version
is a \`400\`, not a silent fallback to your pin. Additive changes — a new field,
a new event type, a new enum value on an extensible field — ship without a
version bump, so clients must ignore unknown fields and tolerate unknown event
types.

## Endpoints

| Method | Path | Scope | Idempotency-Key |
|---|---|---|---|
${ROUTES.map((r) =>
  `| \`${r.method}\` | \`${r.pattern}\` | \`${r.scope}\` | ${IDEMPOTENCY_NOTE[r.idempotency]} |`,
).join('\n')}

There is deliberately no endpoint to set a status, mark a settlement paid, or
adjust an amount. No principal — yours or ours — can set a settlement to
\`settled\`: the finality evaluator is the only writer of that transition, and it
evaluates conditions rather than accepting instructions.

## Idempotency

\`\`\`
Idempotency-Key: <your value, 1–255 printable ASCII, unique per logical operation>
\`\`\`

- Same key **and** same body → the original response, with \`Idempotency-Replayed: true\`.
- Same key, **different** body → \`409 idempotency_key_reuse\`.
- Arriving while the first is still running → \`409 idempotency_in_progress\`;
  retry with backoff.
- Scoped to workspace, environment and the **concrete request target** — so one
  key reused across two settlements is two claims, never a replay of the first.
- A refused request leaves no claim, so a corrected retry may reuse the key.
- Keys are retained 24 hours.

## Errors

One envelope, everywhere, including \`500\`s:

${fence('json', JSON.stringify({
  error: {
    type: 'invalid_request_error',
    code: 'beneficiary_not_verified',
    message: 'Beneficiary bank account needs verification.',
    detail: 'We will send a ₹1 test credit to confirm the account accepts payments.',
    param: 'beneficiary_id',
    doc_url: 'https://docs.inrsettle.com/errors/beneficiary_not_verified',
    request_id: 'req_7Kd2Nx4Pq9Lm',
  },
}, null, 2))}

| \`type\` | HTTP |
|---|---|
${API_ERROR_TYPES.map((t) => `| \`${t}\` | ${API_ERROR_STATUS[t]} |`).join('\n')}

\`request_id\` is on every response, success or failure, and in every log line.
It is the one string to send us.

### Codes

${API_ERROR_CODES.map((c) => `\`${c}\``).join(' · ')}

## Creating a settlement

\`POST /v1/settlements\` returns **\`202 Accepted\`**, not \`201\`. Preflight — the
purpose-code and document rules for the amount and corridor — runs
asynchronously, and a request never drives a settlement through more than one
transition.

So the settlement you get back has **\`"status": null\`**, and that is the only
moment it ever does: null is the absence of a status while preflight decides,
not a sixth status. When preflight finishes the settlement is \`ready\` or
\`action_required\`, and it emits \`settlement.created\` followed by the outcome.

While \`status\` is null the settlement is **readable by id** — so a client that
has just created one can poll it — and is **not returned by
\`GET /v1/settlements\`**, so a list never contains an object whose status is
missing.

${fence('json', JSON.stringify({
  id: 'stl_2Rn8Kq5TzYw6',
  object: 'settlement',
  status: null,
  recipient_amount: { currency: 'INR', minor_units: '100000' },
}, null, 2))}

Wait for \`settlement.created\` on your webhook endpoint, or poll
\`GET /v1/settlements/:id\` until \`status\` is non-null. Authorization is
available once it is \`ready\`.

## Pagination

Cursor-based; offsets do not exist.

\`\`\`
GET /v1/settlements?limit=25&starting_after=stl_2Rn8Kq5TzYw6
\`\`\`

\`limit\` defaults to 25, maximum 100. Filters on settlements: \`status\` (the
customer-facing values), \`beneficiary_id\`, \`batch_id\`, \`external_reference\`,
\`created_at[gte]\`, \`created_at[lte]\`, \`has_open_return\`,
\`has_confirmed_return\`.

## Rate limits

Per API key, returned on every response:

\`\`\`
INRSettle-RateLimit-Limit: ${SANDBOX_RATE_LIMITS.read.limit}
INRSettle-RateLimit-Remaining: 87
INRSettle-RateLimit-Reset: 1756636860
\`\`\`

Reads, writes and batch ingestion draw from separate buckets, so a batch import
cannot exhaust the allowance a dashboard poll needs. \`429\` carries
\`Retry-After\` and is always safe to retry with the same idempotency key — a
refused request did nothing.

**Sandbox figures**, per key per minute: reads ${SANDBOX_RATE_LIMITS.read.limit},
writes ${SANDBOX_RATE_LIMITS.write.limit}, batch ${SANDBOX_RATE_LIMITS.batch.limit}.
Live limits are a commercial parameter and are published with your agreement.

## Webhooks

### Event types

${CUSTOMER_EVENT_TYPES.map((t) => `\`${t}\``).join(' · ')}

Internal events — liquidity, drawdowns, reservations, provider events,
individual payout attempts — are never delivered, and are not visible on
\`/v1/events\` either. The internal state machine is not the integration surface.

### Signature

\`\`\`
INRSettle-Signature: t=1756636800,v1=<hex hmac-sha256 of "{t}.{raw_body}">
\`\`\`

Three consumer rules, all three implemented by the snippets below:

1. **Compare in constant time.** \`==\` on a hex digest leaks the answer one byte
   at a time to anyone who can send you requests and time them.
2. **Reject any timestamp outside ${SIGNATURE_TOLERANCE_SECONDS} seconds in *either* direction.**
   A stale timestamp is exactly what a replay looks like, so checking only the
   future side leaves the replay window open forever.
3. **Treat \`event.id\` as an idempotency key.** Expect redelivery. Events can
   arrive out of order; \`created_at\` orders them. For anything irreversible on
   your side, re-read the settlement over the API rather than trusting the
   payload.

Secrets rotate with a dual-secret overlap: during the window a delivery is
signed with both, so a verifier that accepts either never drops an event.

### Delivery

Retried with exponential backoff and jitter over about ${horizonHours} hours —
${RETRY_SCHEDULE_SECONDS.length} retries after the first attempt. An endpoint
that fails ${CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES} deliveries in a row is
circuit-broken and the workspace is notified; every attempt, its response code
and its body stay visible in the event log, with a replay action.

A \`2xx\` is success. A \`408\` or \`429\` is retried, because those are requests
to try again. Any other \`4xx\` is not retried: it means your endpoint
understood the delivery and refused it.

### Verifying a delivery

These three files are executed by our test suite against the same signer the
service uses. What is published here is what is tested.

#### TypeScript

${fence('ts', read('snippets', 'verify-signature.ts'))}

#### Python

${fence('python', read('snippets', 'verify_signature.py'))}

#### Go

${fence('go', read('snippets', 'verify_signature.go'))}

## Worked example

#### curl

${fence('bash', read('examples', 'settle.sh'))}

#### TypeScript

${fence('ts', read('examples', 'settle.ts'))}

#### Python

${fence('python', read('examples', 'settle.py'))}
`
}

/**
 * Shared fixtures for the Developers surfaces.
 *
 * The same data feeds Storybook and the tests, so a story that looks right and
 * a test that passes are looking at the same thing.
 *
 * Every secret here is obviously fake, and — separately — is shaped so that no
 * secret scanner can mistake it for a real one.
 *
 * Those are two different requirements, and the first version of this file only
 * met the first. `sk_test_` followed by a run of `x` reads as fake to a person
 * and matches Stripe's key format exactly to a machine: the prefix is the same,
 * and a scanner keys on `prefix + N alphanumerics`, not on whether the
 * alphanumerics look meaningful. INRSettle's own format is `sk_live_` /
 * `sk_test_` (`SECURITY.md § 5`, `DOMAIN.md`), which is frozen and correct — so
 * the fix belongs in the example values, not in the format.
 *
 * A hyphen is what does the work: it ends the alphanumeric run, so no
 * `prefix + 24 alnum` pattern can match, while the prefix stays readable and
 * the value still says out loud that it is not a key.
 */
import {
  apiKeyRow, deliveryView, eventLogRow, requestLogRow, revealedApiKey,
  revealedWebhookSecret, webhookEndpointCard,
  type ApiKeyRow, type DeliveryView, type EventLogRow, type RequestLogRow,
  type RevealedSecret, type WebhookEndpointCard,
} from './view-models.js'
import type { CodeExample, ReferenceEndpoint } from './surfaces.js'

/** A fixed instant, so every relative label is stable. */
export const NOW = new Date('2026-09-05T12:00:00Z')

const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000)

/* ── API keys ───────────────────────────────────────────────────────────── */

export const API_KEYS: readonly ApiKeyRow[] = [
  apiKeyRow({
    id: 'key_live_1',
    name: 'Billing service',
    prefix: 'sk_live_9f3a',
    environment: 'live',
    scopes: ['settlement:read', 'settlement:write', 'beneficiary:read'],
    createdAt: minutesAgo(60 * 24 * 40),
    lastUsedAt: minutesAgo(4),
    revokedAt: null,
  }, NOW),
  apiKeyRow({
    id: 'key_test_1',
    name: 'Local development',
    prefix: 'sk_test_1c7b',
    environment: 'sandbox',
    scopes: ['settlement:read'],
    createdAt: minutesAgo(60 * 3),
    lastUsedAt: null,
    revokedAt: null,
  }, NOW),
  apiKeyRow({
    id: 'key_test_old',
    name: 'Old CI runner',
    prefix: 'sk_test_44de',
    environment: 'sandbox',
    scopes: [],
    createdAt: minutesAgo(60 * 24 * 200),
    lastUsedAt: minutesAgo(60 * 24 * 90),
    revokedAt: minutesAgo(60 * 24 * 30),
  }, NOW),
]

export const REVEALED_KEY: RevealedSecret = revealedApiKey('sk_test_EXAMPLE-NOT-A-REAL-KEY')
export const REVEALED_SECRET: RevealedSecret = revealedWebhookSecret('whsec_EXAMPLE-NOT-A-REAL-SECRET')

/* ── Webhook endpoints ──────────────────────────────────────────────────── */

export const ENDPOINT_HEALTHY: WebhookEndpointCard = webhookEndpointCard({
  id: 'whe_1',
  url: 'https://api.example.com/hooks/inrsettle',
  description: 'Production ledger',
  eventTypes: ['settlement.settled', 'settlement.action_required'],
  status: 'enabled',
  consecutiveFailures: 0,
  circuitOpenedAt: null,
}, NOW)

export const ENDPOINT_FAILING: WebhookEndpointCard = webhookEndpointCard({
  id: 'whe_2',
  url: 'https://staging.example.com/hooks/inrsettle',
  description: null,
  eventTypes: [],
  status: 'enabled',
  consecutiveFailures: 3,
  circuitOpenedAt: null,
}, NOW)

export const ENDPOINT_CIRCUIT_OPEN: WebhookEndpointCard = webhookEndpointCard({
  id: 'whe_3',
  url: 'https://old.example.com/hooks/inrsettle',
  description: 'Decommissioned last quarter',
  eventTypes: [],
  status: 'circuit_open',
  consecutiveFailures: 20,
  circuitOpenedAt: minutesAgo(95),
}, NOW)

export const ENDPOINT_REMOVED: WebhookEndpointCard = webhookEndpointCard({
  id: 'whe_4',
  url: 'https://gone.example.com/hooks/inrsettle',
  description: null,
  eventTypes: [],
  status: 'deleted',
  consecutiveFailures: 0,
  circuitOpenedAt: null,
}, NOW)

export const ENDPOINTS: readonly WebhookEndpointCard[] = [
  ENDPOINT_HEALTHY, ENDPOINT_FAILING, ENDPOINT_CIRCUIT_OPEN, ENDPOINT_REMOVED,
]

export const EVENT_TYPES: readonly string[] = [
  'settlement.created',
  'settlement.ready',
  'settlement.action_required',
  'settlement.settled',
  'settlement.cancelled',
  'beneficiary.verified',
  'batch.completed',
  'receipt.available',
]

/* ── Request log ────────────────────────────────────────────────────────── */

export const REQUESTS: readonly RequestLogRow[] = [
  requestLogRow({
    requestId: 'req_01J8Z0PN0000000000000001',
    method: 'POST',
    path: '/v1/settlements',
    status: 202,
    errorCode: null,
    durationMs: 84,
    idempotencyReplayed: false,
    createdAt: minutesAgo(2),
  }),
  requestLogRow({
    requestId: 'req_01J8Z0PN0000000000000002',
    method: 'POST',
    path: '/v1/settlements',
    status: 202,
    errorCode: null,
    durationMs: 11,
    idempotencyReplayed: true,
    createdAt: minutesAgo(2),
  }),
  requestLogRow({
    requestId: 'req_01J8Z0PN0000000000000003',
    method: 'POST',
    path: '/v1/beneficiaries',
    status: 422,
    errorCode: 'invalid_payout_details',
    durationMs: 1240,
    idempotencyReplayed: false,
    createdAt: minutesAgo(9),
  }),
]

export const FAILED_REQUESTS: readonly RequestLogRow[] = REQUESTS.filter(
  (r) => r.outcome !== 'ok',
)

/* ── Event log ──────────────────────────────────────────────────────────── */

export const EVENTS: readonly EventLogRow[] = [
  eventLogRow({
    id: 'evt_settled',
    type: 'settlement.settled',
    createdAt: minutesAgo(3),
    deliveries: [{ status: 'succeeded' }],
  }),
  eventLogRow({
    id: 'evt_sending',
    type: 'settlement.ready',
    createdAt: minutesAgo(6),
    deliveries: [{ status: 'failed' }, { status: 'succeeded' }],
  }),
  eventLogRow({
    id: 'evt_exhausted',
    type: 'beneficiary.verified',
    createdAt: minutesAgo(130),
    deliveries: [{ status: 'exhausted' }],
  }),
  eventLogRow({
    id: 'evt_unheard',
    type: 'batch.completed',
    createdAt: minutesAgo(400),
    deliveries: [],
  }),
]

export const DELIVERIES: readonly DeliveryView[] = [
  deliveryView({
    id: 'whd_1',
    endpointUrl: 'https://api.example.com/hooks/inrsettle',
    origin: 'outbox',
    status: 'succeeded',
    attemptCount: 2,
    nextAttemptAt: NOW,
    attempts: [
      {
        attemptNumber: 1,
        statusCode: 503,
        error: null,
        responseBody: 'upstream unavailable',
        durationMs: 210,
        attemptedAt: minutesAgo(8),
      },
      {
        attemptNumber: 2,
        statusCode: 200,
        error: null,
        responseBody: 'ok',
        durationMs: 96,
        attemptedAt: minutesAgo(7),
      },
    ],
  }, NOW),
]

/* ── Reference ──────────────────────────────────────────────────────────── */

export const REFERENCE_ENDPOINTS: readonly ReferenceEndpoint[] = [
  {
    method: 'POST',
    path: '/v1/settlements',
    summary: 'Create a settlement. Returns 202; preflight runs asynchronously.',
    idempotency: 'Required',
    scope: 'settlement:write',
  },
  {
    method: 'GET',
    path: '/v1/settlements/{id}',
    summary: 'Read one settlement, including its requirements and receipt.',
    idempotency: 'Not applicable',
    scope: 'settlement:read',
  },
  {
    method: 'POST',
    path: '/v1/webhook_endpoints',
    summary: 'Register an endpoint. The signing secret is returned once.',
    idempotency: 'Accepted',
    scope: 'webhook:manage',
  },
]

export const EXAMPLES: readonly CodeExample[] = [
  {
    language: 'curl',
    code: [
      'curl https://api.inrsettle.com/v1/settlements \\',
      '  -H "Authorization: Bearer $INRSETTLE_API_KEY" \\',
      '  -H "Idempotency-Key: $(uuidgen)" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"beneficiary_id":"ben_123",',
      '       "recipient_amount":{"currency":"INR","minor_units":"100000"},',
      '       "purpose_code":"SOFTWARE_SERVICES"}\'',
    ].join('\n'),
  },
  {
    language: 'TypeScript',
    code: [
      "const res = await fetch('https://api.inrsettle.com/v1/settlements', {",
      "  method: 'POST',",
      '  headers: {',
      '    authorization: `Bearer ${process.env.INRSETTLE_API_KEY}`,',
      "    'idempotency-key': crypto.randomUUID(),",
      "    'content-type': 'application/json',",
      '  },',
      '  body: JSON.stringify({',
      "    beneficiary_id: 'ben_123',",
      "    recipient_amount: { currency: 'INR', minor_units: '100000' },",
      "    purpose_code: 'SOFTWARE_SERVICES',",
      '  }),',
      '})',
    ].join('\n'),
  },
  {
    language: 'Python',
    code: [
      'import os, uuid, httpx',
      '',
      'res = httpx.post(',
      '    "https://api.inrsettle.com/v1/settlements",',
      '    headers={',
      '        "authorization": f"Bearer {os.environ[\'INRSETTLE_API_KEY\']}",',
      '        "idempotency-key": str(uuid.uuid4()),',
      '    },',
      '    json={',
      '        "beneficiary_id": "ben_123",',
      '        "recipient_amount": {"currency": "INR", "minor_units": "100000"},',
      '        "purpose_code": "SOFTWARE_SERVICES",',
      '    },',
      ')',
    ].join('\n'),
  },
]

# INRSettle API reference

**Generated** from the route table, the error catalogue and the event allow-list
this service runs on, and from the snippet files the test suite executes. Do not
edit this file — edit the source and run `pnpm run build:api-reference`.
`pnpm run verify` fails if the two disagree.

Base URL: `https://api.inrsettle.com/v1`. The full contract is
`docs/API_CONTRACT.md`; this is the working reference.

## Authentication

```
Authorization: Bearer sk_live_…      → live objects
Authorization: Bearer sk_test_…      → sandbox objects
```

A key is bound to one workspace **and** one environment. A `sk_test_` key
addressing a live object receives `404 not_found`, never `403` — a
wrong-environment key must not confirm that an object exists.

Session cookies are never accepted on this host.

## Versions

Date-based, pinned per workspace, overridable per request:

```
INRSettle-Version: 2026-08-31
```

Published: `2026-08-31`. An unknown version
is a `400`, not a silent fallback to your pin. Additive changes — a new field,
a new event type, a new enum value on an extensible field — ship without a
version bump, so clients must ignore unknown fields and tolerate unknown event
types.

## Endpoints

| Method | Path | Scope | Idempotency-Key |
|---|---|---|---|
| `POST` | `/v1/beneficiaries` | `beneficiary:write` | recommended |
| `GET` | `/v1/beneficiaries` | `beneficiary:read` | — |
| `GET` | `/v1/beneficiaries/:id` | `beneficiary:read` | — |
| `POST` | `/v1/beneficiaries/:id/verify` | `beneficiary:write` | recommended |
| `POST` | `/v1/beneficiaries/:id/disable` | `beneficiary:write` | recommended |
| `POST` | `/v1/quotes` | `settlement:create` | recommended |
| `GET` | `/v1/quotes/:id` | `settlement:read` | — |
| `POST` | `/v1/settlements` | `settlement:create` | **required** |
| `GET` | `/v1/settlements` | `settlement:read` | — |
| `GET` | `/v1/settlements/:id` | `settlement:read` | — |
| `POST` | `/v1/settlements/:id/authorize` | `settlement:authorize` | **required** |
| `POST` | `/v1/settlements/:id/cancel` | `settlement:cancel` | recommended |
| `GET` | `/v1/settlements/:id/receipt` | `settlement:read` | — |
| `GET` | `/v1/settlements/:id/returns` | `settlement:read` | — |
| `GET` | `/v1/settlements/:id/receipt/composite` | `settlement:read` | — |
| `POST` | `/v1/batches` | `batch:write` | recommended |
| `GET` | `/v1/batches/:id` | `batch:read` | — |
| `GET` | `/v1/batches/:id/settlements` | `batch:read` | — |
| `GET` | `/v1/events` | `developer:read` | — |
| `GET` | `/v1/events/:id` | `developer:read` | — |
| `POST` | `/v1/webhook_endpoints` | `webhook:manage` | recommended |
| `GET` | `/v1/webhook_endpoints/:id` | `webhook:manage` | — |
| `DELETE` | `/v1/webhook_endpoints/:id` | `webhook:manage` | — |
| `POST` | `/v1/webhook_endpoints/:id/test` | `webhook:manage` | recommended |

There is deliberately no endpoint to set a status, mark a settlement paid, or
adjust an amount. No principal — yours or ours — can set a settlement to
`settled`: the finality evaluator is the only writer of that transition, and it
evaluates conditions rather than accepting instructions.

## Idempotency

```
Idempotency-Key: <your value, 1–255 printable ASCII, unique per logical operation>
```

- Same key **and** same body → the original response, with `Idempotency-Replayed: true`.
- Same key, **different** body → `409 idempotency_key_reuse`.
- Arriving while the first is still running → `409 idempotency_in_progress`;
  retry with backoff.
- Scoped to workspace, environment and the **concrete request target** — so one
  key reused across two settlements is two claims, never a replay of the first.
- A refused request leaves no claim, so a corrected retry may reuse the key.
- Keys are retained 24 hours.

## Errors

One envelope, everywhere, including `500`s:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "beneficiary_not_verified",
    "message": "Beneficiary bank account needs verification.",
    "detail": "We will send a ₹1 test credit to confirm the account accepts payments.",
    "param": "beneficiary_id",
    "doc_url": "https://docs.inrsettle.com/errors/beneficiary_not_verified",
    "request_id": "req_7Kd2Nx4Pq9Lm"
  }
}
```

| `type` | HTTP |
|---|---|
| `invalid_request_error` | 400 |
| `authentication_error` | 401 |
| `permission_error` | 403 |
| `not_found_error` | 404 |
| `conflict_error` | 409 |
| `rate_limit_error` | 429 |
| `provider_error` | 502 |
| `api_error` | 500 |

`request_id` is on every response, success or failure, and in every log line.
It is the one string to send us.

### Codes

`invalid_body` · `invalid_json` · `duplicate_json_key` · `missing_parameter` · `invalid_parameter` · `unsupported_api_version` · `idempotency_key_required` · `idempotency_key_invalid` · `unknown_event_type` · `missing_authorization` · `malformed_authorization` · `invalid_api_key` · `session_credentials_not_accepted` · `insufficient_scope` · `not_found` · `idempotency_key_reuse` · `idempotency_in_progress` · `invalid_transition` · `past_point_of_no_return` · `beneficiary_not_verified` · `quote_expired` · `receipt_not_ready` · `rate_limit_exceeded` · `provider_unavailable` · `internal_error`

## Creating a settlement

`POST /v1/settlements` returns **`202 Accepted`**, not `201`. Preflight — the
purpose-code and document rules for the amount and corridor — runs
asynchronously, and a request never drives a settlement through more than one
transition.

So the settlement you get back has **`"status": null`**, and that is the only
moment it ever does: null is the absence of a status while preflight decides,
not a sixth status. When preflight finishes the settlement is `ready` or
`action_required`, and it emits `settlement.created` followed by the outcome.

While `status` is null the settlement is **readable by id** — so a client that
has just created one can poll it — and is **not returned by
`GET /v1/settlements`**, so a list never contains an object whose status is
missing.

```json
{
  "id": "stl_2Rn8Kq5TzYw6",
  "object": "settlement",
  "status": null,
  "recipient_amount": {
    "currency": "INR",
    "minor_units": "100000"
  }
}
```

Wait for `settlement.created` on your webhook endpoint, or poll
`GET /v1/settlements/:id` until `status` is non-null. Authorization is
available once it is `ready`.

## Pagination

Cursor-based; offsets do not exist.

```
GET /v1/settlements?limit=25&starting_after=stl_2Rn8Kq5TzYw6
```

`limit` defaults to 25, maximum 100. Filters on settlements: `status` (the
customer-facing values), `beneficiary_id`, `batch_id`, `external_reference`,
`created_at[gte]`, `created_at[lte]`, `has_open_return`,
`has_confirmed_return`.

## Rate limits

Per API key, returned on every response:

```
INRSettle-RateLimit-Limit: 100
INRSettle-RateLimit-Remaining: 87
INRSettle-RateLimit-Reset: 1756636860
```

Reads, writes and batch ingestion draw from separate buckets, so a batch import
cannot exhaust the allowance a dashboard poll needs. `429` carries
`Retry-After` and is always safe to retry with the same idempotency key — a
refused request did nothing.

**Sandbox figures**, per key per minute: reads 100,
writes 50, batch 10.
Live limits are a commercial parameter and are published with your agreement.

## Webhooks

### Event types

`beneficiary.created` · `beneficiary.verified` · `beneficiary.verification_failed` · `settlement.created` · `settlement.ready` · `settlement.action_required` · `settlement.settling` · `settlement.settled` · `settlement.cancelled` · `settlement.cancellation_requested` · `settlement.replacement_created` · `settlement.return_observed` · `settlement.return_confirmed` · `settlement.return_repaid` · `settlement.return_rejected` · `quote.expired` · `batch.validated` · `batch.completed` · `batch.partially_completed` · `receipt.available`

Internal events — liquidity, drawdowns, reservations, provider events,
individual payout attempts — are never delivered, and are not visible on
`/v1/events` either. The internal state machine is not the integration surface.

### Signature

```
INRSettle-Signature: t=1756636800,v1=<hex hmac-sha256 of "{t}.{raw_body}">
```

Three consumer rules, all three implemented by the snippets below:

1. **Compare in constant time.** `==` on a hex digest leaks the answer one byte
   at a time to anyone who can send you requests and time them.
2. **Reject any timestamp outside 300 seconds in *either* direction.**
   A stale timestamp is exactly what a replay looks like, so checking only the
   future side leaves the replay window open forever.
3. **Treat `event.id` as an idempotency key.** Expect redelivery. Events can
   arrive out of order; `created_at` orders them. For anything irreversible on
   your side, re-read the settlement over the API rather than trusting the
   payload.

Secrets rotate with a dual-secret overlap: during the window a delivery is
signed with both, so a verifier that accepts either never drops an event.

### Delivery

Retried with exponential backoff and jitter over about 23.9 hours —
13 retries after the first attempt. An endpoint
that fails 20 deliveries in a row is
circuit-broken and the workspace is notified; every attempt, its response code
and its body stay visible in the event log, with a replay action.

A `2xx` is success. A `408` or `429` is retried, because those are requests
to try again. Any other `4xx` is not retried: it means your endpoint
understood the delivery and refused it.

### Verifying a delivery

These three files are executed by our test suite against the same signer the
service uses. What is published here is what is tested.

#### TypeScript

```ts
// Verifying an INRSettle webhook — TypeScript (Node 18+)
//
// Three rules, and each one is a vulnerability if you skip it:
//
//   1. Compare in constant time. `===` on a hex digest leaks the answer one
//      byte at a time to anyone who can send you requests and time them.
//   2. Reject a timestamp outside five minutes in EITHER direction. A stale
//      timestamp is exactly what a replay looks like; checking only the future
//      side leaves the replay window open forever.
//   3. Treat `event.id` as an idempotency key. Redelivery is expected, not a
//      fault, and events can arrive out of order — `created_at` orders them.
//
// For anything irreversible on your side, re-read the settlement over the API
// rather than trusting the payload alone.

import { createHmac, timingSafeEqual } from 'node:crypto'

const TOLERANCE_SECONDS = 300

export function verifyInrsettleSignature(
  rawBody: string,
  signatureHeader: string,
  secrets: string[], // one, or two during a rotation overlap
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  let timestamp: number | null = null
  const presented: string[] = []

  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value)
    else if (key === 'v1' && /^[0-9a-f]+$/i.test(value)) presented.push(value.toLowerCase())
  }
  if (timestamp === null || presented.length === 0) return false

  // Rule 2 — both directions.
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false

  for (const secret of secrets) {
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')
    for (const candidate of presented) {
      // Rule 1 — constant time.
      const a = Buffer.from(expected, 'utf8')
      const b = Buffer.from(candidate, 'utf8')
      if (a.length === b.length && timingSafeEqual(a, b)) return true
    }
  }
  return false
}

// Express, for example. Note `express.raw`: the signature covers the RAW body,
// so a JSON body-parser that has already re-serialised it will not verify.
//
//   app.post('/webhooks/inrsettle',
//     express.raw({ type: 'application/json' }),
//     (req, res) => {
//       const ok = verifyInrsettleSignature(
//         req.body.toString('utf8'),
//         req.get('INRSettle-Signature') ?? '',
//         [process.env.INRSETTLE_WEBHOOK_SECRET!],
//       )
//       if (!ok) return res.status(400).send('bad signature')
//       const event = JSON.parse(req.body.toString('utf8'))
//       if (alreadyHandled(event.id)) return res.sendStatus(200)  // rule 3
//       handle(event)
//       res.sendStatus(200)
//     })
```

#### Python

```python
# Verifying an INRSettle webhook — Python 3.8+
#
# Three rules, and each one is a vulnerability if you skip it:
#
#   1. Compare in constant time. `==` on a hex digest leaks the answer one byte
#      at a time to anyone who can send you requests and time them.
#   2. Reject a timestamp outside five minutes in EITHER direction. A stale
#      timestamp is exactly what a replay looks like; checking only the future
#      side leaves the replay window open forever.
#   3. Treat event["id"] as an idempotency key. Redelivery is expected, not a
#      fault, and events can arrive out of order — created_at orders them.
#
# For anything irreversible on your side, re-read the settlement over the API
# rather than trusting the payload alone.

import hashlib
import hmac
import time

TOLERANCE_SECONDS = 300


def verify_inrsettle_signature(raw_body, signature_header, secrets, now_seconds=None):
    """raw_body: bytes or str. secrets: one, or two during a rotation overlap."""
    if now_seconds is None:
        now_seconds = int(time.time())
    if isinstance(raw_body, bytes):
        raw_body = raw_body.decode("utf-8")

    timestamp = None
    presented = []
    for part in signature_header.split(","):
        key, _, value = part.partition("=")
        key, value = key.strip(), value.strip()
        if key == "t" and value.isdigit():
            timestamp = int(value)
        elif key == "v1" and all(c in "0123456789abcdefABCDEF" for c in value) and value:
            presented.append(value.lower())

    if timestamp is None or not presented:
        return False

    # Rule 2 — both directions.
    if abs(now_seconds - timestamp) > TOLERANCE_SECONDS:
        return False

    signed_payload = "{}.{}".format(timestamp, raw_body).encode("utf-8")
    for secret in secrets:
        expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
        for candidate in presented:
            # Rule 1 — constant time.
            if hmac.compare_digest(expected, candidate):
                return True
    return False


# Flask, for example. Note request.get_data(): the signature covers the raw body,
# so a JSON parser that has already re-serialised it will not verify.
#
#   @app.post("/webhooks/inrsettle")
#   def inrsettle_webhook():
#       ok = verify_inrsettle_signature(
#           request.get_data(),
#           request.headers.get("INRSettle-Signature", ""),
#           [os.environ["INRSETTLE_WEBHOOK_SECRET"]],
#       )
#       if not ok:
#           return "bad signature", 400
#       event = request.get_json()
#       if already_handled(event["id"]):   # rule 3
#           return "", 200
#       handle(event)
#       return "", 200
```

#### Go

```go
// Verifying an INRSettle webhook — Go 1.20+
//
// Three rules, and each one is a vulnerability if you skip it:
//
//	1. Compare in constant time. == on a hex digest leaks the answer one byte
//	   at a time to anyone who can send you requests and time them.
//	2. Reject a timestamp outside five minutes in EITHER direction. A stale
//	   timestamp is exactly what a replay looks like; checking only the future
//	   side leaves the replay window open forever.
//	3. Treat event.id as an idempotency key. Redelivery is expected, not a
//	   fault, and events can arrive out of order — created_at orders them.
//
// For anything irreversible on your side, re-read the settlement over the API
// rather than trusting the payload alone.

package inrsettle

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

const ToleranceSeconds = 300

// VerifySignature reports whether the delivery is authentic.
// secrets holds one secret, or two during a rotation overlap.
func VerifySignature(rawBody string, signatureHeader string, secrets []string, nowSeconds int64) bool {
	if nowSeconds == 0 {
		nowSeconds = time.Now().Unix()
	}

	var timestamp int64 = -1
	presented := []string{}

	for _, part := range strings.Split(signatureHeader, ",") {
		key, value, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch key {
		case "t":
			if n, err := strconv.ParseInt(value, 10, 64); err == nil {
				timestamp = n
			}
		case "v1":
			if _, err := hex.DecodeString(value); err == nil && value != "" {
				presented = append(presented, strings.ToLower(value))
			}
		}
	}
	if timestamp < 0 || len(presented) == 0 {
		return false
	}

	// Rule 2 — both directions.
	drift := nowSeconds - timestamp
	if drift < 0 {
		drift = -drift
	}
	if drift > ToleranceSeconds {
		return false
	}

	signedPayload := strconv.FormatInt(timestamp, 10) + "." + rawBody
	for _, secret := range secrets {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(signedPayload))
		expected := hex.EncodeToString(mac.Sum(nil))
		for _, candidate := range presented {
			// Rule 1 — constant time.
			if hmac.Equal([]byte(expected), []byte(candidate)) {
				return true
			}
		}
	}
	return false
}

// net/http, for example. Read the body BEFORE decoding it: the signature covers
// the raw body bytes, so a decoder that has re-serialised them will not verify.
//
//	func handler(w http.ResponseWriter, r *http.Request) {
//		body, _ := io.ReadAll(r.Body)
//		if !VerifySignature(string(body), r.Header.Get("INRSettle-Signature"),
//			[]string{os.Getenv("INRSETTLE_WEBHOOK_SECRET")}, 0) {
//			http.Error(w, "bad signature", http.StatusBadRequest)
//			return
//		}
//		var event Event
//		json.Unmarshal(body, &event)
//		if alreadyHandled(event.ID) { // rule 3
//			w.WriteHeader(http.StatusOK)
//			return
//		}
//		handle(event)
//		w.WriteHeader(http.StatusOK)
//	}
```

## Worked example

#### curl

```bash
#!/usr/bin/env bash
# The worked flow from API_CONTRACT.md § 9, end to end, in curl.
#
# Every value below is a sandbox value. `sk_test_` keys address sandbox objects
# and cannot address live ones — a live id under a sandbox key is a 404, never a
# 403, because a wrong-environment key must not confirm that an object exists.
set -euo pipefail

: "${INRSETTLE_KEY:?export INRSETTLE_KEY=sk_test_...}"
API="https://api.inrsettle.com/v1"

# 1 — quote, recipient-first. You say what the beneficiary receives; the funding
#     side is derived, and every fee is itemised rather than folded into the rate.
curl -sS -X POST "$API/quotes" \
  -H "Authorization: Bearer $INRSETTLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "direction": "recipient_first",
        "recipient_amount": { "currency": "INR", "minor_units": "500000000" },
        "funding_currency": "USDT",
        "beneficiary_id": "ben_7Ld2ZxKp0Wq4"
      }'

# 2 — settlement. The Idempotency-Key is required here, and it is what makes a
#     retry safe: same key and same body replays the original response, same key
#     and a different body is a 409.
#
#     This returns 202, not 201, and the settlement comes back with
#     "status": null — preflight runs asynchronously, and null is the absence of
#     a status while it decides rather than a sixth one.
curl -sS -X POST "$API/settlements" \
  -H "Authorization: Bearer $INRSETTLE_KEY" \
  -H "Idempotency-Key: 6f2c1a90-contractor-sept-0142" \
  -H "Content-Type: application/json" \
  -d '{
        "beneficiary_id": "ben_7Ld2ZxKp0Wq4",
        "recipient_amount": { "currency": "INR", "minor_units": "500000000" },
        "purpose_code": "SOFTWARE_SERVICES",
        "funding_currency": "USDT",
        "quote_id": "qt_9Xm4Bv7NsLt2",
        "external_reference": "INVOICE-2026-0914"
      }'

# 3 — wait for preflight. Poll until `status` is non-null, or subscribe to
#     settlement.created and skip the polling. `ready` means authorize now;
#     `action_required` means `requirements` says what is missing.
until [ "$(curl -sS "$API/settlements/stl_2Rn8Kq5TzYw6" \
             -H "Authorization: Bearer $INRSETTLE_KEY" \
           | sed -n 's/.*"status":[ ]*"\([a-z_]*\)".*/\1/p')" = "ready" ]; do
  sleep 1
done

# 4 — authorize. This freezes the instruction; it does not make execution
#     irreversible. The settlement stays cancellable while `cancellable` is true.
curl -sS -X POST "$API/settlements/stl_2Rn8Kq5TzYw6/authorize" \
  -H "Authorization: Bearer $INRSETTLE_KEY" \
  -H "Idempotency-Key: 6f2c1a90-contractor-sept-0142-auth"

# 5 — receipt, once settled. 404 until then: a receipt that does not exist yet
#     is not an empty receipt.
curl -sS "$API/settlements/stl_2Rn8Kq5TzYw6/receipt" \
  -H "Authorization: Bearer $INRSETTLE_KEY"
```

#### TypeScript

```ts
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
```

#### Python

```python
# The worked flow from API_CONTRACT.md § 9, end to end, in Python.
#
# minor_units is a string on the way in and on the way out. Python integers
# would survive the round trip, but the string is what the contract sends, and
# parsing it as one keeps your code correct against clients that would not.

import json
import os
import time
import urllib.request

API = "https://api.inrsettle.com/v1"
KEY = os.environ["INRSETTLE_KEY"]  # sk_test_... for sandbox


def call(method, path, body=None, idempotency_key=None):
    headers = {
        "Authorization": "Bearer " + KEY,
        "Content-Type": "application/json",
    }
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key

    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as e:
        error = json.loads(e.read())["error"]
        # Every error carries a code you can branch on, a message you can show,
        # and a request_id worth sending us.
        raise RuntimeError("{type}/{code}: {message} {detail} ({request_id})".format(
            detail=error.get("detail", ""), **{
                k: error[k] for k in ("type", "code", "message", "request_id")
            }))


def settle_five_million_rupees(beneficiary_id):
    quote = call("POST", "/quotes", {
        "direction": "recipient_first",
        "recipient_amount": {"currency": "INR", "minor_units": "500000000"},
        "funding_currency": "USDT",
        "beneficiary_id": beneficiary_id,
    })

    # One key per logical operation, reused on every retry of that operation.
    key = "contractor-sept-0142"

    # 202, not 201: preflight runs asynchronously, so "status" comes back None.
    # None is the absence of a status while preflight decides, not a sixth one.
    settlement = call("POST", "/settlements", {
        "beneficiary_id": beneficiary_id,
        "recipient_amount": {"currency": "INR", "minor_units": "500000000"},
        "purpose_code": "SOFTWARE_SERVICES",
        "funding_currency": "USDT",
        "quote_id": quote["id"],
        "external_reference": "INVOICE-2026-0914",
    }, idempotency_key=key)

    # In production, subscribe to settlement.created rather than polling. This
    # is the polling form because an example that opens a webhook receiver
    # first is an example nobody can run.
    status = settlement["status"]
    while status is None:
        time.sleep(1)
        status = call("GET", "/settlements/" + settlement["id"])["status"]

    # "action_required" is not a failure — "requirements" says what is missing,
    # and the settlement waits. Authorizing it now would be a 409.
    if status != "ready":
        return settlement["id"]

    call("POST", "/settlements/{}/authorize".format(settlement["id"]),
         idempotency_key=key + "-auth")

    # "settled" does not mean "and it will stay that way": a credited payout can
    # still be returned. Subscribe to settlement.return_confirmed, or filter
    # with ?has_confirmed_return=true.
    return settlement["id"]
```

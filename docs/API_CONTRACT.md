# API_CONTRACT.md

Status: **Stage 0 — Revision 7 · FROZEN 2026-09-05 · `POST /v1/settlements` is `202` with a null status until preflight completes (Stage 8 review)**
Depends on: `DOMAIN.md`, `STATE_MACHINES.md`, `SECURITY.md`

---

## 1. Principles

1. Small surface. Five primitives: `Beneficiary`, `Quote`, `Settlement`,
   `Batch`, `SettlementReceipt`. Everything else is a sub-resource or an event.
2. Resource-oriented, predictable URLs. No RPC verbs except where an operation
   genuinely is one (`/authorize`, `/cancel`, `/verify`).
3. Safe to retry. Every mutating call is idempotent by key.
4. The error copy rule from `PRODUCT.md § 7.1` applies to the API. An API error
   is as specific and as actionable as the screen.
5. Nothing in the API can shortcut finality. There is no endpoint that sets a
   settlement to `settled`.

## 2. Base, versioning, authentication

```
https://api.inrsettle.com/v1
```

Version pinning is date-based and per workspace, overridable per request:

```
INRSettle-Version: 2026-08-31
```

Authentication is a bearer API key, environment-bound:

```
Authorization: Bearer sk_live_…      → live objects
Authorization: Bearer sk_test_…      → sandbox objects
```

A key addressing an object from the other environment receives `404 not_found`,
never `403` — a wrong-environment key must not confirm that an object exists
(`SECURITY.md § 3.3`).

Session cookies are never accepted by the API host.

## 3. Representations

### 3.1 Money

Money is always an object, never a bare number (`INV-04`). `minor_units` is a
**string** so values above 2^53 survive JavaScript clients.

```json
{
  "currency": "INR",
  "minor_units": "500000000",
  "scale": 2,
  "display": "₹5,000,000.00"
}
```

`scale` is echoed so a client never has to guess. `display` is for rendering
only and must never be parsed. Digit grouping in `display` follows the
workspace's `number_format` setting: `international` (default, `₹5,000,000.00`)
or `indian` (`₹50,00,000.00`).

### 3.2 FX rate

```json
{
  "pair": "USDT/INR",
  "rate": "88.4210000000",
  "scale": 10,
  "quoted_at": "2026-08-31T09:14:02Z"
}
```

`rate` is a decimal **string**. It is INR per one unit of the left-hand currency.

### 3.3 Timestamps

RFC 3339, always UTC, always `Z`, always suffixed `_at`.

### 3.4 Nesting

There is no `expand` parameter. Objects that are useful together embed a compact
summary — a settlement always carries `beneficiary` as `{id, display_name,
destination_summary, verification_status}`. Anything larger requires its own
request. This keeps responses predictable in size and cost.

## 4. Idempotency

```
Idempotency-Key: <client-generated, ≤255 chars, unique per logical operation>
```

- **Required** on `POST /v1/settlements` and `POST
  /v1/settlements/{id}/authorize`. Recommended on every other `POST`.
- Scoped to workspace + environment + endpoint. Keys are retained 24 hours.
- A replay with the same key **and** the same body returns the original response
  with `Idempotency-Replayed: true`.
- A replay with the same key and a **different** body returns `409
  idempotency_key_reuse`. It does not silently do either thing.
- A request that arrives while the first is still in flight returns `409
  idempotency_in_progress`; the client retries with backoff.

## 5. Errors

One envelope, everywhere, including `500`s.

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

| `type` | HTTP | Meaning |
|---|---|---|
| `invalid_request_error` | 400 | Malformed or semantically invalid input |
| `authentication_error` | 401 | Missing, malformed or revoked key |
| `permission_error` | 403 | Authenticated but lacking the scope |
| `not_found_error` | 404 | No such object in this workspace and environment |
| `conflict_error` | 409 | Idempotency conflict, or state-machine guard refused |
| `rate_limit_error` | 429 | Over the key's limit; `Retry-After` is set |
| `provider_error` | 502 | An upstream provider failed; safe to retry with the same key |
| `api_error` | 500 | Our fault. `request_id` is the thing to send us. |

`code` values are stable and enumerated in the reference. A state-machine
rejection surfaces as `409` with `code: "invalid_transition"` and a `detail`
naming the current and attempted states. A cancellation arriving after payout
submission has been attempted surfaces as `409` with
`code: "past_point_of_no_return"`.

`request_id` is on every response, success or failure, and in every log line.

## 6. Pagination

Cursor-based. Offsets do not exist.

```
GET /v1/settlements?limit=25&starting_after=stl_2Rn8Kq5TzYw6
```

```json
{
  "object": "list",
  "data": [ … ],
  "has_more": true,
  "next_cursor": "stl_9Xm4Bv7NsLt2"
}
```

`limit` defaults to 25, maximum 100. Filters on settlements: `status`
(customer-facing values), `beneficiary_id`, `batch_id`, `external_reference`,
`created_at[gte]`, `created_at[lte]`.

## 7. Resources

### 7.1 Beneficiary

```json
{
  "id": "ben_7Ld2ZxKp0Wq4",
  "object": "beneficiary",
  "environment": "sandbox",
  "display_name": "Priya Technologies Pvt Ltd",
  "legal_name": "Priya Technologies Private Limited",
  "type": "business",
  "country": "IN",
  "status": "verified",
  "destination": {
    "id": "dst_4Nc8Rw2QhVe6",
    "current_version_id": "dvr_6Jk1Ps8YvCn3",
    "version_number": 3,
    "kind": "bank_account",
    "account_number_last4": "4417",
    "ifsc": "HDFC0001234",
    "account_type": "current",
    "account_holder_name": "Priya Technologies Private Limited",
    "verification_status": "verified",
    "verified_at": "2026-08-29T11:02:44Z"
  },
  "settlement_summary": {
    "count": 12,
    "total_settled": { "currency": "INR", "minor_units": "4820000000", "scale": 2, "display": "₹48,200,000.00" },
    "last_settled_at": "2026-08-28T06:31:09Z"
  },
  "created_at": "2026-07-14T08:20:00Z"
}
```

Full account numbers are never returned by any endpoint (`INV-12`).

Editing a destination creates a **new version** rather than mutating the current
one (`INV-44`). The new version starts unverified; earlier versions keep their
verification and remain what any already-authorized settlement pays (`INV-45`).
This is why `PATCH` on a destination returns a new `current_version_id` and does
not silently invalidate in-flight settlements.

### 7.2 Quote

```json
{
  "id": "qt_9Xm4Bv7NsLt2",
  "object": "quote",
  "direction": "recipient_first",
  "recipient_amount": { "currency": "INR", "minor_units": "500000000", "scale": 2, "display": "₹5,000,000.00" },
  "funding_amount":   { "currency": "USDT", "minor_units": "56547652707", "scale": 6, "display": "56,547.652707 USDT" },
  "fx_rate": { "pair": "USDT/INR", "rate": "88.4210000000", "scale": 10, "quoted_at": "2026-08-31T09:14:02Z" },
  "fees": [
    { "code": "settlement_fee", "label": "Settlement fee",
      "amount": { "currency": "USDT", "minor_units": "56547653", "scale": 6, "display": "56.547653 USDT" } }
  ],
  "rounding_residual": { "currency": "USDT", "amount": "0.000000063865", "scale": 12 },
  "estimated_delivery": "under_30_minutes",
  "status": "active",
  "expires_at": "2026-08-31T09:29:02Z",
  "created_at": "2026-08-31T09:14:02Z"
}
```

The figures reconcile exactly under the rule in `DOMAIN.md § 3.3`:
`5,000,000.00 INR ÷ 88.4210000000 = 56,547.652706936… USDT`, charged as
`56,547.652707 USDT` (ceiling), leaving the disclosed residual.

The fee shown is 10 bps of the funding amount. **That number is an illustrative
sandbox figure, not a price.** `D-09a` is closed — a fee is always an explicit,
itemised component and is never folded into the rate (`INV-07`), which is what
makes the reconciliation above checkable — but the fee *level and model* are
`D-09b`, an externally configured commercial parameter pending real partner
evidence. Any figure in this document is an example of the shape, and no
integrator should read a price out of it.

`rounding_residual` is an **`ExactAmount`**, not a `Money`: by construction it is
smaller than one minor unit, so it carries an exact decimal string at scale 12.
It is the only field in the API that uses this shape.

### 7.3 Settlement

```json
{
  "id": "stl_2Rn8Kq5TzYw6",
  "object": "settlement",
  "environment": "sandbox",
  "status": "settling",
  "beneficiary": {
    "id": "ben_7Ld2ZxKp0Wq4",
    "display_name": "Priya Technologies Pvt Ltd",
    "destination_id": "dst_4Nc8Rw2QhVe6",
    "destination_version_id": "dvr_6Jk1Ps8YvCn3",
    "destination_summary": "HDFC •••• 4417",
    "destination_is_frozen": true,
    "verification_status": "verified"
  },
  "authorized_terms": {
    "quote_id": "qt_9Xm4Bv7NsLt2",
    "recipient_amount": { "currency": "INR", "minor_units": "500000000", "scale": 2, "display": "₹5,000,000.00" },
    "funding_amount":   { "currency": "USDT", "minor_units": "56547652707", "scale": 6, "display": "56,547.652707 USDT" },
    "fx_rate": { "pair": "USDT/INR", "rate": "88.4210000000", "scale": 10, "quoted_at": "2026-08-31T09:14:02Z" },
    "hash": "sha256:9f2c…"
  },
  "recipient_amount": { "currency": "INR", "minor_units": "500000000", "scale": 2, "display": "₹5,000,000.00" },
  "delivered_amount": null,
  "funding_currency": "USDT",
  "purpose": { "code": "software_services", "label": "Software services" },
  "external_reference": "INVOICE-2026-0914",
  "quote_id": "qt_9Xm4Bv7NsLt2",
  "batch_id": null,
  "requirements": [],
  "progress": [
    { "step": "ready",              "label": "Settlement ready",   "at": "2026-08-31T09:14:40Z" },
    { "step": "liquidity_secured",  "label": "Liquidity secured",  "at": "2026-08-31T09:14:43Z" },
    { "step": "payout_confirmed",   "label": "INR payout confirmed", "at": null },
    { "step": "reconciled",         "label": "Reconciled",         "at": null }
  ],
  "payout_reference": null,
  "receipt_id": null,
  "cancellable": true,
  "point_of_no_return_at": null,
  "cancellation_requested_at": null,
  "returns": [],
  "replaces_settlement_id": null,
  "replaced_by": null,
  "authorized_at": "2026-08-31T09:14:41Z",
  "settled_at": null,
  "created_at": "2026-08-31T09:12:18Z"
}
```

`status` is the **customer-facing** value: `ready`, `settling`, `settled`,
`action_required`, `cancelled`. Internal states are not exposed by the public
API (`STATE_MACHINES.md § 5`); `progress` is how technical detail is offered,
already in customer language.

`status` is **`null` between creation and the end of preflight**, and only then.
That is the absence of a status rather than a sixth one: preflight decides
between `ready` and `action_required`, and until it has run neither is true. The
five values remain the complete set of statuses a settlement can hold, and no
internal state is ever exposed in their place.

A settlement with `status: null` is **not returned by `GET /v1/settlements`**,
for the same reason it has no status: it has not entered the customer-visible
lifecycle. It is readable by id, so a client that has just created one can poll
it. Preflight normally completes in under a second; the two ways to learn the
outcome without polling are `settlement.ready` and `settlement.action_required`,
which is what those events are for.

**Once a settlement is authorized, `beneficiary.destination_summary` and every
other payout detail render the *frozen* destination version, not the
beneficiary's current one, and `destination_is_frozen` is `true`.** Editing the
destination afterwards appends a new version and changes nothing about this
settlement — not what it pays, and not what this endpoint shows.
`authorized_terms` is the by-value economic commitment captured at authorization;
its `hash` is what the finality evaluator compares against.

`replaces_settlement_id` is a stored, forward-only field on a replacement
settlement. `replaced_by` is **derived** — the API computes it from the index on
`replaces_settlement_id`, because the replaced settlement is terminal and is
never written to (`INV-38`). Clients should treat `replaced_by` as read-only and
must not expect to set it.

### 7.3.1 Authorization, cancellation and the point of no return

`authorize` freezes the instruction — beneficiary, destination, amount, purpose
and funding currency can no longer change (`INV-16`). It does **not** make
execution irreversible. The settlement stays cancellable until
`point_of_no_return_at` is stamped, which happens when INRSettle attempts payout
submission (`INV-36`).

- `cancellable` is `true` while `point_of_no_return_at` is `null` and the status
  is not terminal. Clients should drive their cancel affordance from this field
  rather than inferring it from `status`.
- `POST /v1/settlements/{id}/cancel` before authorization cancels immediately.
- After authorization it registers a **cancellation request**
  (`cancellation_requested_at` is set, `202 Accepted`). The request is honoured
  at the next safe checkpoint, with compensation — releasing a reservation, or
  reversing a confirmed drawdown. It is deliberately not immediate: a
  cancellation must never race an in-flight provider call.
- After the point of no return it returns `409` with
  `code: "past_point_of_no_return"` and a `detail` naming
  `point_of_no_return_at`. This is the honest answer, and it is why the field is
  exposed.

A cancelled settlement carries `resolution`:

```json
"status": "cancelled",
"resolution": {
  "code": "cancelled_by_customer",
  "message": "Cancelled before execution — reserved liquidity released."
}
```

### 7.4 Requirements

Every requirement carries a machine code, a human title, context, and one named
action (`PRODUCT.md § 7.1`).

```json
"requirements": [
  {
    "code": "invoice_required",
    "severity": "blocking",
    "title": "Invoice is required for this settlement",
    "detail": "Settlements over ₹1,000,000 for software services need a commercial invoice.",
    "action": { "type": "upload_document", "document_type": "commercial_invoice" }
  },
  {
    "code": "beneficiary_account_unverified",
    "severity": "blocking",
    "title": "Beneficiary bank account needs verification",
    "detail": "We will send a ₹1 test credit to confirm the account accepts payments.",
    "action": { "type": "verify_beneficiary", "beneficiary_id": "ben_7Ld2ZxKp0Wq4" }
  }
]
```

There is no generic `validation_failed` requirement. If a rule cannot produce all
four fields, the rule does not ship.

### 7.5 Settlement return

A credited payout that is later returned does **not** change the settlement. The
settlement stays `settled`, because it was; the return is a separate linked
object with its own lifecycle (`STATE_MACHINES.md § 8.4`).

```json
{
  "id": "ret_2Bf9Qm5XkWd7",
  "object": "settlement_return",
  "settlement_id": "stl_2Rn8Kq5TzYw6",
  "status": "confirmed",
  "amount": { "currency": "INR", "minor_units": "500000000", "scale": 2, "display": "₹5,000,000.00" },
  "reason_code": "account_closed",
  "reason_message": "The beneficiary's bank returned the credit: account closed.",
  "observed_at": "2026-08-31T14:02:10Z",
  "confirmed_at": "2026-08-31T14:19:44Z",
  "repaid_at": null
}
```

`status` is one of `observed`, `confirmed`, `repaid`, `rejected`,
`manual_review`. A return may be partial, and one settlement may have several.

Because the settlement's own `status` stays `settled`, integrations must not
treat `settled` alone as "money is with the beneficiary and will stay there".
Two supported ways to handle this correctly:

- filter with `?has_open_return=true` or `?has_confirmed_return=true` on
  `GET /v1/settlements`; or
- subscribe to `settlement.return_confirmed` and reconcile on that event.

The `returns` array on the settlement object carries a compact summary of each.

### 7.6 Settlement receipt

Returned by `GET /v1/settlements/{id}/receipt`. Includes everything in
`DOMAIN.md § 6.9` plus `content_hash`, and links to the PDF by short-lived
presigned URL.

**The receipt is a write-once artifact.** Its fields, its `content_hash` and the
bytes of its PDF never change, no matter what happens afterwards (`INV-48`).

If a return exists, the receipt **links** separate Return Notice artifacts; it
does not absorb them:

```json
"content_hash": "sha256:4b1e…",
"pdf_url": "https://…/receipts/rcp_8Wq3Fn6MbZk1.pdf",
"return_notices": [
  {
    "id": "rnt_9Ax4Tg7WqMe2",
    "return_id": "ret_2Bf9Qm5XkWd7",
    "content_hash": "sha256:c07a…",
    "pdf_url": "https://…/notices/rnt_9Ax4Tg7WqMe2.pdf",
    "created_at": "2026-08-31T14:19:44Z"
  }
]
```

Each notice is its own immutable artifact with its own hash and its own
write-once PDF. Clients that need one document may request the optional
composite:

`GET /v1/settlements/{id}/receipt/composite` → a **third** artifact rendering the
receipt and its notices together, with its own `content_hash`. It replaces
neither source, and the receipt's hash and PDF are unaffected by its existence.

## 8. Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/beneficiaries` | Creates and starts verification |
| `GET` | `/v1/beneficiaries` | List, cursor-paginated |
| `GET` | `/v1/beneficiaries/{id}` | |
| `POST` | `/v1/beneficiaries/{id}/verify` | Re-run verification |
| `POST` | `/v1/beneficiaries/{id}/disable` | Soft, reversible; never deletes history |
| `POST` | `/v1/quotes` | Recipient-first by default |
| `GET` | `/v1/quotes/{id}` | |
| `POST` | `/v1/settlements` | Requires `Idempotency-Key`. Returns `202 Accepted`; preflight runs asynchronously and the settlement's `status` is `null` until it finishes. |
| `GET` | `/v1/settlements` | Filterable, cursor-paginated |
| `GET` | `/v1/settlements/{id}` | |
| `POST` | `/v1/settlements/{id}/authorize` | Requires `Idempotency-Key` and the `settlement:authorize` scope. Freezes the instruction; does not end cancellability. |
| `POST` | `/v1/settlements/{id}/cancel` | Immediate before authorization; a cancellation request after it; `409 past_point_of_no_return` once payout submission has been attempted |
| `GET` | `/v1/settlements/{id}/receipt` | `404` until `settled` |
| `GET` | `/v1/settlements/{id}/returns` | Post-settlement returns, if any |
| `GET` | `/v1/settlements/{id}/receipt/composite` | Optional composite export of the receipt plus its return notices, as a new artifact |
| `POST` | `/v1/batches` | JSON rows or a CSV upload reference |
| `GET` | `/v1/batches/{id}` | Aggregate counts and totals |
| `GET` | `/v1/batches/{id}/settlements` | The independent rows |
| `GET` | `/v1/events` | Every event the workspace can see |
| `GET` | `/v1/events/{id}` | |
| `POST` | `/v1/webhook_endpoints` | |
| `GET`/`DELETE` | `/v1/webhook_endpoints/{id}` | |
| `POST` | `/v1/webhook_endpoints/{id}/test` | Sends a signed test event |

There is deliberately no endpoint to set a status, mark a settlement paid, or
adjust an amount.

## 9. Worked flow

```bash
# 1 — quote, recipient-first
curl -X POST https://api.inrsettle.com/v1/quotes \
  -H "Authorization: Bearer sk_test_…" \
  -H "Content-Type: application/json" \
  -d '{
        "direction": "recipient_first",
        "recipient_amount": { "currency": "INR", "minor_units": "500000000" },
        "funding_currency": "USDT",
        "beneficiary_id": "ben_7Ld2ZxKp0Wq4"
      }'

# 2 — settlement
curl -X POST https://api.inrsettle.com/v1/settlements \
  -H "Authorization: Bearer sk_test_…" \
  -H "Idempotency-Key: 6f2c1a90-contractor-sept-0142" \
  -H "Content-Type: application/json" \
  -d '{
        "beneficiary_id": "ben_7Ld2ZxKp0Wq4",
        "recipient_amount": { "currency": "INR", "minor_units": "500000000" },
        "purpose_code": "software_services",
        "funding_currency": "USDT",
        "quote_id": "qt_9Xm4Bv7NsLt2",
        "external_reference": "INVOICE-2026-0914"
      }'
# → 202, status null. Preflight runs asynchronously (ARCHITECTURE.md § 3: a
#   request never drives a settlement through more than one transition), so the
#   status arrives with settlement.ready or settlement.action_required — or on
#   the next GET, normally within a second.

# 3 — authorize (freezes the instruction; still cancellable until payout submission)
curl -X POST https://api.inrsettle.com/v1/settlements/stl_2Rn8Kq5TzYw6/authorize \
  -H "Authorization: Bearer sk_test_…" \
  -H "Idempotency-Key: 6f2c1a90-contractor-sept-0142-auth"
# → 200, status "settling"

# 4 — receipt, once settled
curl https://api.inrsettle.com/v1/settlements/stl_2Rn8Kq5TzYw6/receipt \
  -H "Authorization: Bearer sk_test_…"
```

## 10. Webhooks

### 10.1 Envelope

```json
{
  "id": "evt_5Md8Yn3CwPj2",
  "object": "event",
  "type": "settlement.settled",
  "api_version": "2026-08-31",
  "environment": "sandbox",
  "workspace_id": "ws_3kQ8xR2mVnPq",
  "created_at": "2026-08-31T09:17:55Z",
  "data": { "object": { "…": "the full settlement object" } }
}
```

### 10.2 Customer-visible event types

```
beneficiary.created            beneficiary.verified
beneficiary.verification_failed

settlement.created             settlement.ready
settlement.action_required     settlement.settling
settlement.settled             settlement.cancelled
settlement.cancellation_requested

settlement.replacement_created

settlement.return_observed     settlement.return_confirmed
settlement.return_repaid       settlement.return_rejected

quote.expired

batch.validated                batch.completed
batch.partially_completed

receipt.available
```

Internal events — liquidity, drawdowns, reservations, provider events, individual
payout attempts — are never delivered to customer endpoints. The internal state
machine is not the integration surface.

### 10.3 Signature and delivery

```
INRSettle-Signature: t=1756636800,v1=<hex hmac-sha256 of "{t}.{raw_body}">
```

Documented consumer rules, with copyable verification code in three languages:

- Compare in **constant time**.
- **Reject any timestamp outside a five-minute tolerance in *either* direction** —
  `|now − t| > 300s` fails. Rejecting only future-dated timestamps leaves the
  replay window open: an attacker who captures a valid signed request can resend
  it indefinitely, because a stale `t` is exactly what a replay looks like. A
  future-dated `t` beyond tolerance is equally invalid and usually means clock
  skew or forgery.
- Treat `event.id` as an idempotency key; **expect redelivery**.
- Events can arrive out of order; `created_at` orders them.
- For anything irreversible on your side, re-read the settlement over the API
  rather than trusting the payload alone.

Delivery: retried with exponential backoff and jitter for about 24 hours; a
consistently failing endpoint is circuit-broken and the workspace is notified.
Every attempt, its response code and its body are visible in Developers → Event
logs, with a replay action.

## 11. Rate limits

Per API key, published in the reference, returned on every response:

```
INRSettle-RateLimit-Limit: 100
INRSettle-RateLimit-Remaining: 87
INRSettle-RateLimit-Reset: 1756636860
```

Reads and writes have separate buckets. Batch ingestion has its own. `429`
carries `Retry-After` and is always safe to retry with the same idempotency key.

## 12. Change policy

- Additive changes — a new field, a new event type, a new enum value on a field
  documented as extensible — ship without a version bump. Clients must ignore
  unknown fields and tolerate unknown event types.
- Anything else is a new dated version. Workspaces stay pinned until they
  upgrade deliberately.
- Removing a field, changing a type, or narrowing an enum requires a version,
  a migration guide, and a deprecation period. Money representation and the
  five customer-facing statuses are treated as frozen for the life of `/v1`.

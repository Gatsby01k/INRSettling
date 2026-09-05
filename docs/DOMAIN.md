# DOMAIN.md

Status: **Stage 0 — Revision 3 · FROZEN 2026-08-31 · awaiting sign-off**
Reading order: read `PRODUCT.md` first. `STATE_MACHINES.md` formalises the
transitions referenced here.

---

## 1. Purpose of this document

This document defines the domain model: the objects, the language, the money
primitive, and the invariants that must hold no matter what any UI, endpoint,
job or operator does. Everything here is enforced in a domain layer that is
independent of React, of route handlers and of any provider SDK.

Invariants are numbered (`INV-nn`) so that each one maps to at least one test.
The numbers are stable identifiers, not a reading order — later revisions add
invariants where they belong rather than renumbering existing ones.

## 2. Ubiquitous language

| Term | Meaning | Customer-visible |
|---|---|---|
| **Workspace** | One customer organisation and its isolation boundary | yes |
| **Environment** | `sandbox` or `live`. Fully separate data, keys and providers | yes |
| **Beneficiary** | A verified party in India that can receive INR | yes |
| **Payout destination** | The stable identity of a rails-level destination on a beneficiary | partly |
| **Destination version** | The immutable snapshot of payout details that money is actually sent to | partly |
| **Authorized commitment** | The destination version and economic terms frozen onto a settlement at authorization | as the confirmed figures |
| **Settlement** | One instruction to deliver an exact INR amount to one beneficiary | yes |
| **Quote** | A priced, time-bounded offer to fund a settlement | yes |
| **Preflight** | Deterministic requirement discovery before authorization | as READY / ACTION REQUIRED |
| **Requirement** | One named, resolvable thing blocking or informing a settlement | yes |
| **Authorization** | The customer's approval of the instruction, which freezes it and permits execution to begin | as the Settle button |
| **Point of no return** | The instant payout submission is attempted. Cancellation is refused past it. | as the cancel action disappearing |
| **Cancellation window** | Between authorization and the point of no return, where a cancellation request is still honourable | as a cancel action |
| **Liquidity facility** | An external revolving prefunding facility | no |
| **Reservation** | An atomic hold on facility availability for one settlement | no |
| **Drawdown** | Funds actually drawn from the facility to fund a payout | no |
| **Repayment** | Funds returned to the facility | no |
| **Payout** | The rails-level INR execution performed by a payout provider | partly |
| **UTR** | Unique Transaction Reference issued by the Indian banking system | yes |
| **Reconciliation** | Comparison of expected outcome against authoritative observation | as one line |
| **Finality** | The evaluated conjunction of conditions that permits SETTLED | as SETTLED |
| **Settlement receipt** | The one canonical record of a settled settlement | yes |
| **Settlement return** | A later, linked record that a credited payout was returned. Never a change to the settlement. | yes |
| **Replacement settlement** | A new settlement created because a frozen instruction could not be corrected in place | yes |
| **Batch** | A container of independent settlements created together | yes |
| **Exception** | A stalled settlement requiring operator or customer resolution | as ACTION REQUIRED or a delay note |
| **Provider event** | A raw, persisted, immutable message received from a provider | no |

## 3. Money

Money is the highest-risk primitive in the system. It gets its own section
before any aggregate, and its rules are absolute.

### 3.1 Representation

```ts
type CurrencyCode = 'INR' | 'USD' | 'USDT' | 'USDC' | 'EUR' | 'GBP' | 'AED' | 'SGD'

interface Money {
  readonly currency: CurrencyCode
  readonly minorUnits: bigint     // exact, never a JS number
}
```

Scale is a property of the currency, held in a single versioned registry — never
passed around loose, never inferred:

| Currency | Scale | 1 major unit = |
|---|---|---|
| INR | 2 | 100 paise |
| USD, EUR, GBP, AED, SGD | 2 | 100 cents |
| USDT, USDC | 6 | 1,000,000 base units |

**INV-01** — No monetary value is ever represented as a floating-point number,
anywhere: not in the domain, not in the database, not in JSON, not in a log line,
not in a CSV parser, not in a chart.

**INV-02** — Every persisted monetary value is stored as two columns:
`*_minor BIGINT NOT NULL` and `*_currency TEXT NOT NULL`. There is no
`DECIMAL`, `REAL` or `NUMERIC` money column and no bare amount column without
its currency beside it.

**INV-03** — Arithmetic between two `Money` values of different currencies is a
compile-time-and-runtime error. Conversion happens only through an `FxRate`
applied by the quote engine.

**INV-04** — JSON representations of money are objects, never bare numbers, and
`minor_units` is a **string** so that values above 2^53 survive JavaScript
clients intact. See `API_CONTRACT.md § Money`.

### 3.2 FX rate

```ts
interface FxRate {
  readonly pair: `${CurrencyCode}/${CurrencyCode}`  // e.g. 'USDT/INR'
  readonly rate: Decimal   // INR per 1 unit of the left-hand currency
  readonly scale: 10       // fixed
  readonly quotedAt: Instant
  readonly source: string  // provider identifier, internal only
}
```

Stored as `NUMERIC(28,10)`. `USDT/INR = 88.4210000000` means one USDT buys
88.421 INR.

### 3.3 Rounding

**INV-05** — The recipient INR amount is never rounded. It is exact customer
input and it is what the beneficiary must receive to the paise.

**INV-06** — All rounding happens on the funding side and rounds **up** to the
next funding-currency minor unit. The residual (always strictly less than one
minor unit of the funding currency) is retained by INRSettle and disclosed on
the receipt as an explicit `rounding` line, so that the receipt reconciles
exactly.

Funding required, for recipient amount `R` in paise and rate `r`:

```
fundingMinor = ceil( R × 10^fundingScale / ( r × 10^inrScale ) )
```

computed in exact decimal or integer arithmetic. Never in IEEE 754.

Because the residual is by construction smaller than one minor unit, it is **not
a `Money`**. It is an `ExactAmount` — a currency plus an exact decimal string at
a declared scale of 12 — and it exists so that the receipt's arithmetic closes:

```ts
interface ExactAmount {
  readonly currency: CurrencyCode
  readonly amount: string   // exact decimal, e.g. '0.000000063865'
  readonly scale: 12
}
```

Worked example — recipient gets ₹5,000,000.00 at `USDT/INR = 88.4210000000`:

```
exact funding    56,547,652,706.936135…  USDT minor units
charged          56,547,652,707          USDT minor units   (ceiling, INV-06)
residual                      0.0000000638649…  USDT        (retained, disclosed)
recipient        500,000,000 paise = ₹5,000,000.00          (exact, INV-05)
```

**INV-07** — Fees are separate `Money` values with their own component codes.
They are never folded into the FX rate, and the rate shown to the customer is
the rate actually used.

### 3.4 Quote direction

A quote is either `RECIPIENT_FIRST` (default) or `SOURCE_FIRST`.

- `RECIPIENT_FIRST` — recipient INR is authoritative and exact; funding amount is
  derived and rounded up.
- `SOURCE_FIRST` — funding amount is authoritative and exact; recipient INR is
  derived and rounded **down** to the paise, and the shortfall dust is disclosed.

**INV-08** — Exactly one side of a quote is authoritative, recorded on the quote,
and immutable for that quote's life.

## 4. Identifiers

**INV-09** — Every externally visible identifier is a prefixed, opaque,
URL-safe, non-sequential string. Database primary keys are never exposed.

| Object | Prefix | Example |
|---|---|---|
| Workspace | `ws_` | `ws_3kQ8xR2mVnPq` |
| Beneficiary | `ben_` | `ben_7Ld2ZxKp0Wq4` |
| Quote | `qt_` | `qt_9Xm4Bv7NsLt2` |
| Settlement | `stl_` | `stl_2Rn8Kq5TzYw6` |
| Batch | `bat_` | `bat_5Vp1Jc9HdXe3` |
| Receipt | `rcp_` | `rcp_8Wq3Fn6MbZk1` |
| Liquidity facility | `fac_` | `fac_4Ty7Gs2QjLm9` |
| Reservation | `rsv_` | `rsv_6Hk9Dp4RxNv8` |
| Drawdown | `drw_` | `drw_1Zc5Wt8PfBq7` |
| Repayment | `rpy_` | `rpy_3Nb6Ke1SgVd5` |
| Payout attempt | `pay_` | `pay_0Qs2Xa7LhTr4` |
| Settlement return | `ret_` | `ret_2Bf9Qm5XkWd7` |
| Destination version | `dvr_` | `dvr_6Jk1Ps8YvCn3` |
| Return notice | `rnt_` | `rnt_9Ax4Tg7WqMe2` |
| Event | `evt_` | `evt_5Md8Yn3CwPj2` |
| API key | `sk_live_` / `sk_test_` | `sk_test_…` |

Sandbox and live identifiers are drawn from the same space but a live identifier
is never resolvable in a sandbox request and vice versa (`INV-31`).

## 5. Bounded modules

Each is a directory in `packages/domain`, owns its tables, and exposes an
explicit public interface. Cross-module access goes through that interface or
through domain events — never through another module's tables.

```
identity        workspaces, users, roles, memberships, API keys
beneficiaries   beneficiary, payout destination, verification
preflight       requirement rules, requirement evaluation
quotes          pricing, fx, fees, expiry
settlements     the settlement aggregate and its state machine
liquidity       facility, availability, reservation, drawdown, repayment, ledger
payouts         payout attempts, provider orchestration, rail selection
reconciliation  expected-vs-observed comparison, finality evaluation
batches         batch container, CSV ingest, row mapping
receipts        canonical receipt generation and rendering
providers       ports and adapters for every external system
events          domain events, outbox, webhook delivery
audit           immutable actor-attributed audit trail
```

**INV-10** — No React component, route handler, job handler or Internal Ops
screen contains a financial business rule or performs a state transition
directly. They call domain services. This is enforced by lint boundaries and by
the fact that state transitions are only reachable through the transition
functions in `settlements` and `liquidity`.

## 6. Aggregates

### 6.1 Workspace (identity)

The tenant and the isolation boundary. Carries: legal entity details, KYB status,
enabled features, default funding currency, and whether a liquidity facility is
enabled (this drives whether *Available to settle* appears at all).

Every tenant-scoped row carries `workspace_id` **and** `environment`.

### 6.2 Beneficiary (beneficiaries)

```
Beneficiary
  id, workspace_id, environment
  display_name
  legal_name
  type              INDIVIDUAL | BUSINESS
  country           'IN'   (V1 constant)
  tax_id            PAN, optional, required by some purpose/amount rules
  status            DRAFT | PENDING_VERIFICATION | VERIFIED | REJECTED | DISABLED
  default_destination_id
  created_at, updated_at, created_by
```

```
PayoutDestination                    -- identity. What the customer edits.
  id, beneficiary_id
  kind                 BANK_ACCOUNT | UPI
  current_version_id
  created_at, disabled_at

PayoutDestinationVersion             -- immutable snapshot. Append-only.
  id                   dvr_…
  destination_id, version_number
  -- BANK_ACCOUNT
  account_number       encrypted at rest, last 4 retained in clear for display
  ifsc                 ^[A-Z]{4}0[A-Z0-9]{6}$
  account_type         SAVINGS | CURRENT
  account_holder_name
  -- UPI
  vpa
  verification_status  UNVERIFIED | VERIFYING | VERIFIED | FAILED
  verification_method  PENNY_DROP | PROVIDER_LOOKUP | MANUAL
  name_match_score     0..100, nullable
  verified_at
  content_hash         sha256 of the canonical serialisation of the payout details
  created_at, superseded_at
```

A destination id is a stable handle the customer owns; a **destination version**
is the immutable thing money is actually sent to. Editing a destination does not
change any row — it appends a new version and moves `current_version_id`.

**INV-44** — `PayoutDestinationVersion` rows are append-only. No field is ever
updated after insert except `superseded_at` and the verification fields that
belong to that version's own verification run. An edit to any payout detail
creates a **new** version, which starts `UNVERIFIED`; the previous version keeps
its own verification status, its `verified_at` and its history, and is never
retroactively invalidated.

**INV-45** — Verification attaches to a **version**, never to a destination.
`name_match_score` and `verified_at` describe the exact details that were
checked. There is therefore no way for a destination to be "edited and
re-verified under the same identity" in a way that changes what an already
authorized settlement will pay: that settlement is bound to a version, not to
`current_version_id`.

**INV-11** — A settlement may only be authorized against a beneficiary whose
status is `VERIFIED` and a **destination version** whose `verification_status`
is `VERIFIED`. The version that satisfied this check is the version bound to the
settlement at authorization (`INV-16`); a later version of the same destination,
verified or not, has no effect on it.

**INV-12** — Full account numbers are encrypted at rest with a key that is not
available to the application's read paths; only the last four digits are stored
in clear for display. They never appear in logs, events, webhooks or receipts.

**Rail selection is INRSettle's decision, not the customer's.** The customer
picks a beneficiary, not NEFT or IMPS. The `payouts` module selects the rail from
amount, destination kind, time of day, and provider capability.

### 6.3 Purpose (preflight)

```
Purpose
  code              internal stable code, e.g. 'SOFTWARE_SERVICES'
  label             'Software services'
  regulatory_code   the AD-bank / RBI purpose code for inward remittance
  document_rules    which documents are required, by amount band
```

The regulatory purpose code taxonomy for inward remittance to India is defined
by the RBI/FEMA framework and applied by the authorised dealer bank in the
corridor. **The exact code table is provider- and AD-bank-specific and must be
confirmed with the first real payout partner** — it is loaded as a versioned
reference table, not hard-coded in the domain. Flagged as decision `D-06`.

### 6.4 Quote (quotes)

```
Quote
  id, workspace_id, environment
  direction            RECIPIENT_FIRST | SOURCE_FIRST
  recipient_amount     Money (INR)
  funding_amount       Money (funding currency)
  fx_rate              Decimal(28,10), pair, source
  fee_components       [{ code, label, amount: Money }]
  rounding_residual    ExactAmount   -- sub-minor-unit, see § 3.3
  estimated_delivery   duration band, e.g. 'under 30 minutes'
  status               ACTIVE | LOCKED | CONSUMED | EXPIRED | VOID
  expires_at
  locked_at, consumed_by_settlement_id
  created_at
```

**INV-13** — A quote is immutable once created. Re-pricing produces a new quote;
it never edits an existing one.

**INV-14** — A quote may be consumed by at most one settlement, enforced by a
unique constraint on `consumed_by_settlement_id`.

**INV-15** — A settlement may not be authorized against a quote that is
`EXPIRED`, `VOID` or already `CONSUMED`. Expiry is evaluated server-side against
the database clock, never against a client-supplied time.

### 6.5 Settlement (settlements)

```
Settlement
  id, workspace_id, environment
  batch_id                 nullable
  beneficiary_id, destination_id
  destination_version_id   frozen at authorization; what payout executes against
  recipient_amount         Money (INR)     -- exact, immutable after authorization
  funding_currency
  purpose_code
  authorized_terms         frozen economic commitment, see below
  authorized_terms_hash    sha256 of its canonical serialisation
  external_reference       customer's own id, unique per workspace when supplied
  quote_id                 nullable until quoted
  status                   internal state (STATE_MACHINES.md)
  customer_status          derived projection, materialised for query performance
  exception_entered_from   nullable; the status EXCEPTION was entered from
  authorized_at, authorized_by
  cancellation_requested_at, cancellation_requested_by
  point_of_no_return_at    stamped by the dispatch transaction (INV-36); never cleared
  settled_at
  reservation_id, drawdown_id, payout_attempt_id, receipt_id
  replaces_settlement_id   forward only; set at creation, never updated
  idempotency_key          nullable, unique per workspace + environment
  created_at, updated_at, created_by
  version                  optimistic concurrency
```

### 6.5.1 The authorized commitment

Authorization freezes two things, and both are bound to the settlement by value,
not by reference to something that can move underneath it.

**The destination.** `destination_version_id` is set at `AUTHORIZED` to the exact
version that passed `INV-11`. Every downstream use reads that version:

- payout execution constructs the instruction from the frozen version, never
  from `destination.current_version_id`;
- the settlement detail screen, the API settlement object, the receipt and
  Internal Operations all display the frozen version from `AUTHORIZED` onward.
  Before authorization they show the current one, because before authorization
  there is nothing to protect.

**The economics.** `authorized_terms` is a by-value snapshot taken from the
consumed quote at `AUTHORIZED`:

```
authorized_terms
  quote_id
  direction              RECIPIENT_FIRST | SOURCE_FIRST
  recipient_amount       Money (INR)
  funding_amount         Money (funding currency)
  fx_rate                pair, rate, scale, quoted_at
  fee_components         [{ code, label, amount }]
  rounding_residual      ExactAmount
  quoted_at, expires_at
```

Quotes are already immutable (`INV-13`), so `quote_id` alone would pin the terms.
The snapshot exists anyway for two reasons: it makes the commitment checkable
without a join to another aggregate's table, and `authorized_terms_hash` gives
the finality evaluator and the receipt one value to compare against, so a drift
between what was authorized and what was executed is detectable mechanically
rather than by reading two records side by side.

**INV-16** — The **instruction** is immutable from `AUTHORIZED` onward:
`beneficiary_id`, `destination_id`, `destination_version_id`,
`recipient_amount`, `purpose_code`, `funding_currency`, `authorized_terms` and
`authorized_terms_hash` have no code path that updates them. A change of intent is a
cancellation plus a new settlement, or — after the point of no return — a
replacement settlement carrying `replaces_settlement_id`, with the reverse link
derived rather than written back (`INV-38`, `STATE_MACHINES.md § 7.1`).

Immutability of the instruction is **not** irreversibility of execution. Those
are different guarantees and they are separated deliberately:

**INV-35** — `AUTHORIZED` freezes the instruction and permits execution to
begin. It does not end the customer's ability to stop the settlement. The
settlement remains cancellable until `point_of_no_return_at` is stamped.

**INV-36** — The point of no return is the **commit of the dispatch
transaction**, not a moment in the outbound call. The dispatch transaction is
exactly one transaction and does exactly this, in this order:

```
BEGIN
  SELECT … FROM settlements WHERE id = $1 FOR UPDATE     -- (a) serialize
  assert status = 'DRAWDOWN_CONFIRMED'
  assert cancellation_requested_at IS NULL               -- (b) last check
  assert point_of_no_return_at IS NULL
  UPDATE settlements SET point_of_no_return_at = now(),
                         status = 'PAYOUT_SUBMITTED'     -- (c) cross
  INSERT INTO payout_attempts (…, request_fingerprint)   -- (d) durable key
  INSERT INTO events (…)                                 -- (e) INV-32
  INSERT INTO jobs ('payout.dispatch', …)                -- (f) outbox
COMMIT                                                   -- ← PONR crossed here
```

Three properties follow, and they are the whole point:

**(a) Serialization.** `request_cancellation` (T26) takes the *same* row lock on
the *same* settlement row before writing `cancellation_requested_at`. The two
transactions therefore have a total order and cannot interleave. If cancellation
commits first, dispatch sees the flag at (b) and aborts to `CANCELLED` (T27). If
dispatch commits first, cancellation sees `point_of_no_return_at IS NOT NULL`
and is refused with `past_point_of_no_return`. There is no third outcome and no
window between them.

**(b) No outbound call inside the transaction.** The provider is called by the
job enqueued at (f), after commit. A network call must never be made while
holding a row lock, and a transaction must never be rolled back after a call
that may have created a real payout. This is why the boundary is the commit and
not the call.

**(c) Failure of the external call does not un-cross the boundary.**
`point_of_no_return_at` is never cleared. Once the dispatch transaction has
committed, a durable `PayoutAttempt` with a stable provider idempotency key
exists (`INV-25`), so a payout may exist at the provider whatever the local call
reported. A connection reset, a timeout, a 5xx, or a worker crash between commit
and call all resolve through the authoritative status pull (`INV-24`) — never
through cancellation, and never by a second dispatch transaction.

**INV-37** — The internal `ACTION_REQUIRED` state is reachable **only** from
`PREFLIGHTING` (transition T04). It is a preflight state, not a general-purpose
"waiting on someone" state. Every execution-phase stall is an `EXCEPTION` with a
typed code from the closed taxonomy in `STATE_MACHINES.md § 7`.

**INV-38** — `SETTLED`, `FAILED` and `CANCELLED` are terminal. A terminal
settlement has no outgoing transitions **and accepts no field writes at all** —
not a status change, not a flag, not a convenience pointer. Every later fact is
recorded as a linked aggregate or an append-only event that references the
settlement, and **every reverse relationship is derived** — by an index on the
referencing row, or by a projection rebuilt from events — never stored on the
terminal row.

This is enforced by a database trigger that rejects any `UPDATE` on a settlement
in a terminal state, not only on its financial columns.

The pattern to copy is `SettlementReturn` (§6.10): the return carries
`settlement_id`, the settlement carries nothing about the return, and
`settlement.returns` is a read-model query. **Replacement settlements follow the
same shape:** the replacement carries `replaces_settlement_id`, the replaced
settlement is not touched, and the reverse is
`SELECT id FROM settlements WHERE replaces_settlement_id = $1` over an index —
with `settlement.replacement_created` in the event log as the append-only record
of the link. A stored `replaced_by_settlement_id` column would be a write to a
terminal row and is prohibited.

**INV-17** — `status` is only ever written by the transition function in the
`settlements` module, inside a transaction that also appends the corresponding
domain event. No endpoint, job, migration, admin screen or SQL console procedure
may update the column directly. Enforced additionally by a database trigger that
rejects any `UPDATE` of `status` where the transaction has not written its
matching event row.

**INV-18** — `customer_status` is a pure function of `status` plus the
customer-actionability of any open exception. It is never set independently.

### 6.6 Liquidity facility (liquidity)

Liquidity is modelled properly. It is not a boolean on a settlement.

```
LiquidityFacility
  id, workspace_id, environment
  provider_id
  currency
  limit                  Money        -- FacilityLimit, versioned via events
  status                 ACTIVE | SUSPENDED | CLOSED
  drawn                  Money        -- outstanding, derived from the ledger
  reserved               Money        -- sum of active reservations, derived
  available              Money        -- limit − drawn − reserved (computed)
```

```
LiquidityReservation
  id, facility_id, settlement_id
  amount                 Money
  status                 ACTIVE | CONSUMED | RELEASED | EXPIRED
  expires_at
  created_at, released_at, released_reason
```

```
Drawdown       id, facility_id, settlement_id, amount, provider_reference, status, confirmed_at
FacilityEvent  id, facility_id, type, amount, actor, payload, created_at   -- append-only
```

```
Repayment
  id                   rpy_…
  facility_id, amount  Money
  source               CANCELLATION_AFTER_DRAWDOWN | SETTLEMENT_RETURN | MANUAL | SCHEDULED
  settlement_id        nullable
  return_id            nullable
  status               REQUESTED | SUBMITTED | CONFIRMED | FAILED | UNKNOWN
  provider_reference   nullable until submitted
  request_fingerprint  idempotency key sent to the provider
  requested_at, submitted_at, confirmed_at, failed_at
```

**INV-46** — **A repayment restores facility capacity only when it is
`CONFIRMED`.** `drawn` decreases, and availability rises, on exactly one event:
a confirmed repayment posting its double-entry to the ledger (`INV-23`).
Creating a repayment does nothing to `drawn`. Submitting one does nothing to
`drawn`. A repayment that is `REQUESTED`, `SUBMITTED` or `UNKNOWN` is visible to
operations as `repayment_in_flight` and is **explicitly excluded from the
availability formula in `INV-19`** — money the provider has not confirmed
returning is not capacity, however confident anyone is that it is coming.

**INV-47** — Repayment `UNKNOWN` is resolved the same way payout `UNKNOWN` is
(`INV-24`): by an authoritative status pull against the provider using the
repayment's own `request_fingerprint`, never by resubmitting. A duplicate
repayment is a real financial error in the opposite direction from a duplicate
payout, and is prevented the same way. The `LiquidityProvider` port therefore
carries `getRepayment(ref)` alongside `submitRepayment`.

**INV-19** — `available = limit − drawn − reserved`, and `available >= 0` at all
times. This is enforced as a database `CHECK` on a derived, transactionally
maintained facility row, not only in application code. In-flight repayments do
not appear in this formula (`INV-46`); `drawn` falls only when a repayment is
confirmed.

**INV-20** — Reservation is atomic. Reserving takes a row lock on the facility
(`SELECT … FOR UPDATE`), recomputes availability inside that transaction, and
inserts the reservation or fails. Concurrent settlements can never over-allocate
a facility. This is verified by a concurrency test that fires N simultaneous
reservations against a facility that can fund N−1 of them and asserts exactly one
failure.

**INV-21** — A settlement holds at most one `ACTIVE` reservation, enforced by a
unique partial index on `(settlement_id) WHERE status = 'ACTIVE'`.

**INV-22** — Release applies only to a reservation that is still `ACTIVE`.
Cancellation before drawdown, failure before drawdown, and TTL expiry each
release an `ACTIVE` reservation exactly once, idempotently.

A **`CONSUMED` reservation is never released.** Once a drawdown is confirmed the
value is no longer reserved — it is drawn — and there is nothing to give back on
the reservation side. Restoring capacity after a confirmed drawdown happens
through one mechanism only: a **`CONFIRMED` repayment** (`INV-46`).

This matters most for post-settlement returns. A `SettlementReturn` arrives long
after the reservation was consumed and the settlement went terminal. It must
never touch a reservation. Attempting to release a `CONSUMED` reservation is a
typed error, not a no-op, so a mistaken code path fails loudly instead of
silently double-crediting the facility.

**INV-23** — Every movement of facility value is a double-entry pair in an
append-only `ledger_entries` table. `drawn` and `reserved` on the facility are
projections of the ledger and are rebuildable from it. If the projection and the
ledger disagree, the ledger wins and an operational alarm fires.

**One facility supports many settlements.** Liquidity is never presented to the
customer as credit, a loan, a balance or a wallet — only as *Available to
settle*, and only when a facility is actually enabled.

### 6.7 Payout (payouts)

```
PayoutAttempt
  id, settlement_id
  provider_id, rail            NEFT | RTGS | IMPS | UPI
  amount                       Money (INR)
  provider_reference           provider's own id
  utr                          Unique Transaction Reference, nullable until credited
  status                       SUBMITTED | ACCEPTED | CREDITED | REJECTED | RETURNED | UNKNOWN
  submitted_at, credited_at, returned_at
  attempt_number
  request_fingerprint          idempotency key sent to the provider
```

`RETURNED` exists here, on the payout attempt, because a return is a fact about
a rails-level execution. It does not propagate to the settlement's status; it
opens a `SettlementReturn` (§6.10).

**INV-24** — A settlement may have several payout attempts over its life, but at
most one attempt that is not in a terminal state. Retry after `UNKNOWN` requires
a completed status reconciliation against the provider, never a blind resubmit.

**INV-25** — Every submission to a payout provider carries a stable idempotency
key derived from `settlement_id + attempt_number`, so a retried network call can
never create a second real payout.

### 6.8 Reconciliation (reconciliation)

```
Reconciliation
  id, settlement_id
  expected_amount     Money (INR)
  observed_amount     Money (INR), nullable
  delta               Money (INR)
  status              PENDING | MATCHED | MISMATCH | MANUAL_REVIEW
  source              the authoritative observation used
  evaluated_at, resolved_at, resolved_by, resolution_note
```

**INV-26** — Default tolerance is **zero**. `MATCHED` requires
`observed_amount == expected_amount` exactly. Any non-zero delta is `MISMATCH`
and is never silently accepted, absorbed, or auto-resolved.

**INV-27** — A `MISMATCH` blocks finality. It is resolved only by an explicit,
attributed operator decision that itself creates an event and, where value moved
incorrectly, a compensating financial entry.

### 6.9 Settlement receipt (receipts)

```
SettlementReceipt
  id, settlement_id, workspace_id, environment
  settlement_id_display
  beneficiary_snapshot        immutable copy, not a live join
  recipient_amount, delivered_amount
  funding_amount, funding_currency, fx_rate, fee_components, rounding_residual
  purpose, external_reference
  payout_reference (UTR), rail
  reconciliation_result
  final_status
  created_at, authorized_at, credited_at, settled_at
  content_hash                sha256 of the canonical serialisation
  pdf_object_key              written once, never overwritten (INV-48)
```

**INV-28** — The receipt embeds snapshots, not joins. A later edit to a
beneficiary's display name must not change a historical receipt.

**INV-29** — For **each artifact**, the UI, PDF and API representations are
rendered from that artifact's one canonical serialisation and carry its
`content_hash`. They cannot disagree.

**INV-48** — Financial artifacts are **write-once**. A `SettlementReceipt`, once
created, is never re-serialised, never re-rendered and never re-hashed; its
stored PDF object is written once to a key that is never overwritten, enforced by
an object-storage policy that grants the application no overwrite or delete
permission on the receipts prefix.

A settlement return produces a **separate artifact**, not an addition to the
receipt:

```
ReturnNotice
  id                    rnt_…
  return_id, settlement_id, receipt_id
  amount, reason_code, reason_message
  return_status_at_issue
  created_at
  content_hash          sha256 of its own canonical serialisation
  pdf_object_key        written once, never overwritten
```

The receipt and each notice are independent immutable artifacts with independent
hashes. **The receipt's `content_hash` and PDF bytes are identical before and
after any number of returns.** UI and API *compose* them for reading — the
receipt endpoint links its notices rather than merging their fields — and an
optional composite export may render both into one document. That composite is a
**third artifact** with its own hash; it never replaces, rewrites or invalidates
either source.

### 6.10 Settlement return (reconciliation)

A credited payout can be returned later — closed account, downstream name
mismatch, beneficiary bank rejection. That is a new, independent fact about a
rails-level execution, not a change to a final settlement, so it is its own
aggregate.

```
SettlementReturn
  id                    ret_…
  settlement_id         a SETTLED settlement, never modified
  payout_attempt_id     the attempt that was returned
  amount                Money (INR) — may be partial
  reason_code           provider return reason, mapped to a closed enum
  status                OBSERVED | CONFIRMED | REPAID | REJECTED | MANUAL_REVIEW
  observed_at, confirmed_at, repaid_at
  repayment_id             the Repayment requested on confirmation (INV-41)
  provider_event_id        the trusted event that opened it
  provider_return_reference the provider's own id for this return; unique per
                           payout attempt, the deduplication key (INV-50)
  resolved_by, resolution_note
```

**INV-39** — A `SettlementReturn` is opened only by a trusted provider event or
an authoritative status pull — the same standard as finality condition F3. No
customer claim, screenshot or operator assertion can open one.

**INV-40** — `OBSERVED → CONFIRMED` requires an authoritative check against the
provider, not the inbound event alone. A return that does not survive that check
is `REJECTED` and raises an alarm: a false return report is a serious provider
signal.

**INV-41** — Confirming a return **requests** a `Repayment` against the liquidity
facility, in status `REQUESTED`. It does not post a ledger entry and does not
change `drawn`. The compensating double-entry is posted when — and only when —
that repayment reaches `CONFIRMED` (`INV-46`), at which point the return moves to
`REPAID`. A return never releases a reservation (`INV-22`); the reservation it
relates to was consumed at drawdown.

**INV-42** — The referenced settlement's row and its receipt's `content_hash` are
byte-identical before and after any return. Multiple and partial returns against
one settlement are supported as separate rows.

**INV-49** — **Returns can never exceed what was delivered.** For each payout
attempt, the sum of `amount` over its returns in status `CONFIRMED` or `REPAID`
is less than or equal to that attempt's delivered amount, and the same holds
summed across attempts for the settlement as a whole.

This is enforced atomically, not checked hopefully. `OBSERVED → CONFIRMED` takes
a row lock on the payout attempt, recomputes the confirmed total inside that
transaction, and refuses the transition if it would breach the cap. A
transactionally maintained `returned_total_minor` column on the payout attempt
carries a database `CHECK` constraint against `delivered_amount_minor`, so the
invariant holds even against a code path that forgets the lock. A return that
would breach the cap is routed to `MANUAL_REVIEW` and alarms — it means either a
provider defect or a deduplication failure, and both need a human.

**INV-50** — **Provider returns are deduplicated on two keys.** `INV-33` already
makes redelivery of the same provider *event* a no-op. This covers the harder
case: the same underlying return reaching us through two different channels — a
webhook and a status pull, or two providers' event types describing one event. A
unique constraint on `(payout_attempt_id, provider_return_reference)` guarantees
one `SettlementReturn` row per real-world return. A second sighting updates
nothing and creates nothing; it is recorded against the existing return as an
additional observation.

Lifecycle and surfacing rules are in `STATE_MACHINES.md § 8.4` and `§ 8.5`.

### 6.11 Batch (batches)

```
Batch
  id, workspace_id, environment, name, source (CSV | API)
  row_count, valid_count, action_required_count, settled_count, failed_count
  status                DRAFT | VALIDATING | READY | EXECUTING | COMPLETED | PARTIALLY_COMPLETED
  totals                Money (INR) aggregate
```

**INV-30** — A batch is a container, not a transaction. An invalid or blocked row
never blocks a valid row, and the batch has no all-or-nothing semantics.

## 7. Isolation, events and audit

**INV-31** — Every query against a tenant-scoped table is filtered by
`workspace_id` **and** `environment`. Enforced by Postgres row-level security
driven by session variables, not by remembering to add a `WHERE` clause. Details
in `SECURITY.md`.

**INV-32** — Domain events are append-only and immutable, and are written in the
same database transaction as the state change that produced them, via a
transactional outbox, so an event can never exist without its state change or
the reverse.

The pairing rule is stated once, precisely, because "every transition has an
event" and "exactly one event per transition" were previously both asserted and
neither was true of the table. Events divide into two disjoint sets:

- **Status events** — the set `SETTLEMENT_STATUS_EVENTS`, listed in §8. Exactly
  one is designated as the canonical event of each status-changing transition.
- **Companion events** — everything else: events of other aggregates
  (`quote.*`, `facility.*`, `receipt.*`), and non-status settlement events
  (`settlement.preflight_completed`, `settlement.reconciled`,
  `settlement.cancellation_requested`, `settlement.replacement_created`,
  `settlement.return_*`).

**The rule:** *every transaction that updates `settlements.status` writes exactly
one event whose `type ∈ SETTLEMENT_STATUS_EVENTS` and whose `settlement_id`
matches the updated row, and may write any number of companion events. A
transaction that does not update `status` writes no status event.*

This is enforced by a constraint trigger on `settlements`, so it holds against
any code path including raw SQL. Two properties follow: the event stream is a
faithful, gap-free projection of the status history, and a transition can still
emit the companion events it genuinely needs without the rule becoming untestable.

The transition tables in `STATE_MACHINES.md § 4` name the status event and the
companions for every transition. A table-driven test asserts the implementation
emits exactly the named set — the trigger enforces the mechanical half, the test
enforces the complete half.

**INV-33** — Raw provider events are persisted verbatim before interpretation,
with their signature, headers and receipt timestamp, and are keyed by the
provider's own event id for idempotent handling.

**INV-43** — **Ingestion never depends on classification.** `INV-33` guarantees a
provider event is verified and persisted raw *before* interpretation; this is its
complement, governing what interpretation may do, and it is not a second copy of
the same rule.

Interpretation maps a provider's vocabulary — error codes, rejection reasons,
return reasons, event types — onto INRSettle's closed taxonomies through a
**versioned, provider-specific mapping table**, which is data, not code. An input
that the table does not cover:

- **never throws and never poisons the queue.** The handler completes, the raw
  event stays persisted and acknowledged, and nothing behind it is blocked.
- **never invents a taxonomy code**, and never widens the taxonomy at runtime.
  The closed enum in `STATE_MACHINES.md § 7` stays closed; adding a *code* is a
  code change, adding a *mapping* is a data change.
- **routes to the phase-appropriate safe default**, chosen from the one thing
  every provider does communicate — whether the instruction was rejected or its
  outcome is merely unknown:

| Unmapped input | Routes to | Customer-actionable |
|---|---|---|
| Terminal rejection, payout phase | `PAYOUT_REJECTED_PROVIDER` | no |
| Terminal rejection, funding phase | `DRAWDOWN_FAILED` | no |
| Non-terminal / indeterminate, payout phase | `PAYOUT_STATUS_UNKNOWN` | no |
| Non-terminal / indeterminate, funding phase | `DRAWDOWN_STATUS_UNKNOWN` | no |
| Unmapped return reason | `SettlementReturn` opens in `MANUAL_REVIEW` | no |
| Unrecognised event *type* | recorded and ignored for interpretation; no transition | n/a |

- **always defaults to not customer-actionable.** We never tell a customer to fix
  something we could not classify. Misrouting toward ops costs an operator ten
  minutes; misrouting toward the customer costs their trust and may be wrong.
- **preserves the raw values as data**: the exception carries
  `provider_raw_code`, `provider_raw_message` and `provider_event_id`, and is
  flagged `classification: unmapped`.
- **alarms.** An `unmapped_provider_code` alarm fires with the provider, the raw
  code and a link to the persisted event, so a human adds the mapping. An
  unmapped code appearing repeatedly is a provider-integration defect and is
  tracked as one.

**INV-34** — Every financial transition and every operator action carries an
actor (user, API key, job, or provider), and the audit trail is append-only.
There is no code path by which an administrator can silently edit a final
settlement.

## 8. Domain events

Names are stable and are the source of truth for webhook event types.

```
beneficiary.created            beneficiary.verification_started
beneficiary.verified           beneficiary.verification_failed

SETTLEMENT_STATUS_EVENTS — exactly one per status-changing transition (INV-32):

settlement.created                     settlement.preflight_started
settlement.action_required             settlement.ready
settlement.quoted                      settlement.authorized
settlement.liquidity_reservation_started
settlement.liquidity_reserved          settlement.drawdown_requested
settlement.drawdown_confirmed          settlement.payout_submitted
settlement.payout_confirmed            settlement.reconciliation_started
settlement.settled                     settlement.exception_opened
settlement.exception_resolved          settlement.failed
settlement.cancelled

Companion settlement events — never status events, never paired by the trigger:

settlement.preflight_completed         settlement.reconciled
settlement.cancellation_requested      settlement.replacement_created
settlement.return_observed             settlement.return_confirmed
settlement.return_repaid               settlement.return_rejected

quote.created                  quote.locked
quote.expired                  quote.consumed

batch.created                  batch.validated
batch.completed                batch.partially_completed

receipt.available              receipt.return_notice_available

facility.limit_changed         facility.reservation_created
facility.reservation_released  facility.reservation_expired
facility.drawdown_confirmed    facility.suspended
facility.repayment_requested   facility.repayment_submitted
facility.repayment_confirmed   facility.repayment_failed

destination.version_created    destination.version_verified
destination.version_verification_failed
```

Facility events are internal only and are never delivered to customer webhook
endpoints.

## 9. What is deliberately not in the domain

No customer balances. No internal wallet. No order book. No P2P matching. No
India → Global direction. No card objects. No lending or credit objects — the
facility is infrastructure and is never expressed to the customer as credit.
No CRM objects on beneficiaries.

Adding any of these is a scope change requiring explicit approval.

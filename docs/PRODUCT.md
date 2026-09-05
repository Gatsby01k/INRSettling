# PRODUCT.md

Status: **Stage 0 — Revision 6 · FROZEN 2026-09-03 · decision cleanup (`D-03` closed)**
Owner: Founder
Supersedes: nothing. This is a clean-sheet definition.

---

## 1. The product in one sentence

INRSettle is cross-border settlement infrastructure for India: a customer names
a verified Indian beneficiary, the exact INR the beneficiary must receive, and
why — and INRSettle delivers the INR and returns one final settlement record.

## 2. The product contract

```
INPUT   beneficiary + exact recipient INR amount + payment purpose
OUTPUT  INR delivered + one final settlement record
```

Everything between those two lines — stablecoin liquidity, prefunding, FX
execution, provider orchestration, reconciliation — is infrastructure the
customer bought, not infrastructure the customer operates.

**Core principle: complex underneath, obvious on screen.**

## 3. Who this is for

Approved commercial platforms that need to move money into India at volume:

- cross-border payment companies and PSPs
- remittance operators
- OTC desks
- payroll and contractor platforms
- marketplaces paying Indian sellers and service providers

They are not consumers. They are not walk-up traffic. Every workspace is
KYB-gated and onboarded. This is a B2B infrastructure product with a small
number of high-value customers, and the product should be shaped for that:
depth and exactness over breadth and self-service growth loops.

**The wedge is prefunded Global → India commercial settlement.** Operators
frequently need liquidity available before the local payout corridor executes.
INRSettle is built so prefunded liquidity sits underneath the settlement
experience without ever becoming a customer-facing credit product.

Liquidity is infrastructure. The customer buys settlement.

## 4. What the customer must never be required to understand

Unless a specific action or exception genuinely requires it:

- stablecoin liquidity operations
- provider-specific workflows
- prefunding and drawdown mechanics
- payout provider internal states
- FX execution mechanics
- reconciliation internals
- individual rail terminology (NEFT / IMPS / RTGS / UPI)

These concepts all exist in the system. They surface in Internal Operations, in
the API for customers who want them, and in the collapsed technical detail of a
settlement — never in the primary reading path.

## 5. Settlement — the unit of the product

A **settlement** is one instruction to deliver a specific INR outcome to one
verified Indian beneficiary.

Required input:

| Field | Notes |
|---|---|
| Beneficiary | A verified, reusable beneficiary record |
| Recipient gets | The exact INR the beneficiary must receive. Not an estimate. |
| Purpose | Business reason, mapped to a regulatory purpose code |
| Funding currency | The currency the customer funds from (e.g. USDT) |
| External reference | Customer's own ID, optional but strongly encouraged |
| Documents | Only when preflight says they are required |

Worked example:

```
Beneficiary       Priya Technologies Pvt Ltd
Recipient gets    ₹5,000,000
Purpose           Software services
Funding currency  USDT
```

### 5.1 Recipient-first is the default mental model

The customer's sentence is *"I need this beneficiary to receive ₹X."* The
product must never make them solve for INR from a source amount by default.

Source-first (*"I have 56,500 USDT, send it all"*) is a deliberate secondary
mode, offered behind an explicit toggle. It is not the default, and it changes
which number is authoritative — see `DOMAIN.md § Quote direction`.

## 6. Customer-facing lifecycle

The customer-facing lifecycle is intentionally tiny and must stay tiny:

```
READY  →  SETTLING  →  SETTLED

        ACTION_REQUIRED        CANCELLED
```

- **READY** — preflight passed, nothing is blocking, not yet authorized
- **SETTLING** — authorized and executing; the customer has nothing to do
- **SETTLED** — final. INR delivered and reconciled. Receipt available.
- **ACTION_REQUIRED** — precisely one thing the customer must supply or fix
- **CANCELLED** — did not and will not complete; funds are not with a beneficiary

**Authorizing is not the same as being unable to stop.** Pressing *Settle ₹X*
freezes the instruction — beneficiary, amount and purpose can no longer change —
and lets execution begin. The settlement stays cancellable until INRSettle
actually sends the payout instruction to the provider. Up to that moment the
customer sees a **Cancel settlement** action; after it, the action is gone and
the reason is stated in its place. That honest boundary is worth more than the
false comfort of a button that stays clickable and quietly does nothing.

The rich internal state machine (sixteen-plus states) is never product
navigation. It projects down to these five. The projection rules are normative
and live in `STATE_MACHINES.md § Customer projection`.

**A settlement that fails projects to CANCELLED with a stated resolution
reason**, not to a sixth customer state. Decision `D-03` is **closed for V1**:
there are five customer-facing states and no `NOT_COMPLETED`.

The reasoning, recorded because the pressure to add the sixth state will return.
The five states answer one question — *what is happening to my money*. `FAILED`
and `CANCELLED` have the same answer to it: nothing was delivered and your
liquidity is released. By the test that produced the state set, they are one
state. What differs is *why*, and the `resolution` field says that better than a
state name can: "Cancelled — our payout partner declined this transfer" is
information, where a state called `NOT_COMPLETED` sitting beside a state called
`CANCELLED` is a puzzle the customer has to solve first. A customer-facing state
is also a public API value, a filter in every list, a column in every export and
a row in every integrator's mapping table — the most expensive kind of thing to
add and nearly impossible to remove. A resolution code is additive, and an
unrecognised one degrades to the state, which is still correct.

**A settlement that is returned after settling does not project to CANCELLED and
does not change status at all.** It was settled; that remains true. The return
is a separate, linked record with its own status — *Return reported*, *Return
confirmed*, *Funds released* — shown prominently on the settlement and
filterable in lists. Collapsing "never delivered" and "delivered then returned"
into one status would destroy a distinction the customer's own books depend on.
See `STATE_MACHINES.md § 8.4`.

## 7. Preflight is a product feature, not a validator

Before a settlement can be authorized, INRSettle runs **preflight**: a
deterministic, versioned set of checks that discovers every missing requirement
*before* money moves.

Preflight examines beneficiary identity, payout destination details, purpose and
its regulatory code, funding currency, amount limits, required documents, and
the requirements of the connected providers for this corridor.

The customer sees exactly one of two outcomes:

- **READY**
- **ACTION REQUIRED** — with a precise, human explanation and a resolving action

### 7.1 The error-copy rule

This rule is non-negotiable and applies to every surface, including the API.

Never:

> Payment validation failed.

Always:

> **Invoice is required for this settlement.** Settlements above ₹1,000,000 for
> software services need a commercial invoice. — *Attach invoice*

> **Beneficiary bank account needs verification.** We will send a ₹1 test credit
> to confirm the account accepts payments. Takes about a minute. — *Verify now*

Every blocking requirement carries four things: a stable machine code, a
one-line human title, a sentence of context, and a single named action. If a
requirement cannot express all four, it is not ready to ship.

## 8. Quote

The quote is recipient-first. The visually dominant number on the screen is:

```
RECIPIENT GETS   ₹5,000,000
```

Supporting, secondary: funding amount, funding currency, FX rate, fees, expiry
countdown, estimated settlement time. Provider metadata is internal only.

Quotes expire. Expiry is shown as a live countdown, not a timestamp, and the
expiry behaviour is defined in `STATE_MACHINES.md § Quote`.

## 9. Finality and the receipt

**Provider-reported success is not settlement.** SETTLED is produced only by the
finality evaluator when every finality condition holds — see
`STATE_MACHINES.md § Finality`. Nothing in the product may shortcut this: not a
screenshot, not a manual "mark paid" button, not a customer claim, not
client-side state, not an unverified webhook.

Every settlement that reaches SETTLED produces exactly one canonical
**Settlement Receipt** containing: INRSettle settlement ID, beneficiary,
recipient INR amount, actual delivered INR amount, funding amount and currency,
FX rate, fees, purpose, external reference, payout reference (UTR), timestamps,
reconciliation result, and final status.

The receipt is available in three forms, generated from one source: the UI, a
PDF export, and a machine-readable API representation. The three must never
disagree.

## 10. Batches

A batch is many independent settlements that happen to have been created
together. It is not a transaction.

```
India Contractor Payout — September

143 settlements        ₹12,840,000
139 READY               4 ACTION_REQUIRED
```

Invalid or incomplete rows must never block valid ones. The batch shows an
aggregate; the settlements inside it keep their own independent lifecycles.
Supported creation paths: CSV import with row-level validation, and API.

## 11. Beneficiaries

A beneficiary is a first-class, reusable domain object. Verify once, settle many
times.

The beneficiary screen shows only what helps someone settle: legal/display name,
country (India), payout destination, verification status, settlement history,
total settled, last settlement, and one primary action — **New settlement**.

Beneficiaries are not a CRM. No contacts, no notes, no tags, no owners, no
activity feed, no lifecycle stages.

## 12. Product surface

Primary navigation, and nothing else:

```
Overview   Settlements   Beneficiaries   Batches   Developers
```

Settings lives under account/workspace controls, not in the primary nav.

**No customer navigation section for:** Treasury, Liquidity, Providers,
Compliance, Reconciliation, Documents, Analytics, Wallet, Crypto, Stablecoins.
Those concepts exist internally. They do not become top-level product areas
without user research proving they must.

### 12.1 Overview is a command center

Overview answers four questions and nothing else:

- What is moving?
- What is settled?
- What needs my attention?
- How much can I settle now?

Top-level metrics: **Available to settle** (shown only when a liquidity facility
is actually enabled for the workspace), **In flight**, **Settled today**,
**Needs attention**.

A workspace can exist before a facility is provisioned — during onboarding it
simply has no *Available to settle* figure. **It cannot authorize a live
settlement until a facility is active**, and preflight says so in those words
rather than letting it fail at execution. V1 has exactly one funding path
(`D-10`, closed).

**Revision 5 — product correction.** An earlier revision proposed a second
top-level *returning* figure beside these metrics. There is no such metric.
Overview answers four questions and adding a fifth number about a mechanic the
customer does not operate works against that.

Money on its way back to the facility — from a cancellation after funding, or a
confirmed return — simply leaves *Available to settle* reduced until the
repayment is authoritatively confirmed (`INV-46`). Showing it as available would
be showing capacity that does not exist yet. The explanation belongs where the
customer will look for it: **on the affected settlement**, which already carries
its cancellation or return notice, as one line stating that the reserved
liquidity returns to the facility once the repayment confirms. Not on Overview.

Below the metrics: active settlements and open exceptions. No decorative charts.
No vanity metrics. No "welcome back" hero.

### 12.2 New Settlement is the most important screen in the product

One focused screen with progressive disclosure. Not a long wizard.

Inputs, in reading order: **Beneficiary → Recipient gets ₹ → Purpose → Funding
currency → Reference / documents if needed.**

A live quote summary stays visible and updates as the amount changes, with the
recipient figure morphing rather than re-rendering. The final action reads:

```
Settle ₹5,000,000
```

The button always names the amount. A settlement is never authorized by a button
that says "Confirm" or "Submit".

The flow must be completable by a payments operations person with no training
and no documentation open.

### 12.3 Settlement detail

The header carries three things and gives them the space: the ₹ amount, the
beneficiary, the customer-facing status.

Then the progression — Ready → Settling → Settled — as the primary visual.

Technical detail is secondary and collapsed by default. Expanded, it reads in
plain language:

```
Settlement ready         14:02:11 IST
Liquidity secured        14:02:14 IST
INR payout confirmed     14:03:47 IST   UTR 2026083112345678
Reconciled               14:03:52 IST   ₹5,000,000 expected · ₹5,000,000 observed
```

Provider identifiers, internal state names and raw event payloads never dominate
the page.

From authorization onward, the payout details shown are the **frozen** ones —
the exact destination version this settlement will pay. If the customer edits
the beneficiary afterwards, this page does not change, because this settlement
does not change. A small note says so, rather than leaving someone to wonder why
the account they just corrected is not reflected here.

Two things sit above the fold when they apply, and are never collapsed into the
technical detail:

- **Cancel settlement**, while the settlement is still cancellable. It states
  what cancelling will do — release the reserved liquidity, reverse the funding
  leg — and it disappears once the payout has been sent, replaced by a single
  line explaining why.
- **A return notice**, if the credit was later returned. Amount, reason, date and
  the return's own status. It is the first thing read on that page, and the
  settlement still reads SETTLED beside it, because both facts are true.

## 13. Developers

Developer experience is a first-class product, not documentation.

Sandbox and Live environments · API keys · webhook endpoints and signing
secrets · request logs · event logs · replay and test-webhook actions · API
reference · copyable examples in curl, TypeScript and Python.

The API primitives stay small: `Beneficiary`, `Quote`, `Settlement`, `Batch`,
`SettlementReceipt`. Versioned REST at `/v1`. Full contract in
`API_CONTRACT.md`.

## 14. Internal Operations

A separate surface, outside customer navigation, where complexity is allowed and
expected: settlements, liquidity facilities, reservations, drawdowns,
repayments, payout providers, reconciliation queues, exceptions, raw provider
events, and the audit log.

**The internal tool may expose complexity. The customer product must not.**

No action in Internal Operations may silently edit a final settlement. Every
operator action is an authored, attributed, auditable event.

## 15. V1 non-goals

Do not build: consumer remittances · consumer wallet · internal customer
balances · exchange · trading · orderbook · public P2P · India → Global · cards ·
lending UI · Digital Rupee · DLT · AI assistant · generic treasury management ·
accounting · ERP · CRM · social features · rewards · own blockchain · own
stablecoin.

Scope does not expand without explicit approval, recorded as a decision in
`IMPLEMENTATION_PLAN.md`.

## 16. Language

The words in the product are part of the product. Use these:

| Use | Never |
|---|---|
| Settlement | Payment, transaction, transfer, payout (customer-facing) |
| Recipient gets | Payout amount, net amount, they receive |
| Beneficiary | Payee, recipient (as a noun for the record), contact |
| Funding currency | Source currency, pay-in currency, deposit |
| Settled | Completed, done, success, paid |
| Settling | Processing, pending, in progress |
| Action required | Failed validation, error, invalid |
| Available to settle | Balance, wallet, credit, limit remaining |
| Settlement receipt | Confirmation, proof, statement |
| Return | Reversal, chargeback, clawback, refund |
| Cancel | Stop, abort, void, delete |

Never show the customer: "drawdown", "reservation", "facility", "prefunding",
"stablecoin", "USDT liquidity", "provider", "reconciliation job", or any
internal state name.

The brand signature — **INR ↔ STABLECOINS • GLOBAL SETTLEMENTS** — lives in the
brand territory: site, deck, login, footer. It is not product UI copy.

## 17. The Alex test

The product fails if a payments professional needs a long explanation.

The correct explanation is:

> Tell INRSettle who in India must receive how much INR. INRSettle executes the
> settlement through connected liquidity and payout infrastructure and gives you
> one final settlement result.

Every screen, field, endpoint and email is measured against that sentence.

## 18. First demo quality bar

The sandbox must demonstrate, end to end and reproducibly:

1. Create beneficiary
2. Create a ₹5,000,000 settlement
3. Preflight → READY
4. Receive quote
5. Reserve liquidity
6. Execute simulated India payout
7. Reconcile
8. SETTLED
9. Generate Settlement Receipt

Plus: one ACTION_REQUIRED case, one batch settlement, one developer webhook
event delivered and visible in the event log.

Provider simulators are **deterministic**, not randomised — scenarios are
selected by input, so every demo is reproducible and every test is stable. See
`ARCHITECTURE.md § 5.1`.

The bar: a senior cross-border payments or liquidity executive watches the demo
and immediately sees where their own infrastructure plugs in.

## 19. What we optimise for

Not feature count. Clarity, speed, trust, exactness, settlement integrity,
developer experience, operational reliability.

The goal is not another complex fintech dashboard. The goal is to make
cross-border INR settlement feel obvious.

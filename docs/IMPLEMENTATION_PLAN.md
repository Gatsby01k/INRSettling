# IMPLEMENTATION_PLAN.md

Status: **Stage 0 — Revision 7 · FROZEN 2026-09-03 · register cleanup (`D-07` closed; `D-05`/`D-16` split; `D-18` added)**
Depends on: every other document in this set.

---

## 1. How this plan works

Work is gated. A stage is not finished when the code is written; it is finished
when its **exit criteria** are demonstrably met. A stage does not start before
the one it depends on has exited.

Two rules make the gates real:

- **No financial feature is implemented before Stage 0 is reviewed and signed
  off.** That is the point of this document set.
- **No stage exits on a demo.** It exits on tests that run in CI, on a checklist
  that someone signed, or on a drill that was executed and recorded in `ops/`.

Sizes are relative (S / M / L / XL), not calendar promises. The indicative week
bands assume one full-time senior engineer plus founder time on product
decisions, and should be re-based after Stage 1 with real velocity rather than
defended as estimates.

## 2. Stage 0 — Product, domain and architecture freeze

**Deliverable:** the eight documents in `docs/`. Complete.

**Exit criteria**

- [ ] All eight documents reviewed end to end by the founder
- [ ] Every open decision in §5 is either answered or explicitly deferred with a
      named stage by which it must be answered
- [ ] The deltas from the master prompt's state enumeration
      (`STATE_MACHINES.md § 2`) are accepted or overruled — in particular the
      split between authorization (instruction frozen) and the point of no
      return (execution irreversible)
- [ ] The decision that post-settlement returns are a linked `SettlementReturn`
      aggregate rather than a settlement status is accepted, along with its
      consequence: a returned settlement still reads `SETTLED`
      (`STATE_MACHINES.md § 8.5`)
- [ ] The closed exception taxonomy (`STATE_MACHINES.md § 7`) is accepted as the
      only place execution-phase stalls may live
- [ ] The finality conditions F1–F6 are accepted as written, or amended
- [ ] The stack decision in `ARCHITECTURE.md § 1` is accepted
- [ ] `D-02` (regulatory posture) has a named owner and a target date. **Booking
      counsel does not gate Stage 1** — the rule is stated once in §2.1

Nothing below starts until this list is checked.

### 2.1 The `D-01` / `D-02` gating rule — stated once

Earlier revisions said three different things about when regulatory work gates
engineering. One rule, and it is this:

> **Counsel engagement does not gate Stage 1.** Stages 1–10 are built entirely
> against deterministic simulators and do not depend on the answer.
> **Counsel must be engaged and `D-01`/`D-02` scoped before Stage 4 exits**, a
> hard exit criterion on that stage. **The answers gate Stage 11**, which cannot
> start without them.

The reasoning is that a calendar booking is not a deliverable, and gating
engineering on someone else's availability is a gate that gets waived rather than
met. Stage 4 is the right place for the hard gate: it is far enough in that the
work is real and partner conversations are underway, and far enough from Stage 11
that a bad answer is still cheap to absorb.

Nothing else in this document may state a different rule. `D-01` and `D-02` carry
"Stage 11" in the register as the deadline for their *answers*, and Stage 4
carries the engagement gate.

---

## 3. The stages

### Stage 1 — Foundation · **L** · ~3–4 weeks

Monorepo, CI, Postgres, Drizzle schema and migrations, RLS, auth with mandatory
second factor, workspaces, memberships, the RBAC model from `SECURITY.md § 3.2`,
API keys, the append-only event and audit infrastructure, the transactional
outbox, the job runner, and `packages/ui` with the tokens and primitives from
`DESIGN_SYSTEM.md`.

**Exit criteria**

- [ ] RLS isolation test passes for every tenant-scoped table (`SECURITY.md § 2`)
- [ ] The dependency-boundary lint rule fails a PR that imports React into
      `packages/domain`
- [ ] The money-column CI check fails a migration that adds a `NUMERIC` amount
- [ ] Append-only tables reject `UPDATE` and `DELETE` from the application role
- [ ] A job enqueued in a rolled-back transaction does not run
- [ ] Storybook publishes every primitive with all five states from
      `DESIGN_SYSTEM.md § 10`

### Stage 2 — Beneficiaries, verification, preflight · **M** · ~2–3 weeks

Beneficiary and payout destination model, the verification provider port with a
deterministic simulator, IFSC and VPA validation, and the preflight rule engine
producing four-field requirements.

**Exit criteria**

- [ ] Every requirement in the rule set has a code, title, detail and action; a
      test fails any rule that does not
- [ ] The literal string "validation failed" appears in no user-facing string,
      API message or error code in the codebase
- [ ] Editing a destination **appends a new version** starting `UNVERIFIED`; the
      previous version keeps its verification and is not mutated (`INV-44`,
      `INV-45`)
- [ ] Verification records attach to a version, never to a destination
- [ ] A blocking `liquidity_facility_required` requirement is raised when the
      workspace has no active facility (`D-10`, closed)
- [ ] Preflight is deterministic: same input, same requirement list, and it is
      versioned so a re-run is explainable

### Stage 3 — Quotes, settlements, the state machine · **XL** · ~4–5 weeks

The heart of the product. Money primitives, the quote engine with FX and fees,
the settlement aggregate, and the full transition table from
`STATE_MACHINES.md § 4` with its guards, events and the database trigger.

**Exit criteria**

- [ ] The exhaustive illegal-transition test passes (`STATE_MACHINES.md § 10`, test 1)
- [ ] The terminality test passes: `SETTLED`, `FAILED` and `CANCELLED` accept no
      trigger in the vocabulary (`INV-38`)
- [ ] The `ACTION_REQUIRED` narrowness test passes: T04 is its only entry
      (`INV-37`)
- [ ] The cancellation-window test passes: honoured at each pre-PONR checkpoint
      with the right compensation, held rather than raced during an in-flight
      drawdown, and refused with `past_point_of_no_return` once
      `point_of_no_return_at` is stamped (`INV-35`, `INV-36`)
- [ ] The event-pairing trigger rejects a transaction that updates
      `settlements.status` without exactly one status event, and one that writes
      two; the table-driven test asserts the full named event set per transition
      and that T26 writes none (`INV-32`, `STATE_MACHINES.md § 10`, test 4)
- [ ] The totality test passes: every sweeper action in `STATE_MACHINES.md § 9`
      resolves to a numbered transition (test 5)
- [ ] The commitment-freeze test passes: after `AUTHORIZED`, editing the
      destination does not change what the settlement pays or displays, and
      `authorized_terms_hash` is unchanged (test 6)
- [ ] Property tests confirm rounding never invents or loses value, and that INR
      recipient amounts are exact (`INV-05`, `INV-06`)
- [ ] `recipient_amount` cannot be changed after `AUTHORIZED` — proven by a test
      that attempts it through every layer, including raw SQL as the app role
- [ ] Quote expiry is evaluated server-side; a client clock cannot extend it

### Stage 4 — Liquidity · **L** · ~3 weeks

Facility, limit, availability, atomic reservation, drawdown, repayment, the
double-entry ledger, and `MockLiquidityProvider`.

**Exit criteria**

- [ ] The concurrency test passes: N simultaneous reservations against a facility
      that can fund N−1 produce exactly one failure and never negative
      availability (`INV-20`)
- [ ] The facility projection is rebuildable from the ledger, and a deliberate
      divergence fires the alarm (`INV-23`)
- [ ] Release is idempotent under repeated cancel, fail and expiry, and
      releasing a `CONSUMED` reservation raises a typed error (`INV-22`)
- [ ] The repayment-capacity test passes: a repayment moves `available` only at
      `CONFIRMED`, never at `REQUESTED` or `SUBMITTED`; `UNKNOWN` resolves by
      status pull only (`INV-46`, `INV-47`)
- [ ] **Counsel engaged and `D-01`/`D-02` scoped** (§2.1) — hard gate
- [ ] The word "credit", "loan" and "balance" appear nowhere in customer-facing
      copy for this feature

### Stage 5 — Payout execution · **L** · ~3 weeks

`PayoutProvider` port, rail selection, payout attempts, provider idempotency,
signature verification, raw event persistence, status polling, and
`MockIndiaPayoutProvider` with the deterministic scenario table from
`ARCHITECTURE.md § 5.1`.

**Exit criteria**

- [ ] Every scenario in the simulator table is a passing, replayable test
- [ ] A redelivered provider webhook produces one state change and one event
- [ ] An unsigned or stale webhook is stored, alarmed and produces no transition
- [ ] `UNKNOWN` resolves only by authoritative status pull — a test proves no
      code path resubmits blindly (`INV-24`)

### Stage 6 — Reconciliation, finality, receipt · **L** · ~3 weeks

The comparison engine, the finality evaluator, receipt generation with
`content_hash`, and PDF rendering from the same template.

**Exit criteria**

- [ ] For each of F1–F6, a test where that single condition is absent and
      `SETTLED` is correctly refused
- [ ] Zero-tolerance reconciliation: a ₹5,000 shortfall produces `MISMATCH` and
      never settles (`INV-26`)
- [ ] UI, API and PDF receipts carry the same `content_hash` (`INV-29`)
- [ ] A confirmed return creates a `SettlementReturn`, repays the facility,
      attaches a return notice to the receipt, and leaves the settlement row and
      the receipt `content_hash` byte-identical (`INV-42`,
      `STATE_MACHINES.md § 8.4`)
- [ ] `SETTLED` has no outgoing transition in the compiled machine — verified by
      enumerating the transition table, not by inspection
- [ ] A return that fails its authoritative check is `REJECTED` and alarms
      (`INV-40`)
- [ ] The receipt is write-once: its bytes and `content_hash` are identical
      before and after any number of returns, and object storage grants the
      application no overwrite permission on the receipts prefix (`INV-48`)
- [ ] Each Return Notice is a separate artifact with its own hash and PDF; the
      optional composite export is a third artifact and replaces neither
- [ ] Cumulative confirmed returns never exceed the delivered amount under
      concurrent confirmation, and the database `CHECK` holds even without the
      lock (`INV-49`)
- [ ] The same real-world return arriving by webhook and by status pull creates
      exactly one `SettlementReturn` (`INV-50`)
- [ ] `return_observation_window` behaviour: a settlement settles without waiting
      out the window; a return outside it opens in `MANUAL_REVIEW`
      (`STATE_MACHINES.md § 8.6`)
- [ ] No finality condition, API field or UI element references a duration,
      countdown or hold on a settled settlement — `SETTLED` is unqualified
- [ ] A code search confirms no "mark as paid", force-settle or status-override
      path exists in any surface

### Stage 7 — Batches · **M** · ~2 weeks

Batch container, CSV import with row-level validation, API creation, aggregates.

**Exit criteria**

- [ ] A 500-row import with 40 invalid rows settles the 460 valid ones and blocks
      only the 40 (`INV-30`)
- [ ] CSV errors are per-row and name the column and the fix
- [ ] Import is idempotent — the same file twice does not double-create

### Stage 8 — Public API and developer experience · **L** · ~3 weeks

`/v1` exactly as specified in `API_CONTRACT.md`, webhook endpoints and signing,
request and event logs, replay, API keys UI, and the reference with copyable
examples in curl, TypeScript and Python.

**Exit criteria**

- [ ] Contract tests cover every endpoint, every error type, and the idempotency
      semantics including the same-key-different-body conflict
- [ ] The published signature verification snippets are themselves tested
- [ ] A `sk_test_` key addressing a live object returns `404`, not `403`
- [ ] Webhook delivery survives an endpoint that is down for an hour and shows
      every attempt in the event log

### Stage 9 — Internal Operations · **M** · ~2–3 weeks

Separately deployed ops surface: settlements, facilities, reservations,
drawdowns, repayments, providers, reconciliation queue, exceptions, provider
events, audit log.

**Exit criteria**

- [ ] Every operator action is attributed and audited with a mandatory reason
- [ ] No ops action can set `SETTLED` or edit a settled record
- [ ] Cross-tenant reads use the named role and are audited individually
- [ ] Exception resolution resumes a settlement at `exception_entered_from`

### Stage 10 — UI and UX hardening · **L** · ~3–4 weeks

The polish pass that makes the product credible: New Settlement to the standard
in `PRODUCT.md § 12.2`, settlement detail, Overview, responsive behaviour,
accessibility, motion, and the five states on every component.

**Exit criteria**

- [ ] WCAG 2.2 AA verified on composed screens, not only tokens
- [ ] The whole New Settlement flow is completable by keyboard alone
- [ ] `prefers-reduced-motion` removes all motion with no loss of meaning
- [ ] Loading, empty, error and disabled states exist everywhere and are reviewed
- [ ] An unbriefed payments operator completes a settlement without help — the
      Alex test, run with a real person, recorded

### Stage 11 — First real integrations · **XL** · ~4–6 weeks, partner-dependent

One real liquidity provider, one real India payout provider, as adapters behind
the existing ports. **Blocked on `D-01` and `D-02`.**

**Exit criteria**

- [ ] The adapter passes the same port contract suite as the simulator
- [ ] Zero changes required in `packages/domain` to add it — proven by the diff
- [ ] Real UTRs flow through to receipts
- [ ] Reconciliation runs against the provider's authoritative statement, not
      against its webhook
- [ ] Cut-off times, banking holidays and rail limits are modelled honestly and
      reflected in `estimated_delivery`

### Stage 12 — Production hardening · **L** · ~3 weeks

Observability, alarms, failure drills, penetration test, third-party review of
the finality and reservation paths, backup and restore drill, runbooks,
end-to-end sandbox verification.

**Exit criteria**

- [ ] Every alarm in `ARCHITECTURE.md § 11` fires in a drill
- [ ] Every failure drill in `ARCHITECTURE.md § 12` is executed and recorded
- [ ] Point-in-time restore verified against a real backup
- [ ] Pen test findings closed or explicitly accepted with a named owner
- [ ] The full nine-step demo flow passes in CI as an end-to-end test

## 4. Critical path and sequencing

```
1 Foundation
   └─ 2 Beneficiaries ──┐
   └─ 3 Settlements ────┼─ 4 Liquidity ─ 5 Payouts ─ 6 Finality ─┬─ 7 Batches
                        │                                         ├─ 8 API
                        │                                         └─ 9 Ops
                                                                      └─ 10 UI ─ 11 Real ─ 12 Prod
```

**The critical path is 1 → 3 → 4 → 5 → 6.** Everything that makes this product
credible sits on that line, and it is where the review attention and the senior
engineering time belong.

Parallelisable once Stage 1 exits: `packages/ui` component work can run
alongside Stage 2–3; the API reference can be written against `API_CONTRACT.md`
before Stage 8 builds it; Internal Ops screens can be sketched during Stage 5.

**Partner conversations start now, not at Stage 11.** Provider selection,
commercial terms and the answers to `D-01`, `D-02`, `D-04` and `D-06` have a lead
time measured in months. Starting them at Stage 11 makes Stage 11 the bottleneck.
The hard gate is Stage 4 exit (§2.1); starting earlier is strongly advised, and
starting later is how the timeline slips.

## 5. Open decisions

These cannot be resolved from the master prompt. Each names the stage by which it
must be answered.

| # | Decision | Why it matters | Needed by |
|---|---|---|---|
| **D-01** | Where may payment data be stored? | India applies data-localisation requirements to payment system data. Constrains hosting region, database location, backups, possibly provider choice. Follows from D-02. | **Answer:** Stage 11. **Scoped with counsel:** Stage 4 exit (§2.1) |
| **D-02** | What is INRSettle legally in this corridor — software on a licensed partner's rails, or a regulated entity? | Determines KYB depth, screening obligations, retention, reporting, and who owns the compliance programme. Settle with counsel; do not infer. | **Answer:** Stage 11. **Counsel engaged:** Stage 4 exit (§2.1) |
| ~~**D-03**~~ | ~~Does `FAILED` project onto `CANCELLED`, or does a sixth customer state `NOT_COMPLETED` exist?~~ | **CLOSED for V1 (Stage 3).** `FAILED` projects onto customer-facing `CANCELLED`; the `resolution` field carries the distinction from a customer cancellation; there is no `NOT_COMPLETED` and no sixth V1 customer state. The returns half was already closed in revision 2 — a return never projects onto `CANCELLED` and never changes the settlement's status. `FAILED` is now closed the same way and on the same grounds: in both cancellation and failure no value reached the beneficiary and the customer's liquidity is released, so they are one customer state, and a reason line carries the difference better than a state name. Rationale in `PRODUCT.md § 6`; projection in `STATE_MACHINES.md § 5`; wire shape unchanged (`API_CONTRACT.md § 7.4` already carried `resolution`). Reopening requires evidence that a specific resolution line failed a real customer, recorded as a scope change. | *closed* |
| **D-04** | `return_observation_window` per rail — **duration only** | **Role is settled and not open** (`STATE_MACHINES.md § 8.6`). This window is return-triage policy, not a finality concept: a return arriving inside it takes the normal `OBSERVED → CONFIRMED` path, one arriving outside it opens straight into `MANUAL_REVIEW` as an anomaly. It never gates `SETTLED` — F1–F6 are evidentiary, not temporal. Formerly called the "finality hold window"; renamed because that name implied `SETTLED` was provisional, which it is not. What remains open is the **duration per rail**, to be confirmed with the payout partner. Exposing a return-risk timestamp to customers is explicitly **not** a V1 question and is not carried as an open decision. | Stage 6 |
| **D-05** | Liquidity reservation TTL | Too short strands settlements; too long strands liquidity. **Split at Stage 4** — see below. | **Technical mechanism: CLOSED (Stage 4).** **TTL duration: EXTERNAL** |
| **D-05a** | *Technical mechanism* — how a reservation expires | **CLOSED (Stage 4).** Every reservation carries a `NOT NULL expires_at`, so a reservation without an expiry is unrepresentable. Expiry is V04, driven by the reservation sweeper, and drives T28; it releases through the same balanced ledger movement a cancellation uses and is idempotent with release (`INV-22`). A `CONSUMED` reservation never expires — the sweeper's index covers only `status = 'ACTIVE'` and the trigger refuses the transition regardless, so a drawdown that confirmed moments before the TTL elapsed cannot have its funding released. | *closed* |
| **D-05b** | *Provider-operational parameter* — the TTL duration | **EXTERNAL — pending real partner evidence.** The number depends on what the drawdown round-trip actually takes with the first liquidity partner, at what percentile, and how often it stalls rather than fails. It is supplied as configuration: `reserveLiquidity` takes `ttlSeconds` as a required argument with **no default** and rejects a non-positive value, because a default would become the answer by accident and the first person to notice would be a customer whose settlement expired. No duration is invented. | Stage 11 (partner evidence); mechanism already built |
| **D-06** | Regulatory purpose-code taxonomy and the document rules per purpose and amount band | Drives preflight and what the AD bank requires. Provider- and bank-specific. | Stage 2 |
| ~~**D-07**~~ | ~~Is separation of duties (creator ≠ authorizer) default-on for all workspaces, or configurable?~~ | **CLOSED (Stage 1).** **Configurable per workspace, defaulting off in Sandbox and on in Live.** Configurable rather than universally default-on because a one-person workspace cannot satisfy it and would be locked out of its own product; defaulting *on in Live* because that is where the blast radius of a compromised operator account is real, and a default that has to be turned on is a default nobody turns on. Sandbox defaults off so building and testing needs one account. Every change to the policy is separately audited — the setting is itself a control, so silently relaxing it must be as visible as using it. `settlement:authorize` remains the capability; separation of duties constrains *who* may exercise it, and does not become a second permission. Enforced at T08. | *closed* |
| **D-08** | Who bears FX movement between quote lock and execution, and what is the quote validity window? | The commercial core of the product. Determines re-quote policy, hedging need, and whether a locked quote can ever be broken. **Split at Stage 3** — see below. | **Technical invariant: CLOSED (Stage 3).** **Commercial parameter: EXTERNAL** |
| **D-08a** | *Technical invariant* — how a locked quote binds | **CLOSED (Stage 3).** There is no silent repricing after authorization. `AuthorizedTerms` freeze the quoted economics by value at T08 and are immutable thereafter (`INV-16`); a settlement executes on the terms it was authorized on or it does not execute. A change of intent is a cancellation plus a new settlement, never an edit. This holds whatever the commercial answer turns out to be. | *closed* |
| **D-08b** | *Commercial parameter* — quote validity window, and who bears FX movement between lock and execution | **EXTERNAL — pending real partner evidence.** The window duration, the re-quote policy and the bearer of intra-window movement are commercial and provider facts, not engineering choices, and depend on what the first liquidity and payout partners offer. They are supplied as configuration, never compiled in. Stage 3 ships the arithmetic and the configuration shape only; the sandbox values are labelled `sandbox_fixture` and a validator refuses to let a fixture claim to be anything else. No spread, hedging policy or quote window is invented here. | Stage 11 (partner evidence); config shape already built |
| **D-09** | Fee model — flat, basis points, tiered, or spread — and how it is disclosed | `INV-07` forbids hiding fees in the rate, so the model must stand on its own. **Split at Stage 3** — see below. | **Technical invariant: CLOSED (Stage 3).** **Commercial parameter: EXTERNAL** |
| **D-09a** | *Technical invariant* — how fees are represented and disclosed | **CLOSED (Stage 3).** Fees are explicit, itemised components on the quote and are never folded into the FX rate (`INV-07`). The disclosed rate is the rate applied; the fee is a separate line the customer can read, and the figures reconcile exactly under `DOMAIN.md § 3.3`. This is a representation guarantee and is independent of what any fee is eventually set to. | *closed* |
| **D-09b** | *Commercial parameter* — fee level and model shape (flat, basis points, tiered) | **EXTERNAL — pending real partner evidence.** The level and the model's parameters are commercial facts that depend on partner cost and market position. They are externally configured; Stage 3 invents no percentage, tier or schedule, and the sandbox schedule is labelled as a fixture. | Stage 11 (partner evidence); config shape already built |
| ~~**D-10**~~ | ~~Settlement path without a liquidity facility~~ | **CLOSED for V1.** A workspace may exist without an active facility — during onboarding it simply has no *Available to settle* figure — but **live settlement authorization and execution require one**. Preflight raises a blocking `liquidity_facility_required` requirement otherwise. The non-facility branch is removed from finality condition F2 (`STATE_MACHINES.md § 8.1`), and no second funding path is built without real customer or provider evidence. Reopening requires that evidence, recorded as a scope change. | *closed* |
| **D-11** | Beneficiary verification method for V1 — penny drop, provider lookup, or both — and who bears its cost and latency | Sits directly in the New Settlement flow, so it is a UX decision as much as a cost one. **Deliberately still OPEN**, pending real verification-provider evidence: the answer depends on what the first provider actually offers, charges and takes, and Stage 2 built the abstraction rather than guessing. Verification is a single port that all three candidate answers satisfy without a domain rewrite; `method` is recorded per verification so the choice is observable in data; and the name-match threshold is a versioned `NameMatchPolicySet` rather than a constant, so `80` exists only as labelled sandbox simulator configuration. Do not close this by tidying. | Stage 2 *(abstraction built; answer outstanding)* |
| **D-12** | Batch authorization semantics | Does one action authorize 143 settlements? What permission does that need, and what is the blast radius of a mistake? | Stage 7 |
| **D-13** | Cut-off times, banking holidays and rail windows | `estimated_delivery` must be honest. "Under 30 minutes" at 2am on a bank holiday is a broken promise. | Stage 5 |
| **D-14** | Partial credit policy — top up the shortfall, or reverse the whole settlement? | The mismatch case is real and the answer is commercial, not technical. `INV-26` guarantees it is never silent; it does not say what happens next. | Stage 6 |
| **D-15** | Where in the flow does the point of no return sit? | Its *mechanism* is settled and not open: the boundary is the commit of the dispatch transaction (`INV-36`), and cancellation is serialized against it by row lock. What remains open is **where in the flow that transaction is placed**. It currently sits immediately before the outbound payout call, which is the conservative placement. Some Indian payout providers allow a queued instruction to be withdrawn before a batch cut-off; if the first real partner does, dispatch can be split so the boundary lands at the provider's own cut-off instead, and the customer's cancellation window gets materially longer — a real product advantage. Confirm per rail with the payout partner. Moving it changes placement only; the commit-boundary rule and the locking discipline hold either way. | Stage 5 |
| **D-16** | Post-funding cancellation policy | Cancelling after a confirmed drawdown reverses a real funding movement. Is it always allowed, fee-bearing, or rate-limited? **Split at Stage 4** — see below. | **Compensation mechanism: CLOSED (Stage 4).** **Fee / rate-limit / abuse policy: EXTERNAL** |
| **D-16a** | *Technical mechanism* — what a post-funding cancellation does to the money | **CLOSED (Stage 4).** Compensation is decided by where the money got to, and by nothing else: an `ACTIVE` reservation is released; a `CONSUMED` one is **not** — it has no release path (`INV-22`), so a repayment is requested instead; a released or expired one owes nothing. The repayment restores no capacity when it is created: `drawn` falls on a `CONFIRMED` repayment and on nothing else (`INV-46`), so between the cancellation and the provider's confirmation the customer's *Available to settle* stays correctly reduced. Refused at three layers — domain, service, and a database trigger that rejects it from raw SQL. | *closed* |
| **D-16b** | *Commercial parameter* — whether it is always allowed, fee-bearing, or rate-limited | **EXTERNAL — pending real partner evidence.** Depends on what the reversal costs INRSettle, which depends on liquidity-partner terms that do not exist yet. No fee, no rate limit, no cooling-off period and no threshold is invented. What Stage 4 does provide is the evidence the policy will need: every cancellation after funding creates a `CANCELLATION_AFTER_DRAWDOWN` repayment against a named settlement, so the rate and cost of the behaviour are measurable before anyone has to price it. Ops alerting exists (`SECURITY.md § 3.2`). If the answer is "fee-bearing", the fee is a quote-time disclosure and lands under `D-09b`. | Stage 11 (partner evidence); mechanism already built |
| **D-17** | Commercial treatment of a returned settlement | The settlement was final and fees were charged; FX has since moved. Are fees refunded? Is the customer repaid at the original rate or the current one? Who bears the difference? Partial returns compound this. Distinct from `D-14`, which is about a mismatch at credit rather than a return after finality. | Stage 6 |
| **D-18** | Partial drawdown handling — what to do when a liquidity provider funds less (or more) than the drawdown asked for | **Technical invariant: CLOSED (Stage 4).** Drawdown evidence that does not match the requested facility, currency and amount **exactly** never produces `DRAWDOWN_CONFIRMED` and never consumes the reservation. Under-funding, over-funding, the wrong currency and the wrong facility are all refused before any write; the reservation stays `ACTIVE`, no ledger movement is posted, and the settlement stays in `DRAWDOWN_REQUESTED`. Under and over share one reason code with the direction in the detail, deliberately: splitting them would invite a caller to handle one, which is how a policy gets made by accident. **Production response policy: EXTERNAL.** What should *then* happen — retry, top up the shortfall, fail the settlement, or escalate to an operator — depends on whether the first real liquidity provider can fund partially at all, and on what a partial funding leg costs. No retry, top-up or failure economics is invented. Distinct from `D-14`, which is about value that reached the beneficiary; this is about value that never left the facility. **Required before Stage 11**, because that is the first real provider integration and the first time a partial drawdown can actually occur. | **Invariant closed (Stage 4).** **Policy: Stage 11** |

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Provider integration slips (Stage 11) | The whole timeline | Simulators make Stages 1–10 provider-independent; start partner conversations at Stage 0 |
| Regulatory posture answered late | Rework of hosting, retention, KYB | Counsel engaged and `D-01`/`D-02` scoped is a **Stage 4 exit criterion**; the answers gate Stage 11 (§2.1). Not a Stage 1 gate |
| Finality bug ships | Existential — a settlement that says settled and is not | Third-party review of the evaluator (Stage 12), F1–F6 tests (Stage 6), no override path anywhere |
| Reservation race under load | Facility over-allocation, real financial loss | Database-level enforcement plus the concurrency test as a Stage 4 gate |
| Scope creep from adjacent needs (FIRA/FIRC documentation, India→Global, treasury views) | V1 never ships | Non-goals in `PRODUCT.md § 15`; scope changes are recorded decisions, not conversations |
| Over-building Internal Ops before the pilot | Effort on screens nobody uses | Stage 9 is deliberately after finality; build what the pilot's exceptions actually demand |
| The product becomes another fintech dashboard | Loses the wedge | The Alex test is a Stage 10 exit criterion, run with a real person |
| A returned settlement still reads `SETTLED` and someone misreads a list | Customer acts on money that came back | Accepted consequence of keeping the record honest. Mitigated by the row marker, the `has_confirmed_return` filter, the return notice above the fold, and the `settlement.return_confirmed` webhook — all Stage 6 exit criteria, not nice-to-haves |
| Cancellation races an in-flight payout submission | Customer told "cancelled" while a real credit is live in India | PONR stamped at attempt, not acceptance (`INV-36`); cancellation is a flag honoured at checkpoints, never a direct transition; simulator scenarios `…0007` and `…0008` test exactly this |

## 7. What "V1 is done" means

A cross-border payments operator can, in sandbox and then in production:

1. Create and verify an Indian beneficiary
2. Create a ₹5,000,000 settlement, see `READY`, and get a recipient-first quote
3. Authorize it and watch it progress without needing to understand anything
   underneath
4. Receive a settlement receipt that reconciles to the paise
5. See one `ACTION_REQUIRED` case and resolve it from the copy alone
6. Run a 143-row batch where 4 rows are blocked and 139 settle
7. Receive a signed webhook, verify it with our published snippet, and replay it
8. Cancel an authorized settlement before the payout goes out, and see the
   reserved liquidity released
9. See a returned credit as a linked return on a settlement that still, correctly,
   reads `SETTLED`

…and a senior payments or liquidity executive watches that and immediately sees
where their infrastructure plugs in.

Not more features. Clarity, speed, trust, exactness, settlement integrity,
developer experience, operational reliability.

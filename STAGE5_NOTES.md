# Stage 5 — Payout execution

Scope per `IMPLEMENTATION_PLAN.md § 3`: *"`PayoutProvider` port, rail selection,
payout attempts, provider idempotency, signature verification, raw event
persistence, status polling, and `MockIndiaPayoutProvider` with the
deterministic scenario table from `ARCHITECTURE.md § 5.1`."*

Not built here: reconciliation, finality, receipts and `SettlementReturn`
(Stage 6); batches (Stage 7). **No real provider is integrated.**

---

## 1. What Stage 5 actually adds

Stage 3 built the dispatch transaction: it crosses the point of no return,
writes a durable `PayoutAttempt` with a stable idempotency key, and commits.
Stage 5 is **everything after that commit** — and the separation is not
stylistic, it is `INV-36(b)`:

> *"The provider is called by the job enqueued at (f), after commit. A network
> call must never be made while holding a row lock, and a transaction must never
> be rolled back after a call that may have created a real payout."*

So `submitDispatchedPayout` takes the connection **pool**, not a transaction.
Handing it a transaction would let a caller wrap a network call in a row lock,
and a type error is a better place to learn that than an incident. The same
shape as `runSettlementPreflight` and `reserveForSettlement`, for a related
reason each time.

Migrations `0007` (the provider-facing facts of an execution) and `0008` (one
column: what the rail says actually reached the beneficiary, as distinct from
what we instructed). `0008` is separate rather than an edit to `0007` because
`0007` has been reviewed, and rewriting a reviewed migration makes the review a
statement about a file that no longer exists.

---

## 2. The `PayoutProvider` port

Four methods from `ARCHITECTURE.md § 4`, and one rule shapes all of them:
**a command carries an idempotency key and a query carries a reference.**

When `submitPayout` does not answer, the caller cannot know whether a payout
exists in India. The only safe next move is to ask — and asking is possible only
because the submission's identity was decided *before* it was sent (`INV-25`)
rather than handed back by a response that never arrived. A port designed the
other way round makes `UNKNOWN` unrecoverable by construction.

`verifySignature` returns a discriminated verdict rather than a boolean or a
throw, because `INV-33` requires the raw event to be persisted whatever the
answer. "Invalid" is an outcome the caller must handle, not an exception it may
accidentally swallow.

---

## 3. Rail selection — `D-13` split

The customer never picks a rail and never sees one (`PRODUCT.md § 8`).
`selectRail` is a pure function over the provider's **declared capabilities**,
and every number in it comes from the provider at runtime: which rails exist,
their limits, which destination kinds they serve, whether each is open, and its
terminal-status SLA.

Cut-off times and banking holidays enter as the provider's own `open` flag
rather than as a calendar this codebase maintains. That is the deliberate part:
a partner that knows its windows can answer directly, and **a partner that
cannot is telling us something we need to know before we promise a delivery
estimate.** Reimplementing the Indian banking calendar would hide that signal
behind our own guess.

Three distinct refusals, because they need different responses: no rail for this
destination kind, no rail for this amount, and every fitting rail closed. The
third resolves by waiting; the first two do not.

Recorded in `decisions/0009-rail-selection-and-cutoffs.md`.

---

## 4. Provider idempotency and the two timeouts

The attempt's key is **derived, not read** — `payoutIdempotencyKey(settlementId,
attemptNumber)` — so a corrupted column cannot change what is presented to the
provider.

The simulator implements idempotency the way a real provider does: the same key
returns the same answer rather than paying again. Without that, every `INV-25`
test above it would be vacuous.

Two timeout scenarios exist because they must:

| Scenario | The call | The payout | The pull says |
|---|---|---|---|
| `…0005` | throws `PayoutTimeout` | **was** created | `CREDITED` |
| (unused suffix) | throws `PayoutTimeout` | was **not** created | `not_found` |

Both throw the same error carrying the same information. Nothing at the moment
of failure separates them, which is exactly why a status pull is the only
correct recovery — and why a mock that could produce only one of them would make
the whole `UNKNOWN` design untestable.

`not_found` is a first-class answer, kept distinct from an error: it is the
provider stating with authority that no money moved, and it is the only one of
the three answers that says so.

---

## 5. Webhook ingestion — the finality attack surface

`SECURITY.md § 4.2`'s seven steps, in its order, because the order *is* the
security property. Two of them deserve stating:

**A failed signature does not stop the event being stored.** An attacker's
forged event and a provider's misconfigured one look identical at the edge, and
the only way to tell them apart later is to have kept both. What a failed
signature stops is the *transition* — untrusted evidence never moves the
machine, checked at ingestion and again in `applyPayoutOutcome`.

**The timestamp tolerance is symmetric.** `|now − t| > 300s` fails in either
direction. Stale is the common case and is what a replay looks like; a check
written as `t > now + tolerance` would catch only the rare one. Tested at both
edges and both breaches.

The one input that does *not* reach the store is a body that cannot be parsed at
all — it has no provider event id, so there is nothing to deduplicate on and
nothing to file idempotently. It is refused at the edge and audited.

### `INV-43` — the mapping table is data

Provider vocabulary maps onto the closed taxonomy through a **versioned,
provider-specific table** loaded from `reference/payout-mappings/`, with the
same discipline as the Stage 2 preflight rule sets: immutable per version,
checksummed, and carrying a `source` so a sandbox fixture cannot present itself
as a provider's documented contract.

`interpretProviderCode` is a table lookup rather than a `switch` for one
specific reason: **a `switch` has a `default:` branch, and the tempting thing to
write there is a new code.** A table can only fail to match, and failing to
match has one defined behaviour, written down once.

An unmapped input:

- **never throws.** Not an implementation detail — the invariant. A provider
  that ships a new error code on a Friday must not be able to stop the queue,
  and the way to guarantee that is for interpretation to have no failure mode.
- **never widens the taxonomy.** The return type is the closed enum, so it
  cannot.
- **routes to the phase-appropriate default**, chosen from the one thing the
  transport still tells us — a webhook on a rejection topic is a rejection even
  when its code is novel. Both defaults are non-customer-actionable, because we
  do not know what happened and a card saying "action required" with no action
  is worse than a delay note.
- **alarms**, queryably: `provider_events.unmapped_code IS NOT NULL` is the
  operational view of "codes we have never seen", rather than a log line.

Validated at **load** time against the closed taxonomy, not at match time —
otherwise "the enum stays closed" would be true only of code, and this is a file
someone edits.

---

## 6. `UNKNOWN`, and the retry Stage 3 deferred

T18's frozen guard says *"Never auto-retry"*, and `sweepPayoutSla` is the
function that has to mean it: it moves the attempt to `UNKNOWN`, opens
`PAYOUT_STATUS_UNKNOWN`, and there is no code path from it to a submission.

Three paths are proved to refuse an `UNKNOWN` attempt, each for its own reason:

| Path | Refusal | Enforced by |
|---|---|---|
| `submitDispatchedPayout` | `attempt_not_awaiting_submission` | the attempt is no longer `SUBMITTED` |
| `dispatchPayout` | `attempt_status_unknown` | `allocateAttemptNumber`, before the boundary check |
| `retryPayout` | `retry_requires_authoritative_rejection` | `UNKNOWN` is not a rejection |

**Retry** is what Stage 3 deliberately left undone, on the grounds that *"the
retry policy depends on what the provider said, which is Stage 5's knowledge."*
The knowledge turns out to be narrow: a further attempt is permitted only from
an attempt the provider has **definitively rejected**. `UNKNOWN` is the absence
of an answer, not a rejection, and the domain, the partial unique index and this
service all refuse it independently.

### A pull resolves the attempt, not the settlement

Worth stating because it surprised the tests. After T18 the settlement sits in
`EXCEPTION`, and the only ways out are T22 (resume) and T23 (fail) — both of
which require an attributed human decision. So a status pull updates the
*attempt* and returns `settlementAwaitingResolution: true`; it does not move the
settlement. **A pull answers what the provider did; it does not decide what an
operator should do about it.** The same shape as the Stage 4 drawdown pull, and
correct for the same reason.

---

## 7. Stage 5 exit matrix

| Requirement | Status | Evidence |
|---|---|---|
| Every scenario in the simulator table is a passing, replayable test | ✅ | `payout-execution.test.ts`; **all 15 rows are executable tests** — 6 end to end in Stage 5, 4 replaying a closed stage's real behaviour, 5 running the Stage 5 layer and asserting a typed handoff. A runtime check fails the suite if any row has no test — see below |
| A redelivered provider webhook produces one state change and one event | ✅ | replayed ×10: one `settlement.payout_confirmed`, one stored provider event. Also proved for the same outcome under a *different* event id |
| An unsigned or stale webhook is stored, alarmed and produces no transition | ✅ | bad signature, stale and future timestamps: all stored with `signature_valid = false`, audited, settlement unmoved |
| `UNKNOWN` resolves only by authoritative status pull; no code path resubmits blindly (`INV-24`) | ✅ | three refusal paths above, each asserted; one attempt remains, still `UNKNOWN` |
| `INV-25` — a stable key per attempt, derived not read | ✅ | simulator idempotency proved; retry mints attempt 2 with a different key |
| `INV-33` — raw events persisted verbatim before interpretation | ✅ | trigger freezes payload and signature verdict even from the app role |
| `INV-43` — unmapped input never throws, never widens the taxonomy | ✅ | `payouts.test.ts` + scenario `…0009` end to end, with the queue proved still draining |
| `INV-36` — a failed outbound call does not un-cross the boundary | ✅ | scenario `…0010`: PONR stays stamped, one attempt, resolved by pull |
| T16 requires a well-formed UTR | ✅ | absent, empty and malformed all refused; `payout_credit_has_utr` at the database |
| Rail selection never invents a cut-off or a limit | ✅ | every number from `capabilities()`; `D-13` split in ADR 0009 |

### Simulator coverage — all fifteen rows, executable

The criterion says *every* scenario in the table is a passing, replayable test.
An earlier cut of this stage exercised six rows and **declared** the other nine
as owned by later stages. That was not the criterion. A declaration is a claim
about work someone will do; the gate asks for tests, and a row that only carries
a sentence is a row nobody has run.

So every row runs now, and what it runs depends on who owns finishing it:

- **Stage 5's own six** run end to end: dispatch, submit, provider answer,
  machine transition.
- **Four rows owned by closed stages** (2, 3 and 4) run those stages' *real*
  behaviour. Replaying a finished stage is not implementing one early — the code
  already exists and is already signed off; what was missing was a test proving
  the frozen table's row is the behaviour that code has.
- **Five rows owned by Stage 6** run the part Stage 5 genuinely owns — what the
  rail did, recorded on the payout attempt — and then assert a **typed
  handoff**: what Stage 5 produced, who consumes it, what they must do, and
  under which invariants. Same discipline as the T30/R04 deferred companion, and
  for the same reason: a prose note is something a later reader has to find and
  believe; a typed field is something a test asserts and a build fails on.

| Row | Owner | What its test actually runs |
|---|---|---|
| `…0000` | Stage 5 | accepted → credited with a well-formed UTR → `PAYOUT_CONFIRMED` |
| `…0001` | Stage 6 | credits ₹5,000 short; `credited_minor` and `amount_minor` differ on the attempt. **Handoff:** `INV-26` |
| `…0002` | Stage 5 | destination rejection, mapped, customer-actionable |
| `…0003` | Stage 5 | SLA elapses → `UNKNOWN` → exception |
| `…0004` | Stage 6 | P08 `CREDITED → RETURNED`; UTR and credit timestamp survive; **not one** new settlement event. **Handoff:** `INV-42`, `INV-48` |
| `…0005` | Stage 5 | submit times out, the payout existed, the pull resolves it |
| `…0006` | Stage 2 | the real sandbox verification: account confirmed, name refused by the versioned policy, beneficiary never reaches `verified`. **Handoff:** `INV-45` |
| `…0007` | Stage 4 | the real funding leg: T26 annotates mid-drawdown, T27 refuses before a checkpoint, then honours at `DRAWDOWN_CONFIRMED` as a *repayment*. **Handoff:** `INV-22`, `INV-35` |
| `…0008` | Stage 3 | the real boundary: cancellation after the dispatch commit refused with `past_point_of_no_return`, and audited. **Handoff:** `INV-36` |
| `…0009` | Stage 5 | a code no table has seen: ingested, defaulted, alarmed, queue draining |
| `…0010` | Stage 5 | the call fails after commit; the pull resolves it without a second dispatch |
| `…0011` | Stage 6 | three returns (two summing to exactly the delivered amount, then a third), all three stored verbatim with their own amounts; the attempt moves once. **No total is kept and no cap applied.** **Handoff:** `INV-49` |
| `…0012` | Stage 6 | one return, two channels: the webhook applies it, the pull agrees and is idempotent, one provider event stored. **Handoff:** `INV-50` |
| `…0013` | Stage 4 | the real repayment: `SUBMITTED → UNKNOWN` restores nothing, a pull confirms, `drawn` moves, the ledger still balances. **Handoff:** `INV-46`, `INV-47` |
| `…0014` | Stage 6 | a return whose stated `occurred_at` is 120 days after the credit, stored verbatim; no window applied, because `D-04` is open. **Handoff:** `INV-40` |

Coverage is **counted, not claimed**. Each scenario test registers its own
suffix at runtime, and the last test in the suite fails if the set is not the
whole table — including a row added to the table later, which is the case a
hand-maintained list misses silently.

---

## 8. Decisions

| # | Technical mechanism | External parameter |
|---|---|---|
| `D-13` cut-offs, holidays, rail windows | **CLOSED.** Rail selection is ours, from declared capabilities; three distinct refusals; SLA stored per attempt as dispatched. | **EXTERNAL.** Every number — rails offered, limits, open/closed, SLA. No cut-off, calendar or delivery estimate invented. |
| `D-15` where the PONR sits | **CLOSED and unchanged.** The commit of the dispatch transaction. Stage 5 *verified* its three properties for the first time by building the call. | **OPEN on placement.** A split dispatch needs a partner with queue-and-withdraw, an authoritative withdrawability check, and the `D-13` cut-offs. Depends on `D-13`. |

`decisions/0009-rail-selection-and-cutoffs.md`,
`decisions/0010-ponr-placement.md`.

Unchanged and still open: `D-06`, `D-11`, `D-08b`, `D-09b`, `D-05b`, `D-16b`,
`D-18` (policy half). `D-01`/`D-02` remain the Stage 4 gate and the Stage 11
blocker.

---

## 9. Clean CI

```
EXIT=0
Test Files  45 passed (45)
     Tests  906 passed (906)
```

Stage 5 added **70 tests**: 18 payout domain (rail selection, UTR, mapping), 17
mock provider, 33 execution end to end against a real database, 2 on the
money-column gate below.

---

## 10. Defects and deviations found

1. **The two simulators claimed the same field at different widths.** This is
   the one genuine deviation, and it is worth reading carefully.

   `ARCHITECTURE.md § 5.1` selects scenarios by the last **four** digits of the
   sandbox account number. The Stage 2 verification simulator, built before that
   table was implemented, selects by the last **two**. Both read the same field.
   So `…0002` was simultaneously "payout rejected: account closed" in the frozen
   document and `failed_account_closed` in Stage 2's own table — and since an
   unverified beneficiary never reaches a payout, **every four-digit payout
   scenario was unreachable.**

   Resolved in favour of the signed baseline: the verification simulator now
   consults the frozen four-digit table first. `…0006` maps to
   `confirmed_weak_name`, which is the name-mismatch scenario the frozen table
   assigns to it — note that Stage 2's own `06` meant something else entirely
   ("the bank refused the check"), and where the two disagree the baseline
   wins. Every other frozen suffix verifies cleanly, because those scenarios are
   about a later leg and failing them at verification would test the wrong
   thing. Account numbers outside the frozen table keep Stage 2's richer
   two-digit behaviour.

2. **A pull could not move a settlement out of `EXCEPTION`, and should not.**
   The first cut had `applyPayoutOutcome` attempt T16 unconditionally, which
   failed once T18 had opened an exception. Correct behaviour is to resolve the
   attempt and leave the settlement for an attributed T22/T23 — the same
   conclusion Stage 4 reached for drawdowns.

3. **Stage 5's new `CHECK` constraints caught three older fixtures.**
   `payout_credit_has_utr`, `payout_credit_is_timed` and
   `payout_return_follows_credit` rejected Stage 3 and Stage 4 tests that forged
   a `CREDITED` attempt with no UTR. The constraints are right — a credit we
   cannot evidence is a receipt we could not honour — and the fixtures are now
   more faithful for supplying one.

4. **The RLS discovery gate caught the new global table.**
   `provider_mapping_tables` is versioned reference data, identical for every
   workspace, so it is registered in `GLOBAL_TABLES` with a justification rather
   than given a tenant shape. Scoping it per workspace would mean one provider
   code could be interpreted two different ways in one system.

5. **The money-column gate could not see a column added by `ALTER TABLE`.**
   Found while adding `payout_attempts.credited_minor`. `check-money-columns.mjs`
   parsed `CREATE TABLE` bodies only, one file at a time — so every money column
   a later migration adds was unchecked, including `amount_minor` in `0007`. That
   is the shape a schema that grows actually has, which makes it the shape the
   gate most needed to cover.

   Now two passes: collect every column of every table across every migration
   (`CREATE TABLE` *and* `ALTER TABLE … ADD COLUMN`), then judge. The pairing
   rule also generalised, because the per-file version could not express what it
   meant: an amount satisfies `INV-02` if it has its own `<stem>_currency`, **or**
   if its table declares exactly one currency column of any name. A second
   currency on the table withdraws that reading, since at that point "the table's
   currency" is not a thing that exists. Two new fixtures test both halves.

6. **An attempt's `dispatched_at` is immutable, including to the superuser.**
   Discovered while trying to age a row past its SLA in a test. The refusal is
   correct — an attempt whose dispatch time could be edited is one whose SLA
   breach could be manufactured or hidden — so the test shortens the SLA
   instead, and pays a second of real time for it. The sweeper deliberately
   takes no injectable `asOf`: an elapsed SLA is a fact about time, not
   something a caller may assert.

---

## 11. What Stage 6 inherits

Enumerable rather than remembered: `handoffsTo('Stage 6')` returns the list, so
Stage 6 does not have to read this file to find out what is waiting for it.

- `PayoutAttempt` reaching `CREDITED` with a UTR and a `credited_minor`, and P08
  (`CREDITED → RETURNED`) recorded at the attempt level. The `SettlementReturn`
  aggregate, the `INV-49` cap and the `INV-50` double-key deduplication are
  Stage 6's.
- `credited_minor` is nullable on purpose, and `NULL` is a third case rather
  than a missing one: many providers credit what they were instructed and report
  no figure at all. Defaulting it to `amount_minor` would be us asserting an
  amount the rail never stated, which is the mistake that makes a shortfall
  unrepresentable. So reconciliation sees *the rail said nothing*, *the rail
  agreed*, and *the rail differed* — three cases, not two.
- Five simulator scenarios waiting on that aggregate: `…0001`, `…0004`, `…0011`,
  `…0012`, `…0014`. Each already has a passing test proving Stage 5's half is
  really there, and each carries the obligation and the invariants for the other
  half.
- Deliberately **not** built here: no `returned_minor` on the attempt. Return
  amounts arrive as provider events, which `INV-33` already stores verbatim; a
  running total on the attempt as well would be a second place for one fact to
  live, and the two would eventually disagree.
- T19 (`PAYOUT_CONFIRMED → RECONCILING`) is untouched, and the R04 deferred
  companion from Stage 3 is still declared and still owed.

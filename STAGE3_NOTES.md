# Stage 3 — Money, quotes, the settlement machine, authorization

Built against the frozen Revision 3 baseline (with the R4 accessibility and R5
product amendments). All eight `docs/` digests in `README.md` verify unchanged.

Stage 3 scope was: exact money primitives for quotes and settlements, the Quote
aggregate and its lifecycle, the Settlement aggregate, the complete frozen
transition machine, the customer-status projection, authorization with immutable
`AuthorizedTerms`, cancellation semantics, point-of-no-return preparation, and
the exception taxonomy the machine needs.

**Not implemented, and nothing pretends otherwise:** liquidity mechanics
(Stage 4), payout provider execution (Stage 5), reconciliation, finality and
receipts (Stage 6), batches, and real providers. Transitions that depend on
those stages are modelled as *contracts and guards*, exercised by deterministic
test fixtures, and refuse rather than default when a guard goes unanswered.

---

## 1. State-machine implementation map, T01–T30

The frozen table lives as **data** in one place —
`packages/domain/src/settlements/transitions.ts` — and the implementation map
below is machine-extracted from it, not transcribed.

| # | From | Trigger | To | Status event | Companions |
|---|---|---|---|---|---|
| T01 | — | `create` | `DRAFT` | `settlement.created` | — |
| T02 | `DRAFT` | `run_preflight` | `PREFLIGHTING` | `settlement.preflight_started` | — |
| T03 | `PREFLIGHTING` | `preflight_passed` | `READY` | `settlement.ready` | `settlement.preflight_completed` |
| T04 | `PREFLIGHTING` | `preflight_blocked` | `ACTION_REQUIRED` | `settlement.action_required` | `settlement.preflight_completed` |
| T05 | `ACTION_REQUIRED` | `requirement_resolved` | `PREFLIGHTING` | `settlement.preflight_started` | — |
| T06 | `READY` | `attach_quote` | `QUOTED` | `settlement.quoted` | `quote.locked` |
| T07 | `QUOTED` | `quote_expired` | `READY` | `settlement.ready` | `quote.expired` |
| T08 | `QUOTED` | `authorize` | `AUTHORIZED` | `settlement.authorized` | `quote.consumed` |
| T09 | `AUTHORIZED` | `begin_reservation` | `LIQUIDITY_RESERVING` | `settlement.liquidity_reservation_started` | — |
| T10 | `LIQUIDITY_RESERVING` | `reservation_succeeded` | `LIQUIDITY_RESERVED` | `settlement.liquidity_reserved` | `facility.reservation_created` |
| T11 | `LIQUIDITY_RESERVING` | `reservation_failed` | `EXCEPTION` | `settlement.exception_opened` | — |
| T12 | `LIQUIDITY_RESERVED` | `request_drawdown` | `DRAWDOWN_REQUESTED` | `settlement.drawdown_requested` | — |
| T13 | `DRAWDOWN_REQUESTED` | `drawdown_confirmed` | `DRAWDOWN_CONFIRMED` | `settlement.drawdown_confirmed` | `facility.drawdown_confirmed` |
| T14 | `DRAWDOWN_REQUESTED` | `drawdown_failed` | `EXCEPTION` | `settlement.exception_opened` | `facility.reservation_released` |
| T15 | `DRAWDOWN_CONFIRMED` | `dispatch_payout` | `PAYOUT_SUBMITTED` | `settlement.payout_submitted` | — |
| T16 | `PAYOUT_SUBMITTED` | `payout_credited` | `PAYOUT_CONFIRMED` | `settlement.payout_confirmed` | — |
| T17 | `PAYOUT_SUBMITTED` | `payout_rejected` | `EXCEPTION` | `settlement.exception_opened` | — |
| T18 | `PAYOUT_SUBMITTED` | `payout_timeout` | `EXCEPTION` | `settlement.exception_opened` | — |
| T19 | `PAYOUT_CONFIRMED` | `begin_reconciliation` | `RECONCILING` | `settlement.reconciliation_started` | — |
| T20 | `RECONCILING` | `reconciled_matched` | `SETTLED` | `settlement.settled` | `settlement.reconciled`, `receipt.available` |
| T21 | `RECONCILING` | `reconciled_mismatch` | `EXCEPTION` | `settlement.exception_opened` | `settlement.reconciled` |
| T22 | `EXCEPTION` | `resolve_resume` | *(entered-from)* | `settlement.exception_resolved` | — |
| T23 | `EXCEPTION` | `resolve_fail` | `FAILED` | `settlement.failed` | one of: release \| repayment |
| T24 | `EXCEPTION` | `resolve_cancel` | `CANCELLED` | `settlement.cancelled` | one of: release \| repayment |
| T25 | `DRAFT`, `READY`, `QUOTED`, `ACTION_REQUIRED` | `cancel` | `CANCELLED` | `settlement.cancelled` | `quote.expired` (if attached) |
| T26 | `AUTHORIZED` … `DRAWDOWN_CONFIRMED` | `request_cancellation` | *(no change)* | **none** | `settlement.cancellation_requested` |
| T27 | `AUTHORIZED`, `LIQUIDITY_RESERVED`, `DRAWDOWN_CONFIRMED` | `cancellation_honoured` | `CANCELLED` | `settlement.cancelled` | one of: release \| repayment |
| T28 | `LIQUIDITY_RESERVED` | `reservation_expired` | `EXCEPTION` | `settlement.exception_opened` | `facility.reservation_expired` |
| T29 | `DRAWDOWN_REQUESTED` | `drawdown_timeout` | `EXCEPTION` | `settlement.exception_opened` | — |
| T30 | `RECONCILING` | `reconciliation_stalled` | `EXCEPTION` | `settlement.exception_opened` | — |

**Two deliberate deviations from the frozen table, both later-stage:**

- **T30's `R04` companion is not emitted.** The frozen row names an `R04`
  annotation *on the reconciliation record*, and reconciliation records are
  Stage 6. Emitting a companion about an aggregate that does not exist would be
  a fabricated event. The settlement-side status event is emitted in full.
- **T22 resumes to `exception_entered_from`**, which is data on the exception
  rather than a column in the table. The evaluator requires it and refuses if it
  is missing rather than guessing a destination.

### How a transition is applied

`packages/app/src/settlement-transition.service.ts` is the only writer of
`settlements.status`. Every status-changing transaction:

1. takes the settlement row lock (`SELECT … FOR UPDATE`);
2. asserts the expected source state and evaluates the row's guards;
3. writes exactly one status event, plus any named companions;
4. records the actor and bumps the optimistic `version`;
5. commits atomically, or does none of it.

**Unanswered guards are their own error.** `evaluateTransition` distinguishes
`guard_failed` from `guard_unanswered`: a guard the caller did not supply is
rejected rather than defaulted to false. Defaulting would look safe while
silently hiding a caller that forgot to load state — the failure mode would be a
settlement that refuses for the wrong reason and an engineer debugging the wrong
guard.

**Later-stage guards are contracts, not stubs.** `LATER_STAGE_GUARDS` names the
guards Stage 4 and Stage 5 will answer (`facility_active`,
`sufficient_availability`, `active_reservation_exists`,
`provider_event_verified`). Stage 3 never fakes them; the test harness answers
them explicitly, which is why a Stage 4 implementation slots in without the
machine changing.

---

## 2. Quote lifecycle

`ACTIVE → LOCKED → CONSUMED`, and `ACTIVE`/`LOCKED → EXPIRED | VOID`, as five
numbered transitions Q01–Q05 in `packages/domain/src/quotes/quote.ts`.

- **Immutable after creation.** `IMMUTABLE_QUOTE_COLUMNS` is enforced by the
  `quotes_immutable` trigger; only `status` and the consumption fields move.
  Repricing creates a new quote — there is no edit path.
- **Expiry is the database clock.** `databaseNow(tx)` reads `now()` inside the
  transaction. A client-supplied timestamp never decides whether a quote is
  live, which is the difference between an expiry rule and a suggestion.
- **One quote, one settlement.** Two independent database constraints:
  `quotes_single_consumption` (a partial unique index on the consuming
  settlement) and `settlements_quote_once` (unique on `settlements.quote_id`).
  Belt and braces on purpose — this is the constraint that stops one priced rate
  funding two payouts.
- **Same workspace and environment.** Checked in `checkQuoteAttachable` and
  again at authorization; a quote from another tenant is not merely invisible,
  it is refused.
- **Recipient-first by default.** `fundingForRecipient` is the primary
  direction; the recipient INR amount is never rounded (`INV-05`), and the
  funding side rounds **up** with the sub-minor-unit residual disclosed
  (`INV-06`).

### Exact money and FX

`packages/money/src/fx.ts` — all arithmetic on `bigint` and exact decimal
strings. There is no `number` anywhere in the money path, and the ESLint
money-column gate plus `check:money-columns` keep floating point out of the
schema too. FX rates carry a fixed scale of 10 and are parsed from decimal
strings, never from floats.

24 property and edge tests cover: recipient-first exactness, funding-side
round-up, residual disclosure, cross-currency rejection (`INV-03`), and
round-trip stability.

### Sandbox pricing — `D-08`/`D-09` remain open

`SANDBOX_PRICING` carries `source: 'sandbox_fixture'` and a description saying
so. `validatePricingConfig` rejects a fixture that tries to present itself as
`treasury_approved` or `provider_contract`. The New Settlement screen renders a
provisional notice above every quote, and a UI test fails if it is missing:
sandbox rates must never read as a commercial commitment.

---

## 3. AuthorizedTerms — shape, hash, immutability

`packages/domain/src/settlements/authorized-terms.ts`.

The frozen snapshot captured at T08 carries the beneficiary identity, the exact
`destination_version_id`, the recipient INR amount, the purpose (code and
regulatory code), the funding currency and amount, the `quote_id`, the FX rate,
the fee components, and the rounding residual.

`authorized_terms_hash` is SHA-256 over a **canonical** object: keys emitted in
a fixed order, amounts as decimal strings, no floats, no timestamps. The hash is
therefore reproducible from the snapshot alone, which is what makes it evidence
rather than decoration.

**The immutability proof.** `settlement-lifecycle.test.ts` authorizes a
settlement, records the hash, then mutates the live world underneath it — edits
the beneficiary's payout destination (creating a new unverified version),
re-prices, and voids the quote — and re-reads the settlement. The frozen
instruction is byte-for-byte identical and the hash is unchanged. The database
backs this up: `protect_settlement_row` rejects any write to
`authorized_terms`, `authorized_terms_hash` or `destination_version_id` after
authorization, and the enforcement suite attacks it with raw SQL as the runtime
role.

---

## 4. Database enforcement

Migration `0005_settlements.sql`. Five new tables — `quotes`, `settlements`,
`payout_attempts`, `settlement_exceptions` — plus `settlement_status_events`,
the vocabulary table the pairing trigger reads.

| Control | Mechanism |
|---|---|
| Status/event pairing (`INV-32`) | `assert_status_event_pairing`, a **deferred constraint trigger**: a transaction that changes `settlements.status` must write exactly one status event, matched by `events.txid` |
| Terminal write protection (`INV-38`) | `protect_settlement_row` rejects **any** field write to a `SETTLED`/`FAILED`/`CANCELLED` row — not merely a status change |
| Instruction immutability (`INV-16`) | the same trigger freezes `authorized_terms`, its hash and `destination_version_id` once `authorized_at` is set |
| Quote single consumption | `quotes_single_consumption` + `settlements_quote_once`, two independent unique indexes |
| Quote immutability (`INV-13`) | `quotes_immutable` trigger over the frozen column list |
| Point of no return (`INV-36`) | `point_of_no_return_at` is write-once; `payout_attempts_one_per_settlement` and `payout_attempts_fingerprint` make a durable attempt unique |
| Optimistic locking | `settlements.version`, bumped by the transition service, asserted on write |
| Row locking | dispatch and cancellation both take `SELECT … FOR UPDATE` on the same settlement row |
| Attributed resolution | `resolution_is_attributed` CHECK: a resolved exception must carry an actor and a reason |
| One open exception | `settlement_exceptions_one_open`, a partial unique index |
| Tenant isolation (`INV-31`) | RLS ENABLE + FORCE and a policy on all four tenant tables; discovered automatically by the Stage 1 catalogue gate |

`settlement-db-enforcement.test.ts` — **52 tests** — attacks every one of these
as `inrsettle_app` using raw SQL, including direct `UPDATE settlements SET
status = …`, terminal-row writes, quote double-consumption, and a second payout
attempt.

---

## 5. Authorization and cancellation

**Authorization (T08)** re-checks everything at the moment of authorizing rather
than trusting an earlier check:

- preflight is re-run *now* and must still return `ready`;
- the exact destination version must still be `VERIFIED` (`INV-11`);
- the quote must be `ACTIVE`/`LOCKED`, unexpired against the database clock,
  unconsumed, same workspace and environment, matching amount;
- the actor must hold `settlement:authorize`;
- Stage 1's separation-of-duties policy is evaluated unchanged — not
  re-implemented — and a refusal writes an audit record before returning.

**Cancellation** keeps authorization distinct from irreversibility:

- **Before authorization** (T25): immediate, from `DRAFT`, `READY`, `QUOTED`,
  `ACTION_REQUIRED`.
- **After authorization** (T26): records `cancellation_requested_at` and emits
  `settlement.cancellation_requested`. **No status change** — it is an
  annotation, and the machine is unmoved.
- **At a checkpoint** (T27): the request takes effect from `AUTHORIZED`,
  `LIQUIDITY_RESERVED` or `DRAWDOWN_CONFIRMED`, pre-PONR only.

**Stage 4 compensation is not faked.** T23, T24 and T27 declare a
`companionChoice` — release a reservation *or* request repayment — and Stage 3
records which branch applies without implementing either. The choice is in the
table, visible, and unanswered rather than invented.

---

## 6. The point of no return

`INV-36` is preserved exactly: the PONR is the **commit of the dispatch
transaction**, not the provider call.

`dispatchPayout` takes the settlement row lock, re-asserts that a rail is
selected, that the frozen destination version is still `VERIFIED` and that
`cancellation_requested_at IS NULL`, allocates the attempt number, then stamps
the timestamp and writes a durable `payout_attempts` row inside the same
transaction.

**No provider is called.** There is no `PayoutProvider` port implementation in
Stage 3 and no outbound call; the boundary is exercised by a deterministic test
dispatch.

The contention test runs cancellation and dispatch concurrently against the same
settlement and asserts there is **no outcome in which both a `CANCELLED`
settlement and a durable payout attempt exist**. Exactly one wins, they
serialize on the row lock, and the loser is refused rather than queued.

### Payout attempt identity — `INV-24`, `INV-25`

The first cut derived idempotency from `settlementId + authorizedTermsHash`.
That was wrong in both directions and is now replaced.

It was wrong because the hash is **constant for the life of a settlement**: two
legitimate attempts would present the same key, and a provider honouring
idempotency would answer the second with the first attempt's result — a payout
that was never sent reading as sent. And it was wrong in reverse, because a
*change* to the instruction would mint a fresh key, making an instruction edit a
way to conjure a second real payout.

The model now:

- `payout_attempts.attempt_number` — explicit, `>= 1`, monotonic per settlement,
  `UNIQUE (settlement_id, attempt_number)`.
- `idempotency_key = payout:v1:<settlement_id>:<attempt_number>` — a pure
  function of those two inputs and nothing else, globally unique. Readable
  rather than hashed on purpose: during an incident this string is what somebody
  types into a provider dashboard.
- `allocateAttemptNumber` (pure, in the domain) decides which number a dispatch
  uses, from every attempt read under the settlement row lock. A retry of an
  in-flight submission returns the *same* number and key; a new number is only
  allocated after the previous attempt is authoritatively finished **and**
  permits another — which only `REJECTED` does.
- `UNKNOWN` is deliberately **not** terminal. It means "we do not know whether
  money moved", and the only correct response is a status pull with the key
  already issued. Dispatch refuses with `attempt_status_unknown` rather than
  allocating attempt 2.
- A partial unique index, `payout_attempts_one_in_flight ON (settlement_id)
  WHERE status NOT IN ('CREDITED','REJECTED','RETURNED')`, permits historical
  terminal attempts and makes two simultaneous non-terminal attempts impossible
  at the database, not merely unlikely in the service.
- `protect_payout_attempt()` freezes `settlement_id`, `attempt_number`,
  `idempotency_key`, `destination_version_id` and `dispatched_at`, and refuses
  every terminal→non-terminal move except `CREDITED → RETURNED` (P08).

`UPDATE` on `payout_attempts` is now granted to `inrsettle_app` — the attempt
has a P01–P08 lifecycle, so it must advance — and the trigger, not the grant, is
what keeps its identity honest. `DELETE` is granted nowhere.

Stage 3 stops at allocation. Once the boundary is crossed, a further call
returns the existing attempt (a retry) or is refused; **starting** attempt 2 is
the Stage 5 retry path. Stage 3 models the identity and declines to mint it,
which is a different thing from pretending it cannot exist.

---

## 7. Exceptions

The closed taxonomy, ten codes, no `OTHER` — enforced by the TypeScript union
*and* by a `settlement_exception_code` Postgres enum, so `SELECT
'OTHER'::settlement_exception_code` fails at the database.

Every code carries a phase, an actionability classification and customer copy.
Per the frozen § 7, that copy is a **four-field `Requirement`** for the two
customer-actionable codes and a one-sentence delay note for the other eight —
because a requirement without an action would render as a card with a dead
button.

Unknown provider codes are explicitly *not* Stage 3's problem: the settlement
domain accepts only known INRSettle codes, and the provider-to-taxonomy mapping
remains a versioned data table owned by the provider layer.

### T22 resume integrity

T22 is kept **dynamic** — it resumes to `exception_entered_from` rather than
being expanded into five near-identical static rows that would drift from each
other. The cost of that design is that the recorded origin is effectively a jump
target, so the whole question is whether anything can choose it. Nothing can:

1. **It is written by the database, not supplied by a caller.** Entering
   `EXCEPTION` requires `NEW.exception_entered_from = OLD.status`; anything else,
   including `NULL`, is rejected. The application sets it too, but the trigger is
   what makes it true.
2. **It is frozen while the exception is open.** Otherwise the attack is two
   steps rather than one: open honestly, re-aim, then "resume".
3. **Leaving `EXCEPTION` goes to that exact value, or to `FAILED`/`CANCELLED`.**
   There is no fourth option, which is what stops `UPDATE settlements SET status
   = 'SETTLED'` from an open exception.
4. **Terminal states can never be the origin.** A column `CHECK` restricts
   `exception_entered_from` to the five states that actually have a transition
   into `EXCEPTION`, so `SETTLED` cannot be recorded and therefore cannot be
   resumed to.
5. **`ACTION_REQUIRED` is excluded by the same check.** Resuming into it would
   ask a customer to act on a settlement that is mid-execution — and past the
   point of no return, on one they can do nothing about.
6. **A post-PONR exception cannot resume to a pre-dispatch state.** `INV-36`
   applied to resumes: a settlement whose money may already be moving must not
   land back where it could be cancelled or re-reserved. Terminal resolution is
   still permitted, so a stuck settlement always has somewhere to go.

The application layer had its own hole, and it was the shorter path.
`applyTransition` spread its caller's `patch` **after** the computed status, so
`{ trigger: 'resolve_resume', patch: { status: 'SETTLED' } }` would evaluate
T22, pass its guards, emit `settlement.exception_resolved` and write `SETTLED` —
an event stream saying the settlement resumed beside a row saying it had paid
out. No raw SQL, no privileged role, just a field name.

Fixed twice over: a `MACHINE_OWNED_COLUMNS` set (`status`, `customerStatus`,
`version`, `exceptionEnteredFrom`, `openExceptionCode`, and the snake_case
spellings, which Drizzle would otherwise drop in silence) is refused before the
row lock is taken; and the patch is now spread *first* so the computed values
overwrite it structurally, because a list of protected names is edited by people
and an ordering is not. Transition payload — `authorizedTerms`,
`pointOfNoReturnAt`, `destinationVersionId` — stays caller-supplied and is frozen
by the database once written, so the protection did not eat the feature.

### T30 owes `R04` to Stage 6

`R04` is a reconciliation companion, and reconciliation is Stage 6. Rather than
invent a `Reconciliation` aggregate so a Stage 3 checklist could be ticked — an
event about a record that does not exist is not evidence of anything — the debt
is a **typed field on the transition itself**:

```ts
deferredCompanions: [{ ref: 'R04', aggregate: 'Reconciliation',
                       owedBy: 'Stage 6', why: '...' }]
```

`deferredCompanions()` and `deferredCompanionsFor('Stage 6')` enumerate it, so
Stage 6 discovers what it owes rather than remembering to look. **Stage 6 closes
this by emitting `R04` from T30 against the real reconciliation record**; the
gap is not closed until that companion is emitted and `deferredCompanionsFor(
'Stage 6')` is empty.

---

## 8. Customer projection

`packages/domain/src/settlements/projection.ts` — seventeen internal states to
five customer states, and **exactly one definition** (`INV-18`).

- preflight `ACTION_REQUIRED` → customer `ACTION_REQUIRED`;
- customer-actionable `EXCEPTION` → `ACTION_REQUIRED`;
- non-actionable `EXCEPTION` → `SETTLING` with a delay note;
- `DRAFT` projects to *nothing* and is not listed;
- `FAILED` and `CANCELLED` share `CANCELLED` (`D-03`, closed — see below).

The UI does not re-derive it. `apps/app/src/settlements/view-models.ts` calls
the domain function and presents the result; a test walks **every** internal
status and asserts the surface agrees with `projectCustomerStatus` exactly.

This is also why `packages/domain/src/browser.ts` exists. The domain barrel pulls
`node:crypto` (instruction hashing, rule-set checksums), which cannot bundle for
a browser — so a UI importing the barrel would have been forced to keep a second
copy of the projection. The browser entry point exports the pure, browser-safe
subset instead. The bundler failure was the honest signal that the barrel was
hiding a layering question rather than answering it.

### `D-03` closed — `FAILED` reads as `CANCELLED`, with a reason

Full argument in `decisions/0004-terminal-resolution.md`. In short: the five
customer states answer *what is happening to my money*, and `FAILED` and
`CANCELLED` have the same answer — nothing was delivered, your liquidity is
released. By the test that produced the state set, they are one state.

What differs is *why*, and a reason line says that better than a state name.
"Cancelled — our payout partner declined this transfer and we could not complete
it" is information; a state called `NOT_COMPLETED` next to a state called
`CANCELLED` is a puzzle the customer has to solve first.

There is also an asymmetry in cost. A customer-facing state is a public API
value, a filter in every list view, a column in every export, and a row in every
mapping table an integrator maintains — the most expensive kind of thing to add
and nearly impossible to remove. A reason code is additive, and an unrecognised
one degrades to the state, which is still correct.

Implemented as `packages/domain/src/settlements/resolution.ts`: nine codes, each
bound to exactly one terminal status, each carrying one customer-facing sentence
that says what happened to the money. `customerStateBadge` no longer takes the
resolution at all — it used to render "Not completed" for a failure, which was a
sixth state wearing a label instead of a name — so that route back is closed by
the function signature rather than by a convention.

`API_CONTRACT.md § 7.4` already carries `resolution: { code, message }`, so this
closes `D-03` without changing a wire contract. Nothing about pricing moves:
authorization still freezes the quoted economics and fees stay explicit rather
than buried in the FX rate. `D-08` and `D-09` remain open.

---

## 9. Stage 3 UI surfaces

Four more frozen `DESIGN_SYSTEM.md` § 5 domain components — `AmountDisplay`,
`SettlementProgress`, `QuoteSummary`, `Reference` — with full five-state
Storybook coverage. `EventRow`, `ReceiptDocument` and `MetricTile` stay
deferred, and the scope test still fails CI if one is built early.

`AmountDisplay` takes a `Money` and not a `number`. That is the point of it:
`INV-01` is a property of the whole money path, and the renderer is the last
place it can be broken.

**New Settlement** — beneficiary, recipient ₹, purpose, funding currency, a live
sandbox quote summary, and a `Settle ₹X` button that names the commitment with
the figure in it.

**Settlement Detail** — the amount and the customer state lead; the
Ready → Settling → Settled rail; the cancellation affordance **only while
genuinely cancellable**; technical state behind a disclosure.

Nothing claims a capability Stages 4–6 have not built: a test asserts the
screens contain no receipt, UTR, download, reconciliation, facility, drawdown or
rail terminology. The `SETTLED` story is labelled design-only and unreachable in
Stage 3.

---

## 10. Stage 3 exit matrix

| Requirement | Status | Evidence |
|---|---|---|
| Exhaustive legal/illegal transition matrix | ✅ | `transitions.test.ts`: all 18 × 30 pairs, every non-legal one `invalid_transition` |
| `SETTLED`/`FAILED`/`CANCELLED` accept no updates at all | ✅ | `protect_settlement_row`; enforcement suite attacks with raw SQL |
| `ACTION_REQUIRED` has only T04 as an internal entry | ✅ | `transitions.test.ts` "T04 is the only entry (INV-37)" |
| Every status transition has exactly one status event | ✅ | deferred constraint trigger + `settlement-lifecycle.test.ts` |
| Companion events cannot substitute for a status event | ✅ | enforcement suite: companions-only transaction is rejected |
| Raw SQL cannot mutate status or terminal rows via the app role | ✅ | 71-test enforcement suite |
| Payout identity is per **attempt**, not per settlement (INV-25) | ✅ | `payoutIdempotencyKey(settlementId, attemptNumber)`; `payout-attempt.test.ts` |
| A retry presents the same key; attempt 2 presents a different one | ✅ | `settlement-lifecycle.test.ts` retry test; enforcement suite key comparison |
| Two simultaneous non-terminal attempts are impossible (INV-24) | ✅ | `payout_attempts_one_in_flight` partial unique index, attacked with raw SQL |
| `UNKNOWN` cannot allocate a further attempt | ✅ | `allocateAttemptNumber` refusal + index; both layers tested |
| Changing AuthorizedTerms cannot mint a payout attempt | ✅ | INV-16 refuses the edit (superuser included); key does not read the terms |
| `exception_entered_from` is never caller-controlled | ✅ | trigger derives and freezes it; `MACHINE_OWNED_COLUMNS` refuses the patch |
| T22 resumes only to the recorded origin | ✅ | trigger clause (c) + `resume-integrity.test.ts` |
| Terminal states and `ACTION_REQUIRED` can never be a resume target | ✅ | column `CHECK` + resume tests |
| A post-PONR exception cannot resume to a pre-PONR state | ✅ | trigger clause (d), attacked with raw SQL |
| T22 cannot be bypassed from the application layer | ✅ | `protected_field` refusal; patch spread ordering |
| T30's `R04` debt is typed and enumerable, not fabricated | ✅ | `deferredCompanionsFor('Stage 6')`; no `Reconciliation` aggregate invented |
| `D-03` closed with no sixth customer state | ✅ | `resolution.test.ts`, `decisions/0004-terminal-resolution.md` |
| Authorization freezes destination version and AuthorizedTerms | ✅ | mutate-the-world-after test; hash byte-identical |
| Quote expiry/consume races are safe | ✅ | `settlement-lifecycle.test.ts` concurrency block |
| The same quote cannot authorize two settlements | ✅ | two independent unique indexes, both tested |
| SoD from Stage 1 enforced at T08 | ✅ | `settlement-lifecycle.test.ts`, using the Stage 1 policy unchanged |
| Customer projection defined in exactly one place | ✅ | domain function; surface test walks all 17 statuses |
| No outcome where both `CANCELLED` and a durable dispatch exist | ✅ | contention test under the shared row lock |
| Money/FX rounding preserves recipient-first rules | ✅ | `fx.test.ts`, 24 tests |
| T26 is an annotation, not a status transition | ✅ | `transitions.test.ts`; no status event, no state change |
| `D-08`/`D-09` untouched; sandbox pricing labelled | ✅ | `validatePricingConfig` + provisional notice, both tested |

---

## 11. Clean CI

`pnpm run verify` from a fresh checkout (typecheck → source-tree → lint →
money-columns → requirement-copy → Storybook build → tests):

```
EXIT=0
Test Files  34 passed (34)
     Tests  696 passed (696)
```

Stage 3 added **276 tests**: 29 transitions, 29 settlement domain, 27 quotes,
24 FX, 71 database enforcement, 40 lifecycle/concurrency, 27 UI surfaces, 23
payout-attempt identity, 13 T22 resume integrity, 12 `D-03` resolution, plus the
Stage 3 design-system coverage.

The four suites that carry the corrections:

| Suite | Tests | What it proves |
|---|---|---|
| `packages/domain/src/__tests__/payout-attempt.test.ts` | 23 | key derivation, terminality, attempt allocation, the P01–P08 table |
| `packages/domain/src/__tests__/resume-integrity.test.ts` | 13 | T22 has no static destination; the resumable set *is* the set of states that open exceptions |
| `packages/domain/src/__tests__/resolution.test.ts` | 12 | `D-03`: five customer states, no `NOT_COMPLETED`, every reason says what happened to the money |
| `packages/app/src/__tests__/settlement-db-enforcement.test.ts` | 71 | all of the above attacked as `inrsettle_app` through raw SQL |

---

## 12. Defects found and fixed this stage

1. **A test helper silently skipped authorization.** `toDrawdownConfirmed`
   omitted the `documents` preflight needs and ignored the authorization
   result, so eight tests failed three transitions later with a baffling
   `invalid_transition` from `QUOTED`. The machine was right and the harness was
   wrong. The helper now passes documents and asserts its own precondition, so a
   future failure surfaces at its cause.
2. **The domain barrel could not be imported by a browser.** Two modules use
   `node:crypto`; the Storybook build failed on them. Fixed by stating which
   part of the domain is browser-safe rather than by duplicating the projection.
3. **`apps/app` used `@inrsettle/money` without declaring it.** tsconfig `paths`
   resolved it fine, so only the bundler caught it. A missing workspace
   dependency that typechecks is exactly the kind of gap that surfaces in a
   deployment rather than in CI.
4. **The exception taxonomy had no customer copy**, which the frozen § 7
   requires. Added as four-field requirements for the actionable codes and delay
   notes for the rest, in the domain beside the actionability flag the
   projection reads.
5. **Payout idempotency was constant across a settlement's life.** The key was
   `sha256(payout:v1:<settlementId>:<authorizedTermsHash>)`, and the terms hash
   does not change between attempts — so attempt 2 would have presented attempt
   1's key and a provider honouring idempotency would have returned attempt 1's
   result. A payout that was never sent would read as sent. Replaced by explicit
   attempt numbering; see § 6.
6. **`patch` could overwrite the machine's own columns.** `applyTransition`
   spread the caller's patch *after* the computed status, so
   `{ trigger: 'resolve_resume', patch: { status: 'SETTLED' } }` would pass
   T22's guards, emit `exception_resolved` and write `SETTLED`. A state-machine
   bypass with no raw SQL and no privileged role. Fixed by refusing
   machine-owned fields *and* by reversing the spread order; see § 7.
7. **`payout_attempts` was granted `INSERT` but not `UPDATE`.** Correct when an
   attempt was a write-once row; wrong the moment it acquired a P01–P08
   lifecycle, because `protect_payout_attempt` would have had nothing to guard
   and the status could never have advanced. The grant now matches the model,
   and the trigger — not the grant — is what keeps identity immutable.
8. **A raw `tx.execute` timestamp was typed as `Date` but was not one.**
   `pointOfNoReturnAt` on the reuse path came straight from the driver, and the
   first caller to call `.getTime()` on it found out. Re-wrapped at the boundary.

---

## 13. Open decisions

Resolved into the frozen baseline by **Revision 6** (2026-09-03, documentation
only — see the README's signed baseline).

`D-03` is **closed** for V1 — see § 8 and `decisions/0004-terminal-resolution.md`.

`D-08` and `D-09` are each **split**, because each was really two questions
wearing one number:

| | Technical invariant | Commercial parameter |
|---|---|---|
| `D-08` | **CLOSED.** No silent repricing after authorization; `AuthorizedTerms` freeze the quoted economics by value at T08 and are immutable thereafter (`INV-16`). | **EXTERNAL.** Quote validity window; who bears FX movement between lock and execution. Pending real partner evidence. |
| `D-09` | **CLOSED.** Fees are explicit, itemised components and are never folded into the FX rate (`INV-07`). The disclosed rate is the rate applied. | **EXTERNAL.** Fee level and model shape — flat, bps, tiered. Pending real partner evidence. |

The closed halves are engineering guarantees that hold whatever the commercial
answer turns out to be, which is why they could be closed without one. Stage 3
implements the arithmetic and the configuration shape and invents no spread, fee
percentage, quote window or hedging policy: the sandbox config is labelled
`sandbox_fixture`, the validator refuses to let a fixture claim otherwise, and
every customer-facing quote carries a provisional notice.

`D-06` and `D-11` remain open from Stage 2, unchanged.

**What Stage 6 inherits:** T30's `R04` companion is not emitted, because
reconciliation records are Stage 6 and the event would have nothing to attach
to. The debt is a typed field on the transition and is enumerable through
`deferredCompanionsFor('Stage 6')`, so it is discovered rather than remembered.
It closes when `R04` is emitted from T30 against a real reconciliation record
and that query returns empty.

**What Stage 5 inherits:** allocating attempt 2. The identity model, the schema
and the refusals are all in place; Stage 3 declines to *start* a further attempt
because the retry policy depends on what the provider said, which is Stage 5's
knowledge. Dispatch after a rejected attempt returns `already_dispatched` with
the allocation attached, so Stage 5 has what it needs and Stage 3 has not
guessed on its behalf.

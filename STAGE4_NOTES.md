# Stage 4 — Liquidity: facility, reservation, drawdown, repayment, ledger

Scope per `IMPLEMENTATION_PLAN.md § 3`: *"Facility, limit, availability, atomic
reservation, drawdown, repayment, the double-entry ledger, and
`MockLiquidityProvider`."*

Not built here, because they belong to the stages that own them: payout provider
execution (Stage 5), reconciliation, returns and receipts (Stage 6), batches
(Stage 7).

---

## 1. The shape of the thing

Liquidity is modelled properly. It is not a boolean on a settlement, and the
three figures that matter are not stored opinions:

```
available = limit − drawn − reserved,   and   available >= 0 always
```

`drawn` and `reserved` are **projections of the ledger** (`INV-23`), not
independently maintained counters. That distinction is the whole design. A
counter incremented alongside a ledger entry will eventually diverge from it — a
retry, a missed rollback, one code path that forgot — and the divergence is
silent, which in a facility means either refusing settlements that could be
funded or funding settlements that cannot be. Because the projection is derived,
it can be recomputed and compared, and the comparison turns a silent divergence
into an alarm.

`INV-19` is a database `CHECK` on the facility row, not an application rule:

```sql
CONSTRAINT facility_availability_non_negative
  CHECK (limit_minor - drawn_minor - reserved_minor >= 0)
```

That constraint makes over-allocation impossible even if every line of
TypeScript above it were wrong.

---

## 2. The ledger — `INV-23`

Three accounts and one rule: **every movement of facility value is a balanced
pair between two of them.**

| Movement | From | To | Frozen row |
|---|---|---|---|
| `reservation_created` | `available` | `reserved` | V01 |
| `reservation_released` | `reserved` | `available` | V03 |
| `reservation_expired` | `reserved` | `available` | V04 |
| `reservation_consumed` | `reserved` | `drawn` | V02 |
| `repayment_confirmed` | `drawn` | `available` | Y03/Y06 |

`available` is the contra account and is never accumulated — it is computed from
the other two, so it cannot become a third number that disagrees with them.

Consumption goes **straight** from `reserved` to `drawn`, not via `available`.
The value was never spendable again, and a trip through `available` would
briefly say it was.

Three database facts hold the ledger together:

- **Append-only, for everyone.** A trigger rejects `UPDATE` and `DELETE`,
  superuser included. A history a privileged role can edit is not a history.
- **A movement is exactly one debit and one credit, of equal amount and one
  currency.** Enforced by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger,
  because the second row of a pair cannot exist when the first is written and
  checking early would forbid the only correct way to write one.
- **`project_facility_position(fid)`** recomputes `drawn` and `reserved` from
  the entries. The rebuild test and the alarm ask the same question of the same
  code, rather than two implementations that agree today.

---

## 3. Reservation — V01–V04, and the transition that is missing

The table is implemented as data, checked row by row against
`STATE_MACHINES.md § 6.2`. The load-bearing fact is what is **absent**:

> *"A `CONSUMED` reservation has no outgoing transition."*

Once a drawdown is confirmed the value is no longer reserved — it is drawn — and
there is nothing to give back on the reservation side. `INV-22` is unusually
specific about the failure mode it wants: attempting a release must be *"a typed
error, not a no-op, so a mistaken code path fails loudly instead of silently
double-crediting the facility."* A generic refusal would let a caller read it as
"already done" and carry on.

So it is refused at three layers, each of which can be bypassed by the one below
it being wrong:

1. the domain returns a distinct `consumed_cannot_be_released`, not
   `invalid_transition`;
2. the service surfaces that reason rather than treating it as idempotent;
3. a database trigger rejects the `UPDATE` even from raw SQL as `inrsettle_app`.

This matters most for a Stage 6 return, which arrives long after the reservation
was consumed and the settlement went terminal.

**Release is idempotent, but only over release.** A second release of an already
`RELEASED` or `EXPIRED` reservation is a no-op and says so — the caller may
genuinely be retrying — and, critically, the facility does not move: four
releases of one reservation post exactly one balanced pair.

---

## 4. Repayment — Y01–Y08, and `INV-46`

The frozen table opens with the sentence that is the whole design:

> *"Capacity comes back on exactly one transition, and it is not the one that
> creates the repayment."*

`capacityRestoringTransitions()` reads the table and returns `['Y03', 'Y06']` —
a trusted confirmation, and the same fact arriving by an authoritative status
pull. Every other transition, including creating and submitting the repayment,
moves nothing. A `REQUESTED`, `SUBMITTED` or `UNKNOWN` repayment is
`repayment_in_flight`: visible to operations, excluded from availability.

Money a provider has not confirmed returning is not capacity, however confident
anyone is that it is coming.

`INV-47` — `UNKNOWN` resolves by pull, never by resubmission. A duplicate
repayment is a real financial error in the opposite direction from a duplicate
payout, and it is prevented the same way. Y08 (re-request after failure) is the
only transition that mints a new `request_fingerprint`, by advancing an explicit
`attempt` counter; the database refuses a re-request that reuses the old key or
fails to advance the counter.

---

## 5. What the funding leg now answers for itself

Stage 3 declared `facility_active`, `sufficient_availability` and
`active_reservation_exists` as `later_stage` guards: required, never defaulted,
answered by an explicit test harness. Stage 4 is the stage that owed those
answers, and answers them by reading the facility.

The tests this made possible are the ones that could not be written before: a
settlement refused because a facility really is short (T11 opens
`LIQUIDITY_UNAVAILABLE`), and a cancellation compensated differently depending
on whether funding actually moved.

### Two ordering rules, and the tension between them

**The liquidity effect and the transition that claims it share a transaction,
and the liquidity effect goes first.** If the reservation fails there is no
transition to undo; if the transition fails the reservation rolls back with it.
The other order produces a settlement in `LIQUIDITY_RESERVED` with no
reservation — a lie the machine has no way to detect later.

**But two status transitions never share a transaction.** `INV-32` permits
exactly one status event per transaction, so T09 and T10 are two. This surfaced
as a test failure, and the failure was right: it is not a limitation to work
around but the reason `LIQUIDITY_RESERVING` exists as a state at all. It is the
durable marker that a reservation was *started*, so a crash between the two
leaves something recoverable rather than a settlement that silently never tried.

Functions spanning two transitions therefore take the connection pool rather
than a transaction — the same shape `runSettlementPreflight` already had — so a
caller who passes a transaction gets a type error rather than a runtime
invariant violation.

### `UNKNOWN` holds the reservation

T14 (drawdown failed) releases the reservation. T29 (drawdown timed out) does
**not**, and the asymmetry is the entire justification for the `UNKNOWN` state:
a drawdown we are unsure about may have moved money, and releasing its
reservation would free capacity that is actually drawn — after which the
facility would fund a second settlement against the same money.

T29's frozen guard says it in as many words: *"Never resubmit blindly."*

---

## 6. `MockLiquidityProvider`

*"First-class code with tests, not throwaway stubs"*, and deterministic:
behaviour is selected by input, never by chance.

The scenarios that earn their keep are the two timeouts:

| Suffix | Scenario | Why it exists |
|---|---|---|
| `…0000` | confirms | the happy path |
| `…0001` | rejects | a real answer; the settlement fails cleanly |
| `…0002` | times out, **did not** perform | a later pull answers `not_found` |
| `…0003` | times out, **did** perform | a later pull answers `CONFIRMED` |
| `…0004` | accepted, still in flight | gives the SLA watcher something to watch |

Both timeouts throw the same `ProviderTimeout` carrying the same information.
Nothing at the moment of failure separates them — which is the point, and the
reason a status pull is the only correct recovery. A mock that could not produce
both would make every `UNKNOWN` path untestable, which is to say untested.

`getRepayment` is on the port because `INV-47` names it explicitly.

---

## 7. The customer-facing surface

One number and one sentence.

**Available to settle**, shown only when a facility is actually enabled.
Deliberately `null` rather than `0` when there is none: *"you can settle
nothing"* and *"we have not set this up yet"* are different things to tell
someone, and a zero says the wrong one during onboarding.

Money on its way back to the facility is **not** a second metric —
`PRODUCT.md` Revision 5 removed that. It simply leaves *Available to settle*
reduced until the repayment confirms, and the explanation lives on the affected
settlement, as one line.

### The vocabulary gate

`PRODUCT.md § 12` forbids balance, wallet, credit and limit remaining for this
feature, and forbids showing the customer *facility*, *drawdown*, *prefunding*
or *stablecoin* at all. `scripts/check-liquidity-copy.mjs` fails the build over
it, because a vocabulary rule nobody checks is a vocabulary rule nobody follows —
and each banned word here names a product INRSettle is not. "Credit" and "loan"
in particular describe a regulated activity it does not carry out, with `D-02`
still open on what it legally *is*. A wrong word is a compliance statement.

**The gate found three real leaks from earlier stages on its first run**, all
shipped copy: a cancellation empty state reading *"nothing was drawn from your
facility"*, a requirement button labelled *"Set up facility"*, and the story and
test fixtures mirroring both.

Getting the gate to stay useful took three narrowings, each from a real false
positive: `snake_case` string literals are identifiers rather than sentences
(`set_up_liquidity_facility`); comments are not copy — the clearest
documentation of a ban contains the banned word; and a `describe`/`it` title is
prose about behaviour. Word boundaries matter too: the ledger is legitimately
*balanced*, and a *creditor* is not *credit*. A gate that cries wolf gets
switched off, and then the real leak ships.

---

## 7a. Financial-integrity proofs

Two properties that a facility must never violate, proved at the service, at
the database, and under concurrency.

### Capacity cannot be restored beyond real outstanding drawdown

`packages/app/src/__tests__/repayment-integrity.test.ts` — 24 tests.

The whole family of failures has one shape: a facility reporting more capacity
than it truly has, so it funds a settlement against money that is not there.
Every route runs through a `repayment_confirmed` movement, so every route is
checked.

| Property | How it holds | Where |
|---|---|---|
| `drawn` never negative | `CHECK (drawn_minor >= 0)`, plus a service refusal before a bad repayment can exist | *drawn can never become negative*, 4 tests |
| `available` never exceeds the limit | A **consequence**, not a separate rule: `available = limit − drawn − reserved` with both subtrahends CHECKed non-negative | *available can never exceed the facility limit*, 2 tests |
| One confirmation, one restoration | Y03 and Y06 both terminate at `CONFIRMED`; the trigger refuses reopening even from raw SQL | *one confirmation, one restoration*, 3 tests |
| Concurrent confirmations | Repayment row lock serialises them; the loser finds `CONFIRMED`. Run ×5 | *concurrent confirmations*, 2 tests |
| Concurrent confirmations of the same **source** | `repayments_one_live_per_settlement` partial unique index — a settlement's funding is drawn once, so it is repaid once. Run ×5 | same block |
| Over-repayment refused, nothing posted | Eligibility ceiling at request time; no row, so nothing to confirm later | *refuses a repayment larger than what is outstanding* |
| Facility / tenant / currency must match | One **composite foreign key** on `(facility_id, workspace_id, environment, amount_currency)` → `liquidity_facilities (id, workspace_id, environment, currency)` | *facility, tenant and currency must match*, 6 tests |
| `FAILED` re-requestable, but cannot combine | Y08 reuses the row; the live-index excludes `FAILED`, so reviving a failed row while its replacement is live is refused | *a failed repayment cannot combine with a later one*, 3 tests |
| `UNKNOWN` restores nothing, resolves only by pull | Not terminal, not resubmittable, and its amount still counts against eligibility | *UNKNOWN restores nothing*, 4 tests |

Two of these are worth spelling out.

**The eligibility ceiling nets off in-flight repayments**, not just `drawn`. Two
repayments each for the full drawn amount are individually plausible, and
confirming both restores capacity twice for money that went out once. The
database `CHECK` catches that at the *second* confirmation — but on a
transaction that has already told someone their repayment was accepted.
Refusing at request time is the difference between a clean answer and an
incident.

**The composite foreign key replaces four application checks.** Rather than
remembering to verify facility, workspace, environment and currency separately
in every writer, each table that carries an amount against a facility references
a composite key that makes all four one referential fact. A repayment or ledger
entry naming another tenant's facility has no referent and cannot be inserted,
by anyone, through any path.

### Drawdown amount integrity

`packages/app/src/__tests__/drawdown-integrity.test.ts` — 17 tests.

The funding leg now moves only on evidence that says the money arrived, in full,
in the right currency, from the right facility. `resolveDrawdown` takes an
`evidence: { amountMinor, currency, facilityId? }` and matches it before
anything is written.

| Case | Result |
|---|---|
| Exact confirmation | Consumes the reservation; `reserved → drawn` once |
| Duplicate exact confirmation | Idempotent — replayed ×10 gives one movement and **one** status event |
| Duplicate with a *different* amount | Refused. Idempotence keys on the evidence, not on "we already have a CONFIRMED drawdown" |
| Wrong currency | Refused; nothing consumed |
| Over-confirmation | Refused (`direction: 'over'`); nothing consumed |
| Partial confirmation | Refused (`direction: 'under'`); **no silent `DRAWDOWN_CONFIRMED`** |
| Off-by-one either way | Refused |
| Different facility | Refused |
| No evidence at all | Refused — a confirmation is a claim about an amount |
| Unverified provider event | Refused before any write |
| Indeterminate status (T29) | Reservation stays `ACTIVE`; neither consumed nor released |

**No partial-drawdown policy is invented.** Under- and over-funding share one
reason code with the direction in the detail, deliberately: splitting them would
invite a caller to handle one, which is how a policy gets made by accident. What
to *do* about a short provider — retry, top up, fail, escalate — has no owner
yet, and `decisions/0008-register-housekeeping.md` records that it needs one if
the first liquidity partner can fund partially.

The indeterminate case is the one that justifies the design. Releasing would
free capacity that may actually be drawn; consuming would claim funding that may
never have happened. The only honest state is "we do not know yet", and the
reservation stays exactly where it is until a status pull says otherwise.

---

## 8. Stage 4 exit matrix

| Requirement | Status | Evidence |
|---|---|---|
| N simultaneous reservations against N−1 capacity: exactly one failure, never negative availability (`INV-20`) | ✅ | `liquidity.test.ts`, N=6 under `Promise.allSettled`; refusal is a clean `insufficient_availability`, not a constraint violation |
| The facility projection is rebuildable from the ledger, and a deliberate divergence fires the alarm (`INV-23`) | ✅ | `checkFacilityProjection` vs `project_facility_position()`; divergence injected as superuser, because no application path can create one |
| Release is idempotent under repeated cancel, fail and expiry (`INV-22`) | ✅ | four releases → one balanced ledger pair, facility unmoved |
| Releasing a `CONSUMED` reservation raises a typed error (`INV-22`) | ✅ | domain, service and trigger; raw SQL attacked as `inrsettle_app` |
| Repayment moves `available` only at `CONFIRMED`, never at `REQUESTED` or `SUBMITTED` (`INV-46`) | ✅ | `capacityRestoringTransitions()` = `['Y03','Y06']`, plus availability asserted unmoved at each earlier step |
| `UNKNOWN` resolves by status pull only (`INV-47`) | ✅ | resubmission refused; Y08 mints a new fingerprint, and the database refuses a reused one |
| **Counsel engaged and `D-01`/`D-02` scoped** (§2.1) | ⚠️ | **Half met.** The questions are written down (`decisions/0007-counsel-brief-d01-d02.md`); engaging counsel is outstanding and is a founder action. See below. |
| "credit", "loan" and "balance" appear nowhere in customer-facing copy | ✅ | `check-liquidity-copy.mjs` in `pnpm verify`, with 14 tests proving it rejects and does not over-reject |
| Ledger is append-only | ✅ | trigger refuses `UPDATE`/`DELETE` for the superuser too |
| A movement cannot be half-written or unbalanced | ✅ | deferred constraint trigger; both attacked directly |
| `INV-21`: one `ACTIVE` reservation per settlement | ✅ | partial unique index, attacked with raw SQL |
| RLS on every new tenant table | ✅ | `ENABLE` + `FORCE` + tenant policy on all five; discovered automatically by the Stage 1 isolation gate |
| Capacity cannot be restored beyond real outstanding drawdown | ✅ | `repayment-integrity.test.ts`, 24 tests — service, database and concurrency (§ 7a) |
| Drawdown consumes only on matching authoritative evidence | ✅ | `drawdown-integrity.test.ts`, 17 tests — exact, duplicate, wrong currency, over, partial, indeterminate (§ 7a) |
| Questions for counsel written down | ✅ | `decisions/0007-counsel-brief-d01-d02.md` |

### The one criterion engineering cannot close

> *"Counsel engaged and `D-01`/`D-02` scoped — hard gate"*

`IMPLEMENTATION_PLAN.md § 2.1` is deliberate about why this sits at Stage 4:
*"a calendar booking is not a deliverable, and gating engineering on someone
else's availability is a gate that gets waived rather than met."*

The criterion has two halves and engineering can only close one of them.

**Scoped — done.** `decisions/0007-counsel-brief-d01-d02.md` is the brief: what
INRSettle does, what it stores, seven questions on `D-02` (regulatory posture,
KYB depth, who owns the compliance programme, retention, reporting) and seven on
`D-01` (which data classes are payment system data, exclusive versus copies,
processing versus storage, backups, provider choice, DPDP interaction, what must
be demonstrable). It states the engineering assumptions counsel should confirm
**or correct**, and the six decisions currently unmade because they are waiting
— hosting region, database location, backup destination, key custody, support
access, document store. It contains **no legal answers**, because `D-02` says
*"settle with counsel; do not infer"* and an engineering document that reads
like a legal position is something a later reader may act on.

**Engaged — outstanding.** A founder action. Nothing engineering can do closes
it, and marking Stage 4 complete without it would be exactly the waiving the
frozen plan warns about.

The *answers* gate Stage 11, not Stage 5. Stages 5–10 are built against
deterministic simulators and do not depend on them — but the six deferred
decisions above should stay deferred, because unmaking them later means
migrating production payment data.

---

## 9. Decisions

| # | Technical invariant | Commercial / operational parameter |
|---|---|---|
| `D-05` reservation TTL | **CLOSED.** `expires_at` is `NOT NULL`; V04 expiry drives T28; expiry is idempotent with release; a `CONSUMED` reservation never expires. | **EXTERNAL.** The duration. `reserveLiquidity` takes `ttlSeconds` with **no default** and rejects a non-positive value — a default would become the answer by accident. |
| `D-16` post-funding cancellation | **CLOSED.** Compensation is decided by where the money got to: `ACTIVE` → release, `CONSUMED` → request a repayment and move nothing, released/expired → nothing owed. | **EXTERNAL.** Whether it is always allowed, fee-bearing or rate-limited. No fee, no rate limit and no cooling-off period is invented here. |

Recorded in `decisions/0005-reservation-ttl.md` and
`decisions/0006-post-funding-cancellation.md`, following the split
`D-08`/`D-09` established at Revision 6.

Stage 4 provides the observability the `D-16` policy will need: every
cancellation after funding creates a `CANCELLATION_AFTER_DRAWDOWN` repayment
against a named settlement, so the rate and cost of the behaviour are measurable
before anyone has to price it.

Unchanged and still open: `D-06`, `D-11`, `D-08b`, `D-09b`.

---

## 10. Clean CI

`pnpm run verify` from a fresh checkout (typecheck → source-tree → lint →
money-columns → requirement-copy → **liquidity-copy** → Storybook → tests):

```
EXIT=0
Test Files  42 passed (42)
     Tests  836 passed (836)
```

Stage 4 added **140 tests**: 28 liquidity domain, 24 facility/ledger against the
database, 24 repayment over-restoration, 17 drawdown amount integrity, 9 funding
leg end to end, 15 mock provider, 9 availability surface, 14 vocabulary gate.

---

## 11. Defects found and fixed this stage

1. **The test harness applied a hardcoded list of migrations.** Adding `0006`
   did not add it there, so every Stage 4 test failed with *"relation
   liquidity_facilities does not exist"* against a schema that was perfectly
   correct. A list that must be edited in lockstep with a directory eventually
   will not be, and the failure it produces points at the wrong thing. The
   harness now discovers migrations, excluding only the two that need the
   worker bootstrap.
2. **Three real vocabulary leaks in shipped copy**, found by the new gate on its
   first run — including a cancellation empty state that told the customer
   nothing was *"drawn from your facility"*.
3. **T09 and T10 in one transaction violated `INV-32`.** Caught by the pairing
   trigger. Split into two, which is what `LIQUIDITY_RESERVING` is for.
4. **`dispatchPayout`'s `pointOfNoReturnAt` was typed `Date` but was not one**
   on the reuse path — a raw `tx.execute` returns the driver's representation.
   Carried over from Stage 3 and fixed there.
5. **An invented uniqueness constraint.** The first cut had a unique index
   forcing one facility per workspace, environment and currency. Nothing in the
   frozen documents says that, and a plausible real case breaks it immediately:
   migrating between liquidity providers means running two for a while. It was
   already fighting the tests, which is usually the sign. Removed; presenting a
   single *Available to settle* figure is the surface's job.
6. **The money-column gate demanded a currency column per amount**, which for a
   facility would have meant three copies of one fact — `limit`, `drawn` and
   `reserved` are subtracted from each other and cannot differ. The gate now
   accepts a table-level `currency` column for a single-currency aggregate, and
   still rejects an amount with no currency anywhere. `limit_currency` was
   dropped as the redundancy it was.

7. **A refusal that had already mutated.** `provider_event_verified` was checked
   only where it belongs conceptually — as a guard on T13, inside
   `applyTransition` — but by then `resolveDrawdown` had updated the drawdown
   row and consumed the reservation. The transition was correctly refused and
   the function correctly returned `ok: false`; the caller's transaction then
   **committed**, because returning a refusal is not throwing. An unverified
   provider event left a `CONSUMED` reservation and a `CONFIRMED` drawdown
   behind a failed call. Found by the test written to prove the opposite. Every
   refusal now happens before any write; the guard is still passed to the
   machine, where it is normative.
8. **A confirmation was a word, not a claim about an amount.** `resolveDrawdown`
   consumed the reservation and posted the funding movement on the trigger name
   alone, so a provider event for the wrong amount would have moved the ledger
   by the amount we *expected*. The ledger would have been internally consistent
   and externally false — the worst kind of wrong, because nothing would ever
   have flagged it.
9. **`requestRepayment` validated nothing.** No currency check, no tenant check,
   no ceiling. A repayment for ten times the drawn amount was accepted, and
   confirming it would have driven `drawn` negative — caught by the `CHECK`, but
   as a constraint violation on a transaction that had already reported success.

---

## 12. What Stage 5 inherits

- The `LiquidityProvider` port and its mock, with both timeout scenarios.
- `drawdowns.request_fingerprint`, stable per drawdown, for the status pull T29
  needs.
- The payout-attempt identity model from Stage 3, including the deliberate
  refusal to allocate attempt 2 — the retry *policy* depends on what the
  provider said, which is Stage 5's knowledge.

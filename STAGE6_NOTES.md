# Stage 6 — Reconciliation, finality, receipt

Scope per `IMPLEMENTATION_PLAN.md § 3`: *"The comparison engine, the finality
evaluator, receipt generation with `content_hash`, and PDF rendering from the
same template."*

Not built here: batches (Stage 7). **No real provider is integrated.**

---

## 1. The one idea

Everything below follows from a single line in `STATE_MACHINES.md § 8.5`:

> *"The settlement stays `SETTLED`, because it was."*

A settled settlement is finished. Its status is terminal (`INV-38`), its row is
immutable, its receipt's bytes and hash never change (`INV-48`), and every later
fact about it — a return, a repayment, a notice — is **a new row somewhere
else**. Migration `0009` adds not one column to `settlements`, and the return
service calls `applyTransition` nowhere. Both are structural rather than
disciplinary: the way to guarantee a return cannot modify a settled settlement is
to write no function that could.

The known tension is accepted deliberately, and `§ 8.5` says why: a customer
scanning a list sees `SETTLED` on a settlement whose money came back. Projecting
the return onto `CANCELLED` *"destroys the distinction between never delivered and
delivered then returned, and those have different consequences for the customer's
own books."* The mitigation is not to soften `SETTLED` — it is to make the return
impossible to miss beside it.

---

## 2. The finality evaluator

`§ 8.1`: *"`SETTLED` is created by exactly one component."* The evaluator is a
pure function; `finality.service.ts` is the one transaction that feeds it.

**Three absences do the work.**

- **No override.** No `force`, no `skipConditions`, no actor, no tolerance.
  `§ 8.2` is a list of things that must never create finality, and every one of
  them is a parameter somebody could have added — so the defence is that none
  exists, in the domain's signature or in the service's input. A test asserts
  `evaluateFinality.length === 1` and enumerates the evidence's fields.
- **No clock.** *"F1–F6 are evidentiary, not temporal."* The return observation
  window is triage on a different aggregate; it is not imported here and could
  not be used if it were, because `FinalityEvidence` has no field a duration
  could arrive in.
- **No write to `status` outside the machine.** `MACHINE_OWNED_COLUMNS` refuses a
  patch that reaches for it; `INV-32`'s deferred trigger refuses a status change
  with no paired event; and the new gate refuses raw SQL anywhere in the tree.

**Every evaluation is persisted, including the failures.** A table holding only
successes answers *"why is this settled"* and not *"why is this still not
settled"* — and the second is the question operations actually asks.

`X1` recomputes rather than trusts. The *authorized* hash is the column recorded
at `T08`; the *executed* hash is recomputed from the stored preimage via
`instructionFromCanonicalObject`. A row whose terms were edited **and** whose
hash was updated to match still fails, because the recomputation never consults
the column it is compared against. A preimage that will not parse fails closed.

---

## 3. Reconciliation — `INV-26` has no dial

`compareObservation` takes no tolerance argument, *not even one defaulted to
zero*. A configurable tolerance is a number someone eventually widens on a Friday
to clear a queue, and the widening is invisible afterwards. The absence of the
parameter **is** the invariant.

Four ways to be a mismatch, sharing one outcome and keeping their direction:
short, over, currency mismatch, and **no amount observed**. The last is a
mismatch rather than a pass, because `MATCHED` means *we checked*, not *we had no
reason to doubt* — and Stage 5 deliberately records `credited_minor` as `NULL`
when a provider states no figure.

`R03` and `R05` happen in one commit, because the frozen table marks `R05`
*"automatic; a mismatch is never left unattended"* and leaving `MISMATCH` as a
resting state would be leaving it unattended by construction. `T21` moves the
settlement in the same transaction: a crash between the two would leave a
settlement in exception with a reconciliation reading `PENDING`.

**`R04` closes Stage 3's deferred companion.** Stage 3 declared, on the `T30` row
itself, that `R04` was owed by Stage 6 — *"a prose note is something a later
reader has to find and believe; a typed field is something a test can assert."*
It is now built, and `resume-integrity.test.ts` asserts every companion `T30`
declared is backed by a real transition, rather than merely still declared.

---

## 4. The artifacts — one serialisation, one template, three surfaces

`ARCHITECTURE.md § 9` is the contract, and it is specific:

> *"The canonical receipt is one serialisation in `packages/domain/receipts`.
> The UI renders it, the API returns it, and the PDF is produced by headless
> Chromium rendering the **same** template. One source, three surfaces, one
> `content_hash` (`INV-29`)."*

So there are exactly three moving parts, and each is used by more than one
surface:

- **the canonical document** (`artifact.ts`) — pure and browser-safe;
- **the template** (`template.ts`) — a pure function from that document to HTML,
  also browser-safe. The UI renders this markup; Chromium prints *this same
  string*. A test asserts the two are the identical string rather than
  equivalent ones, which is what makes `INV-29`'s *"they cannot disagree"* a
  property of the call graph;
- **the hash** (`hash.ts`) — server-only, because a browser that could mint the
  hash of a financial record could mint the hash of one it had edited.

**Canonical means canonical.** Keys sorted recursively, `bigint` as a decimal
string (never a JSON number — a money amount that became a float would be a hash
over a rounded figure), `undefined` rejected rather than dropped, no whitespace.

**What is hashed, and what is not.** `content_hash` is the hash of the canonical
serialisation. Never the PDF's bytes, never the HTML. The receipt *is* the
document; the PDF is a rendering of it that carries the hash printed on its face.
That distinction is what makes the identity of a receipt survive a change of
typeface, of paper size, or of Chromium version — none of which touch what was
hashed.

It also means the PDF's bytes need not be reproducible, and they are not:
Chromium stamps `/CreationDate` into everything it prints. That costs nothing.
The determinism `INV-29` actually needs lives one level up, in the template,
where it is a pure function and is tested as one.

**Generate-once, write-once** — which is what `INV-48` asks of the PDF, and not
*reproducible*. Four layers: the builder has no parameter a return could arrive
through (`INV-42` becomes a property of the type); the store's only write is
`putIfAbsent`; the table has no `UPDATE` grant and a trigger that refuses one
anyway; and in a deployment the bucket policy denies overwrite on the `receipts/`
prefix. None of them ever needed byte equality to work.

**The print is worker-owned** — `ARCHITECTURE.md § 7`'s frozen `receipt.generate`
job class. The sequence is:

1. `T20` persists the receipt *record* and **transactionally enqueues**
   `receipt.generate`. The record has to be inside `T20` because the companion
   set promises `receipt.available` and an event announcing an artifact that does
   not exist is worse than no event; the enqueue is inside it because a job must
   not exist without the transaction that justified it, which is what `enqueue`
   taking a transaction and never a pool is for.
2. Commit.
3. The **worker** renders the shared template through Chromium and writes the
   artifact once.

`runReceiptGenerate` takes the connection **pool**, not a transaction, exactly as
`submitDispatchedPayout` does — launching a browser while holding the
settlement's row lock is the mistake `INV-36(b)` names for provider calls, and a
print job is not different enough to deserve an exception.

`§ 7` requires every job to be *"idempotent … and safe to run twice"*, and this
one is three times over: the store is checked before the browser starts, so a
retry does not print bytes it is about to discard; `putIfAbsent` is what actually
decides, so two workers racing still write once; and the record it renders is
immutable, so a retry a week later prints the same document. It asserts its
pre-state and aborts rather than forcing anything — an artifact whose stored bytes
no longer hash to its stored hash is refused, not printed.

**The read path re-enqueues; it never renders.** A crash between the record's
commit and the worker reaching it leaves a receipt with no printed form.
`artifactPdfUrl` notices, places a `receipt.generate` job, and answers
`pdf_not_generated_yet` — it does not start a browser. Putting an unbounded
external process on a request path would make a customer waiting the slowest
possible way to discover a broken renderer. The job key is derived from the
artifact id, so a flurry of reads collapses into one pending job rather than one
per reader. A test hands the read path a renderer that throws, to prove it is
never called.

The filesystem adapter uses `open(path, 'wx')` — create-exclusive, so the kernel
decides atomically who created the file. `existsSync` then write is not an
implementation of that.

**Composition, never absorption.** A notice carries the receipt's hash rather
than its fields, so the pair is provably about one specific version of one
specific receipt. The composite embeds both sources' documents *and* their
hashes, and its own `created_at` is the fixed string `composed` rather than a
timestamp — so two exports of an unchanged settlement are the same document with
different ids, which is what makes an export a rendering rather than a new fact.

---

## 5. The return aggregate

| Invariant | How it holds |
|---|---|
| `INV-39` — opened only by trusted evidence | The source column has two values and a `CHECK`. There is no `operator_assertion` member to pass. |
| `INV-40` — an authoritative check, not the report | `checkReturnWithProvider` takes the **pool**, not a transaction, so a network call cannot be made inside the payout attempt's row lock. A check that does not uphold is `N03` and **alarms**. |
| `INV-41` — confirming *requests* a repayment | `Y01` only. No ledger entry, no availability movement. `drawn` falls on `Y03`/`Y06`, and the return reaches `REPAID` (`N05`) by reading the repayment's status, never by asserting it. |
| `INV-42`/`INV-48` — the settlement and receipt are untouched | Asserted byte-for-byte: the whole settlement row compared before and after, and the receipt row compared as an object. |
| `INV-49` — the cap | Three enforcements of **one** statement: `checkReturnCap` in the domain, the payout attempt's row lock recomputing the total inside the transaction that increments it, and a database `CHECK` written as the same inequality. A breach routes to `MANUAL_REVIEW` and alarms rather than being refused into silence. |
| `INV-50` — one real-world return is one row | A unique index on `(payout_attempt_id, provider_return_reference)`. A second sighting *"updates nothing and creates nothing"* — it becomes an append-only `return_observations` row. |
| `INV-43` — an unmapped reason still opens a return | Mapped through the versioned provider table like every other vocabulary; anything unmapped becomes `RETURN_REASON_UNMAPPED`, which is an admission rather than an explanation, and escalates. |

**Why sightings are rows rather than a counter.** A provider that reports one
return four different ways leaves four pieces of evidence. A counter would say
"four" and lose all four, and an investigation needs the evidence.

**Why `provider_return_reference` is `NOT NULL`.** A return the provider will not
identify cannot be deduplicated at all, and accepting one would let a status pull
mint a duplicate of a return a webhook already opened. A partner that reports
returns without identifying them is telling us something we need to know.

---

## 6. Stage 6 exit matrix

| Criterion | Status | Evidence |
|---|---|---|
| For each of F1–F6, a case where that single condition is absent and `SETTLED` is refused | ✅ | Six cases against the pure evaluator, each breaking exactly one field and asserting `missing` is exactly that condition. Plus `X1` and `X2`. |
| Zero-tolerance reconciliation: a ₹5,000 shortfall produces `MISMATCH` and never settles | ✅ | Scenario `…0001` end to end: `R03` → `R05` → `T21`, and both `F5` and `F6` refuse |
| UI, API and PDF receipts carry the same `content_hash` | ✅ | One canonical serialisation, one template; the UI's markup and Chromium's input asserted to be the identical string, the hash printed on the page |
| The PDF is produced by headless Chromium rendering the same template | ✅ | `createChromiumPdfRenderer` prints `renderReceiptTemplate`'s output through pinned Chromium; the domain template is the only source of layout |
| The PDF is generated by the frozen `receipt.generate` worker job | ✅ | `T20` enqueues transactionally, the worker renders, retries are no-ops; the read path re-enqueues and is proved never to render (a throwing renderer is passed to it) |
| A confirmed return creates a `SettlementReturn`, repays the facility, attaches a return notice, and leaves the settlement row and receipt hash byte-identical | ✅ | Scenario `…0004`; whole-row and whole-artifact equality assertions |
| `SETTLED` has no outgoing transition — verified by enumerating the table | ✅ | Enumerated over `TRANSITIONS`, for `SETTLED`, `FAILED` and `CANCELLED` |
| A return that fails its authoritative check is `REJECTED` and alarms | ✅ | `N03` with `alarm: 'return_not_upheld'`; the audit carries the claim beside what the check found |
| The receipt is write-once: identical before and after any number of returns; storage grants no overwrite | ✅ | Trigger refuses `UPDATE`/`DELETE` from the superuser; grants are `SELECT, INSERT` only, asserted from `information_schema`; `putIfAbsent` is the store's only write, and a retried print neither re-renders nor re-writes |
| Each Return Notice is a separate artifact with its own hash and PDF; the composite is a third | ✅ | Two partial returns → two notices, two hashes, two object keys, one untouched receipt |
| Cumulative confirmed returns never exceed the delivered amount under concurrent confirmation, and the `CHECK` holds without the lock | ✅ | `…0011` sequential; two parallel confirmations that individually fit; raw superuser `UPDATE` refused by the `CHECK` |
| The same real-world return by webhook and by status pull creates exactly one row | ✅ | `…0012`: one return, two sightings, both recorded |
| A settlement settles without waiting out the window; a return outside it opens in `MANUAL_REVIEW` | ✅ | `…0014` at 120 days against a 30-day window; the window it was judged against is stored |
| No finality condition, API field or UI element references a duration, countdown or hold on a settled settlement | ✅ | `check-finality-integrity.mjs`, plus a test that the evidence shape contains no temporal field and no verdict sentence is temporal |
| A code search confirms no "mark as paid", force-settle or status-override path exists in any surface | ✅ | `check-finality-integrity.mjs`, in `pnpm run verify`, with its own fixture tests |

### Testing obligations 12–15

| # | Obligation | Where |
|---|---|---|
| 12 | Finality: F1–F6 individually, plus terms-hash drift | `finality.test.ts` |
| 13 | Return integrity: repayment, byte-identity, separate notice, cap under contention, two-channel dedupe | `settlement-returns.test.ts` |
| 14 | Observation window: settles without waiting, inside takes `N02`, outside opens in `MANUAL_REVIEW`, no finality condition reads it | `settlement-returns.test.ts` |
| 15 | Unmapped input: ingested, persisted, acknowledged, defaulted, alarmed, queue draining | `settlement-returns.test.ts` (return reasons) and Stage 5's `…0009` (provider codes) |

### The five Stage 5 handoffs, discharged

Stage 5 recorded each as a typed `ScenarioHandoff` and proved its own half.
`handoffsTo('Stage 6')` enumerates them, and each test asserts the obligation it
is discharging rather than restating it.

| Row | Stage 5 produced | Stage 6 obligation, now met |
|---|---|---|
| `…0001` | a `CREDITED` attempt whose `credited_minor` is ₹5,000 below the instruction | compare and open a `MISMATCH` on a non-zero delta (`INV-26`) |
| `…0004` | an attempt moved `CREDITED → RETURNED` with UTR and credit timestamp intact | open a `SettlementReturn`, leaving the settlement `SETTLED` and its receipt unchanged (`INV-42`, `INV-48`) |
| `…0011` | three rail-level return notifications, the third past the delivered total | cap cumulative confirmed returns under the row lock; route the breach to `MANUAL_REVIEW` (`INV-49`) |
| `…0012` | one stored webhook event plus a pull reporting the same return | deduplicate on the second key so exactly one `SettlementReturn` exists (`INV-50`) |
| `…0014` | a return carrying its own arrival time, far after the credit | route an out-of-window return to `MANUAL_REVIEW` rather than the normal path (`INV-40`) |

---

## 7. Decisions

| # | Technical mechanism | External parameter |
|---|---|---|
| `D-04` return observation window | **CLOSED.** Triage only, structurally unreachable from finality; a late return still opens, then escalates; the window judged against is stored on the return. | **EXTERNAL.** The duration per rail. `null` — no partner number — makes every arrival ordinary rather than applying an invented threshold. |
| `D-14` partial credit | **CLOSED.** Zero tolerance with no parameter to widen; `MISMATCH` blocks finality twice over; a `MATCHED` row with a non-zero delta is unwritable; resolution requires an attributed decision *and* an explicit compensation answer. | **EXTERNAL.** Top up, reverse, absorb or bill. Nothing assumes one, and the evidence a policy needs is already collected. |
| `D-17` returned settlements | **CLOSED.** Facility repayment is pro rata against the original drawdown, applying **no FX rate at all** — the fraction of the delivery that came back is the fraction of the drawdown repaid. Floor, so a full return is exact and a partial one can never over-repay. | **EXTERNAL.** Fees, the rate the customer is made whole at, who bears the movement. The notice states the amount and the reason and claims nothing about what is owed. |

`decisions/0011-return-observation-window.md`,
`decisions/0012-partial-credit-and-returned-settlements.md`.

Unchanged and still open: `D-06`, `D-11`, `D-08b`, `D-09b`, `D-05b`, `D-16b`,
`D-13` (the numbers), `D-15` (placement), `D-18` (policy half). `D-01`/`D-02`
remain the counsel gate and the Stage 11 blocker.

---

## 8. Clean CI

```
EXIT=0
Test Files  49 passed (49)
     Tests  997 passed (997)
```

Stage 6 added **91 tests**: 36 finality and artifacts, 30 returns, 11 return
surfacing, 13 finality-gate fixtures, 1 discharging the `R04` companion.

`pnpm run verify` gains `check:finality`, so both of the stage's code-search exit
criteria run on every build rather than once by hand at the end.

---

## 9. Defects and deviations found

1. **A Stage 4 index that Stage 6 makes too strong.** `repayments_one_live_per_settlement`
   was keyed on `(settlement_id)`, with sound reasoning for what Stage 4 could
   see: *"A settlement's funding is drawn once, so it is repaid once."* That holds
   for a cancellation, of which there is at most one. It does not hold for
   returns — `§ 8.4` clause 6 supports multiple partial returns against one
   settlement, and `INV-41` gives each confirmation its own repayment.

   Found by the second partial return in a test, refused by the database. The key
   now carries the cause: `(settlement_id, COALESCE(return_id, ''))`. Nothing
   Stage 4 refused is now permitted — two live cancellation repayments still
   collide — and what stops N partial repayments over-restoring was never this
   index anyway: it is `INV-49`'s cap and the pro-rata arithmetic.

2. **`R04` opened the wrong exception code.** The first cut used
   `RECONCILIATION_MISMATCH`; `T30`'s own note in the frozen table says
   `FINALITY_EVIDENCE_MISSING`. The distinction is real and operational: a
   mismatch means we compared and the figures disagreed, this means nobody ever
   told us what arrived, and the resolution paths differ. Caught by reading the
   note rather than by a test, which is the weaker way to catch it.

3. **The cap-breach path threw instead of alarming.** `JSON.stringify` on a
   detail object carrying `bigint` amounts throws — and the only path reaching it
   was the cap breach, which is the path that must not throw because it is the
   one carrying the alarm. Found by the concurrency test, which is the only test
   that reaches it. Fixed with a bigint-aware serialiser.

4. **The money-column gate caught an unpaired amount in this stage's own
   migration.** `return_observations.observed_amount_minor` had no currency
   beside it. The fix is better than a rename: a sighting now records the amount
   *and the currency the channel reported it in*, because a channel reporting a
   different currency from the return it is about is exactly the disagreement
   evidence exists to preserve.

5. **The finality gate was case-sensitive, and would have passed the copy it
   exists to prevent.** `Settled (provisional)` — sentence case, exactly how
   customer copy is written — slipped through a lower-case `settled` pattern. So
   did `finalityHoldSeconds`, because a trailing `\b` finds prose and misses
   camelCase identifiers. Both found by the gate's own fixture tests, which is
   the argument for writing them.

6. **A baseline deviation, found in review: the PDF was hand-written.**
   `ARCHITECTURE.md § 9` requires the PDF to be *"produced by headless Chromium
   rendering the **same** template"*. The first cut of this stage shipped a
   hand-written PDF writer instead, on the reasoning that a library stamping
   `/CreationDate` would make two renderings differ and trip the write-once
   store's byte comparison.

   The reasoning was wrong at its root, and the root is worth stating: **the PDF
   is not the receipt.** `content_hash` covers the canonical serialisation, so
   the PDF's bytes were never part of the receipt's identity, and requiring them
   to be reproducible was solving a problem the invariants do not have. The byte
   comparison in the store was a cheap extra check that only worked *because*
   rendering happened to be deterministic — it was never the guarantee. The
   guarantee is that an artifact id is a primary key, the object key is derived
   from it, and a unique index refuses a collision.

   Restored to the baseline: a shared `renderReceiptTemplate` in the domain that
   the UI and Chromium both render, `playwright-core` driving pinned Chromium in
   the providers package, `content_hash` unchanged, and generate-once/write-once
   preserved without byte equality.

   A second review pass corrected where the print happens. The first restoration
   moved it after the commit — correct — but let the *read* path render on a
   miss, which quietly put a browser launch on a request path. `ARCHITECTURE.md
   § 7` already names `receipt.generate` as a job class, and that is the answer:
   `T20` enqueues, the worker prints, a read may re-enqueue and may not render.
   Migration `0011` registers the task, so asking for the work is a migration
   rather than a string typed at a call site.

7. **The liquidity vocabulary gate caught new customer copy.** Two return-notice
   sentences said *"your facility"*. `PRODUCT.md § 12` keeps liquidity as
   INRSettle's arrangement with a provider, never something the customer
   operates. The copy now talks about their money instead of our plumbing.

---

## 10. What Stage 7 inherits

- A settled settlement that is genuinely terminal, with a receipt whose bytes
  and hash are fixed, and a return aggregate that references it without the
  ability to touch it.
- `beginReconciliation` and `evaluateAndSettle` take a settlement at a time.
  Batches (`INV-30`: *"a batch is a container, not a transaction"*) will drive
  many of them independently; nothing here holds a lock across settlements or
  assumes one settlement per transaction beyond its own row.
- Four sweepers now exist with the same shape and the same refusal — no
  injectable clock, because elapsed time is a fact rather than a caller's
  assertion: the payout SLA sweeper, the reconciliation poller, the repayment
  watcher and the return watcher.

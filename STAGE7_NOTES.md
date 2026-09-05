# Stage 7 — Batches

Scope per `IMPLEMENTATION_PLAN.md § 3`: *"Batch container, CSV import with
row-level validation, API creation, aggregates."*

Not built here: the public `/v1` API surface and webhook delivery (Stage 8).
**No real provider is integrated.**

---

## 1. The one idea, and the line of code that carries it

> `INV-30` — *"A batch is a container, not a transaction. An invalid or blocked
> row never blocks a valid row, and the batch has no all-or-nothing semantics."*

The most important thing in this stage is a `for` loop that opens **a new
transaction per row**. Importing five hundred rows inside one transaction would
make `INV-30` unimplementable at the storage layer: the forty-first row's
constraint violation would roll back the forty valid settlements before it, and
no amount of careful error handling above would change what the database did.

So each row commits or fails alone. That costs five hundred round trips and it
buys the invariant — and the test that proves it counts rows *in the database*
after an import containing failures, because the service layer's own report is
not evidence about what was committed.

`importBatchCsv` takes the connection **pool**, not a transaction, and that is
the same type-level refusal `submitDispatchedPayout` and `materialiseArtifactPdf`
use, for a different reason each time. There it was *this must not be slow inside
a lock*; here it is *this must be allowed to partially succeed*.

---

## 2. What a batch may not do

Move a settlement. There is no path from `batch.service.ts` into
`applyTransition`, and authorization fans out to `authorizeSettlement` — the same
`T08`, with the same guards. A batch that could transition its rows would be a
transaction wearing a container's name.

The schema says the same thing twice more:

- **no cascade to settlements.** Deleting a batch removes its rows and stops. A
  settlement outlives its container because it was a settlement first.
- **no batch pointer on `settlements`.** The membership edge lives on
  `batch_rows`, one direction only, so nothing can treat "which batch was this
  in" as part of a settlement's identity.

And two `CHECK`s make the two halves of `INV-30` unwritable in the wrong shape:
an `INVALID` row has no settlement and must carry errors; anything else has a
settlement.

---

## 3. CSV import

The exit criterion is a higher bar than it sounds:

> *"CSV errors are per-row and name the column and the fix."*

`"invalid amount on line 42"` names neither — not which column when a row has
three amounts, and not what to do. Every `RowError` carries `column`, `problem`
and `fix`, and `fix` is written as an instruction, because the person reading it
has a spreadsheet open and needs to know which cell to change. A test asserts
this as a *property of every error the parser can produce*, not of one example.

Some specifics that are deliberate:

- **A third decimal place is refused, not rounded.** `100.005` means somebody's
  export is wrong, and quietly making it `100.00` or `100.01` decides in their
  favour or against them without telling them.
- **No float is ever created.** Rupee strings go straight to minor units as
  `bigint` (`INV-02`, `INV-04`), and a test carries `90071992547409.91` through
  intact — a figure a `double` would silently corrupt.
- **The parser handles what Excel produces**: quoted fields with commas, doubled
  quotes, embedded newlines, CRLF, a missing final newline, a trailing blank
  line, and a byte-order mark. That last one is why `beneficiary_id` would not
  equal `beneficiary_id`, which is a baffling failure to debug from a support
  ticket.
- **Every row is validated.** The parser never stops early, because stopping at
  line 3 would block lines 4 and 5 from ever being reported — `INV-30` applied
  to the error report as well as to the settlements.
- **There is no beneficiary-creation column.** `PRODUCT.md § 11`: a beneficiary
  is *"a first-class, reusable domain object. Verify once, settle many times."*
  Letting a CSV mint one would put beneficiary creation on a path with no
  verification step in it.

A row that only the database can refuse — a well-formed `ben_…` that does not
exist — becomes an `INVALID` row rather than an aborted import, with a message
naming the beneficiary page *and the environment*, because a sandbox id used in
Live looks exactly like a typo.

---

## 4. Idempotency

> *"Import is idempotent — the same file twice does not double-create."*

Content-addressed: the key is `sha256(name + csv)`, unique per workspace and
environment. A customer whose upload timed out re-sends identical bytes and gets
their existing batch back. A customer who genuinely means to pay the same people
again has changed something — a date, an external reference — or passes an
explicit key, which overrides the fingerprint.

The **name is part of the key** on purpose. Two files with identical rows but
different names ("September", "October") are two intentions, and somebody who
renamed a template and re-sent it meant a second batch.

---

## 5. Aggregates

Every counter is **derived from the rows** on each refresh, never incremented in
place. Six counters updated by however many code paths touch a row is six chances
to forget one, and the first time that happens the batch screen tells a customer
they have 143 settlements worth ₹12,840,000 when they have 142 worth less.

Two consequences worth stating:

- **`total` sums only rows that became settlements.** An invalid row has an
  amount in the file and no settlement in the system; adding it to the headline
  would claim money is moving that is not.
- **Row outcomes are derived from the *customer* projection.** `INV-18` allows
  one projection of the settlement machine, and the batch reads it rather than
  keeping a second opinion. `FAILED` is the one case that consults the internal
  status, because it projects to `CANCELLED` and a batch that could not report
  failures separately would be less useful than the data allows.

`COMPLETED` requires every row resolved **and** none needing attention. 460
settled with 40 invalid is `PARTIALLY_COMPLETED` — the honest answer, and why
the frozen state line has two terminal states. The UI label says *"Completed with
rows to fix"*, never *"Completed"*.

A batch where nothing was executable takes **the same path as every other**:
`VALIDATING → READY → EXECUTING → PARTIALLY_COMPLETED`. `EXECUTING` is the
container's phase rather than the rows', and a batch of five hundred invalid rows
completes that phase with zero executable rows. No settlements are created during
it, and none need to be.

---

## 6. Stage 7 exit matrix

| Criterion | Status | Evidence |
|---|---|---|
| A 500-row import with 40 invalid rows settles the 460 valid ones and blocks only the 40 (`INV-30`) | ✅ | `batches.test.ts`, counted in the database after the import: 460 rows with a settlement, 40 without |
| CSV errors are per-row and name the column and the fix | ✅ | Asserted as a property of every error the parser can produce, plus the 40 blocked rows each carrying their own |
| Import is idempotent — the same file twice does not double-create | ✅ | Same bytes → same batch, one row, `idempotent: true`; a changed file, a changed name and an explicit key each tested |

### Beyond the three

| Property | Evidence |
|---|---|
| An invalid row cannot claim a settlement, and a valid one cannot exist without | Two database `CHECK`s, attempted from raw SQL as the superuser |
| One settlement belongs to at most one batch | Unique index, attempted and refused |
| Deleting a batch never deletes a settlement | `confdeltype` asserted to be `NO ACTION` |
| A row only the database can refuse still lands as an invalid row | Unknown beneficiary between two good rows; both neighbours accepted |
| The API path validates identically to the CSV path | It *is* the CSV path — rows are rendered to CSV and put through the same validator |
| Aggregates survive drift | Counters corrupted directly, then recomputed from the rows |

---

## 7. Decisions

| # | Technical mechanism | External parameter |
|---|---|---|
| `D-12` batch authorization | **CLOSED.** One action authorizes N settlements by performing `T08` N times — each with its own guards, its own separation-of-duties check, its own audit record and its own transaction. The capability is `settlement:authorize` and there is **no** `batch:authorize`: `D-07` already settled that separation of duties *"does not become a second permission"*, and authorizing in a batch is the same act. The `batch.authorized` audit entry records eligible, authorized, refused and the settlement ids — a mistake's reach is only investigable if something wrote down how far it reached. | **EXTERNAL.** A cap on rows per action, a Live confirmation threshold, and whether a batch authorization is reversible as one action. No number is invented. The third is not merely unanswered but currently unsafe: a bulk undo racing 143 points of no return would tell a customer their batch was cancelled while some of it was live in India, and it needs `D-15`'s placement first. |

`decisions/0013-batch-authorization.md`.

Unchanged and still open: `D-06`, `D-11`, `D-04b`, `D-05b`, `D-08b`, `D-09b`,
`D-13`, `D-14b`, `D-15`, `D-16b`, `D-17b`, `D-18b`. `D-01`/`D-02` remain the
counsel gate and the Stage 11 blocker.

---

## 8. Clean CI

```
EXIT=0
Test Files  53 passed (53)
     Tests  1073 passed (1073)
```

Stage 7 added **62 tests**: 29 domain (CSV, lifecycle, aggregates), 21 against a
real database, 10 on the batch surfaces, 2 on the corrected all-invalid path.

Also green from a clean checkout — a fresh copy of the tree with no
`node_modules`, no `dist` and no build info, `pnpm install --frozen-lockfile`,
then `pnpm run verify`.

---

## 9. Deviations and judgement calls

1. **The batch transition ids are Stage 7's, not the baseline's.** Every other
   sub-machine in `STATE_MACHINES.md § 6` has a numbered table; § 6.8 gives the
   batch its states and their order and numbers nothing. `B01`–`B05` are this
   stage's numbering of that sequence, said so in the module docstring, and they
   carry no more authority than that. The **states and their order** are the
   frozen part and are what a later revision should be checked against.

2. **An added edge, found in review and removed.** The first cut of this stage
   added `B06`, a `READY → PARTIALLY_COMPLETED` shortcut for a batch where every
   row was invalid, reasoning that routing it through `EXECUTING` would record
   work that never happened.

   That was a new transition on a frozen machine to describe something the
   existing path already describes. `EXECUTING` is the *container's* phase, not
   the rows': entering it says the execution phase began, not that any settlement
   moved, and a batch with nothing executable completes that phase with zero
   executable rows. The frozen sequence needed no extension, and a test now
   asserts the table's edges are exactly the ones the state line draws.

3. **A test that ordered by a random id, and passed on a coin flip.** The test
   proving the all-invalid path goes through `EXECUTING` read the batch's events
   back with `ORDER BY id`. `INV-09` makes external ids random and
   non-sequential *on purpose*, so that clause orders by nothing; the assertion
   held on one run and failed on the next.

   Fixed by ordering on `created_at`, which is the transaction-start time and so
   genuinely records the sequence of two separate transactions. The same clause
   in `payout-execution.test.ts` was fixed with it. Worth writing down because
   the general form is not a batch problem: **events written inside one
   transaction share a `now()` and have no order between them**, which is
   `INV-32`'s companion set saying they are simultaneous. A test that asserts an
   order among companions is asserting something the system does not promise,
   and the honest shape there is a stable total order for snapshot comparison —
   `created_at, type` — not a chronology that does not exist.

4. **The CSV columns are chosen, not quoted.** `PRODUCT.md § 10` names CSV import
   and stops. `beneficiary_id, amount_inr, purpose_code, external_reference` is
   the minimum that maps onto `createSettlement`, and the notable absence — any
   beneficiary-creating column — is argued above.

5. **`fundingCurrency` is `USDT` for every imported row.** Not a decision so much
   as the absence of one: the CSV has no funding-currency column because V1 has
   one funding path (`D-10`, closed), and inventing a column for a choice that
   does not exist would be building the alternative that decision closed.

6. **The 500-row import takes about eleven seconds.** That is five hundred
   transactions plus preflight, and it is the honest cost of `INV-30`. It is
   flagged because it is the number that will tempt somebody to batch the
   transactions later — and that somebody should read this note first.

---

## 10. What Stage 8 inherits

- A `Batch` with the aggregate shape `API_CONTRACT.md § 8` lists
  (`GET /v1/batches/{id}`, `GET /v1/batches/{id}/settlements`), and the three
  events `§ 10.2` names: `batch.validated`, `batch.completed`,
  `batch.partially_completed`.
- Row errors already rendered by one function, so the API response, the screen
  and a downloaded error report cannot say different sentences about one row.
- `POST /v1/batches` needs *"JSON rows or a CSV upload reference"* — the JSON
  path is `createBatchFromRows` and exists; the upload reference is a Stage 8
  transport concern, not a second validator.
- Idempotency here is content-addressed and per-workspace. Stage 8's
  `Idempotency-Key` header semantics — including the same-key-different-body
  conflict its exit criteria name — is a broader rule that will need to sit over
  this one rather than beside it.

# INRSettle — vNext

**Cross-border settlement infrastructure for India.**

INR ↔ STABLECOINS • GLOBAL SETTLEMENTS

---

## What this repository is right now

**Stages 0–3 are closed. Stage 4's engineering is complete and Stage 5 is
built; Stage 4's formal gate stays open on one founder criterion.** See
[Status](#status) below for what each stage delivered.

`docs/` is the signed baseline — the frozen product, domain, architecture and
security definition that every stage is built against and checked against. It is
under a SHA-256 manifest held in this README, and nothing in it changes without
a new revision number and a new manifest. Decisions taken after the freeze live
in `decisions/` as numbered ADRs until the next revision folds them in.

The implementation lives in `packages/` and `apps/`, with a `STAGE<n>_NOTES.md`
per stage recording what was built, what was deliberately not built, the exit
matrix and the defects found on the way.

| Document | What it settles |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | What we are building, for whom, what it is not, and the exact language we use |
| [docs/DOMAIN.md](docs/DOMAIN.md) | Aggregates, entities, money representation, invariants, ubiquitous language |
| [docs/STATE_MACHINES.md](docs/STATE_MACHINES.md) | Every financial state machine, its transitions, guards and invariants |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, module boundaries, provider ports, event infrastructure, environments |
| [docs/SECURITY.md](docs/SECURITY.md) | Tenant isolation, RBAC, key handling, webhook trust, immutability, audit |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | The public `/v1` surface, idempotency, errors, pagination, webhooks |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Tokens, components, status language, motion, accessibility |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Stages 1–12, exit criteria, risks, and the open decisions review must close |

## Revision history

### Revision 2 — model corrections

The document set was revised after first review. What changed:

- **`AUTHORIZED` redefined.** It means the customer approved an instruction that
  is now immutable, and that execution may begin. It does **not** mean execution
  is irreversible. A separate, explicit **point of no return** — the instant
  payout submission is attempted — is where irreversibility starts, and there is
  a real cancellation window before it.
- **`RETURNED` removed as a settlement status.** A post-settlement return is a
  linked `SettlementReturn` aggregate with its own lifecycle. `SETTLED` is
  terminal and has no outgoing transitions.
- **A return never projects onto `CANCELLED`.** A settlement that was returned
  still reads `SETTLED`, with the return shown as a linked record.
- **`ACTION_REQUIRED` narrowed to preflight.** Execution-phase stalls live in
  `EXCEPTION`, under a closed, typed taxonomy — no catch-all.
- **Quote remains its own aggregate**, unchanged.

### Revision 3 — integrity fixes from independent review

Product direction and core architecture unchanged. Eight integrity issues closed:

1. **The authorized commitment is frozen by value.** A settlement binds an
   immutable `PayoutDestinationVersion`, not a mutable destination id, plus an
   `authorized_terms` snapshot and hash. Editing a destination appends a new
   version and cannot change what an authorized settlement pays or displays.
2. **One event rule.** Every transaction updating `settlements.status` writes
   exactly one *status event* plus any named companions, enforced by a constraint
   trigger. Every status-changing transition now has one, and every sweeper acts
   through a numbered transition — the tables are total.
3. **Repayment has an authoritative lifecycle.** Facility capacity returns only
   at `CONFIRMED`, never on creation or submission, with `UNKNOWN` resolved by
   status pull. A consumed reservation is never released, so a post-settlement
   return cannot double-credit the facility.
4. **The receipt is write-once.** Return Notices are separate immutable artifacts
   with their own hashes and PDFs; an optional composite export is a third
   artifact. The receipt's bytes and hash never change.
5. **`D-10` closed.** V1 has exactly one funding path: live authorization
   requires an active liquidity facility, and F2 has no non-facility branch.
6. **Webhook tolerance is symmetric** — `|now − t| > 300s` fails in either
   direction — and only `worker` holds payout credentials or destination
   decryption.
7. **Returns are capped.** Cumulative confirmed returns can never exceed the
   delivered amount, enforced under a row lock and by a database `CHECK`, with
   provider-return deduplication.
8. **`D-04` role settled and renamed.** What was the "finality hold window" is
   now the **`return_observation_window`** — return-triage policy, not a finality
   concept. It never gates `SETTLED`. The old name implied a settlement was
   provisional until it elapsed; it is not. Only the per-rail duration stays
   open, and exposing a return-risk timestamp to customers is explicitly not a V1
   question.

Plus: the `D-01`/`D-02` gating contradiction is resolved — counsel engagement is
a **Stage 4** exit criterion, not a Stage 1 gate, stated once in
`IMPLEMENTATION_PLAN.md § 2.1`.

### Revision 2 — closed in the final pass

- **The point of no return is an exact boundary** — the commit of the dispatch
  transaction, specified line by line in `INV-36`. Cancellation and dispatch take
  the same settlement row lock, so they are strictly ordered and cannot
  interleave. Once that transaction commits, execution is past the PONR even if
  the outbound provider call later fails; recovery is an authoritative status
  pull, never a cancellation.
- **Replacement links are forward-only.** A replacement carries
  `replaces_settlement_id`; the replaced settlement — which is terminal — is
  never written to. The reverse is derived from an index plus the append-only
  `settlement.replacement_created` event. `INV-38` now forbids *any* field write
  to a terminal settlement, not just a status change.
- **The exception taxonomy stays closed; the provider mapping is open.** An
  unknown provider code is verified, persisted raw, acknowledged, routed to a
  phase-appropriate default that is always non-customer-actionable, tagged with
  the raw values, and alarmed. Interpretation cannot throw and cannot block the
  queue (`INV-43`).

## Status

**Stage 0 signed off** (Revision 3, frozen 2026-08-31; amended by Revisions 4
and 5 on 2026-09-01 and Revisions 6 and 7 on 2026-09-03 — see the signed
baseline below).

**Stage 1 closed 2026-09-01.** Monorepo, database roles and RLS, RBAC,
MFA-gated sessions, API keys, the job-queue bridge and the design-system
primitives. See `STAGE1_NOTES.md`.

**Stage 2 closed** — beneficiaries, immutable payout destination versions, the
verification abstraction with a deterministic sandbox provider, and the
preflight requirement engine. See `STAGE2_NOTES.md`.

**Stage 3 closed 2026-09-03** — exact money and FX primitives, the Quote
aggregate, the full T01–T30 settlement machine, immutable AuthorizedTerms, the
customer projection, cancellation semantics, the point-of-no-return boundary and
per-attempt payout identity. No payout execution, liquidity mechanics,
reconciliation or receipts. See `STAGE3_NOTES.md`.

**Stage 4 engineering complete; the formal gate is open on the founder
criterion.** Liquidity facilities, atomic reservations, drawdown, repayment, the
double-entry ledger and `MockLiquidityProvider`, plus the financial-integrity
proofs: capacity can never be restored beyond real outstanding drawdown, and the
funding leg consumes a reservation only on authoritative evidence that matches
the expected facility, currency and amount. The remaining blocker is **counsel
engaged** (`IMPLEMENTATION_PLAN.md § 2.1`) — a founder action. The questions are
written down in `decisions/0007-counsel-brief-d01-d02.md`. See `STAGE4_NOTES.md`.

**Stage 5 complete, awaiting review** — the `PayoutProvider` port, rail
selection from declared capabilities, `MockIndiaPayoutProvider` with the frozen
scenario table, provider idempotency, signed webhook ingestion with raw-first
persistence, the versioned provider mapping table, SLA sweeping to `UNKNOWN`,
authoritative status pulls, and retry after a definitive rejection. No
reconciliation, finality or receipts; no real provider integrated. See
`STAGE5_NOTES.md`.

**Stage 6 complete, approved** — reconciliation with zero tolerance and no
tunable, the finality evaluator (pure, no clock, no override, every verdict
persisted including the failures), write-once financial artifacts with one
canonical serialisation rendered to PDF by headless Chromium from the same
template the UI uses, and the `SettlementReturn` aggregate that never touches the
settlement it references. See `STAGE6_NOTES.md`.

**Stage 7 complete, approved** — the batch container, CSV import with a
transaction per row (`INV-30` at the storage layer), per-row errors that name the
column and the fix, content-addressed idempotency, derived aggregates, and batch
authorization as *N* independent `T08` transactions with no `batch:authorize`
capability. See `STAGE7_NOTES.md`.

**Stage 8 complete and closed** — the public `/v1` API, API-key
authentication that resolves a scope before RLS can be set and then has RLS
confirm it, idempotency claims that commit with the work they protect, cursor
pagination, dated version pinning, per-key rate limits, webhook endpoints with
dual-secret rotation and signed delivery retried over about 24 hours with every
attempt recorded, request and event logs with replay, and an API reference whose
verification snippets the test suite executes in TypeScript, Python and Go. No
Internal Operations; no real provider integrated. See `STAGE8_NOTES.md`.

**Stage 9 complete and closed** — Internal Operations, on its own
deployment with its own session model. The shape of it is one sentence: **ops
reads across tenants and writes nothing.** `inrsettle_ops` — the explicitly
named role `SECURITY.md § 2` requires — holds `SELECT` on twenty-four tables and
no write privilege anywhere, so an operator action on a settlement is a
tenant-scoped write through the ordinary application role, under every trigger,
`CHECK` and policy a customer action passes through. Also here: four internal
staff roles entirely separate from the workspace ones, network-restricted
sessions re-checked on every request, a mandatory reason enforced at four
layers, every cross-tenant read audited into both the customer's own log and a
cross-tenant one **before** the read happens, and exception resolution — resume,
fail, cancel — with the resume destination taken from
`exception_entered_from` rather than chosen. No `SETTLED`, no override, no
"mark as paid": the capability does not exist for any principal, and a build
gate keeps it that way. Ops sessions carry every restriction a customer session
carries — MFA, a short life, device binding, revoked on mismatch — and the
network one on top, all re-checked on every request and all failing closed when
the evidence is absent. No real provider integrated. See `STAGE9_NOTES.md`.

Decisions taken after the Stage 0 freeze live in `decisions/` as numbered ADRs.
They are folded into the frozen register at the next revision, which is what
Revisions 6 and 7 did for `D-03`, `D-05`, `D-07`, `D-08`, `D-09`, `D-16` and
`D-18`.

### Running the checks

`pnpm run verify` runs the whole pipeline: typecheck, source-tree check, lint,
money-column check, requirement-copy check, liquidity-vocabulary check,
Internal-Operations boundary check, migration-order check,
finality-integrity check, Storybook build, tests. It needs a
Postgres 16 reachable at `TEST_ADMIN_DATABASE_URL`. The script is called
`verify` and not `ci` because pnpm reserves `ci` as a built-in command and will
refuse to run a script of that name.

## Signed baseline

**Revision 7, frozen 2026-09-03.** Revision 3 was signed off on 2026-08-31.
Four amendments have been applied since, each recorded separately so the audit
trail does not conflate them:

- **Revision 4 — accessibility correction**, `DESIGN_SYSTEM.md` only. Two status
  foreground colours darkened to meet the 4.5:1 contrast requirement the same
  document sets. No product, domain or architecture change.
- **Revision 5 — product correction**, `PRODUCT.md` only. The proposed top-level
  *returning* liquidity metric is removed; the temporary reduction in
  *Available to settle* is explained on the affected settlement instead.
- **Revision 6 — decision cleanup**, four documents. **Documentation only: no
  code changed and nothing was redesigned.** This revision makes the frozen
  baseline state the decisions Stage 3 already implemented, so the source of
  truth and the system agree.
  - `D-03` **closed**. `FAILED` projects to customer-facing `CANCELLED`; the
    `resolution` field carries the distinction from a customer cancellation;
    there is no `NOT_COMPLETED` and no sixth V1 customer state. Every place
    that still called it open now says closed. (`PRODUCT.md § 6`,
    `STATE_MACHINES.md § 5`, register.)
  - `D-08` and `D-09` **split**, each into a technical invariant that is closed
    and a commercial parameter that is not. Closed: no silent repricing after
    authorization; `AuthorizedTerms` freeze the quoted economics; fees are
    explicit and never hidden in the FX rate. External and pending real partner
    evidence: quote validity window, who bears FX movement between lock and
    execution, and the fee level and model parameters. **No spread, fee
    percentage, quote window or hedging policy is invented by this revision** —
    the split records which half is engineering and which half is a commercial
    fact still to be learned. The illustrative 10 bps figure in
    `API_CONTRACT.md § 7.2` is now labelled as a sandbox example rather than a
    placeholder awaiting a decision.
  - **T30 / `R04` ownership recorded.** The settlement side of T30 is complete
    as of Stage 3; the `R04` reconciliation companion is owed by Stage 6 and is
    carried as a typed deferred obligation rather than emitted against an
    invented aggregate. (`STATE_MACHINES.md § 4`, § 6.4.)

- **Revision 7 — register cleanup**, two documents (`IMPLEMENTATION_PLAN.md`,
  `SECURITY.md`). **Documentation only: no code changed and nothing was
  redesigned.** It records five register decisions that were already made and
  implemented.
  - `D-07` **closed**: separation of duties is **configurable per workspace,
    defaulting off in Sandbox and on in Live**, with every change to the setting
    separately audited. `SECURITY.md § 3.2` carried the open question and now
    carries the answer.
  - `D-05` **split** — TTL *mechanism* closed (`NOT NULL expires_at`, V04 drives
    T28, idempotent with release, a `CONSUMED` reservation never expires); TTL
    *duration* external, supplied as configuration with no default.
  - `D-16` **split** — compensation *mechanism* closed (release an `ACTIVE`
    reservation, request a repayment for a `CONSUMED` one, and restore no
    capacity until it confirms); *fee, rate-limit and abuse policy* external.
  - `D-11` **deliberately left open**, pending real verification-provider
    evidence, with a note in the register saying so — the abstraction is built,
    the answer is not, and it should not be closed by tidying.
  - `D-18` **added**: partial drawdown handling. The technical invariant is
    closed — evidence that does not match the requested facility, currency and
    amount exactly never produces `DRAWDOWN_CONFIRMED` and never consumes the
    reservation — and the production response policy is external, required
    before Stage 11. **No retry, top-up or failure economics is invented.**

That register revision left `API_CONTRACT.md`, `ARCHITECTURE.md`,
`DESIGN_SYSTEM.md`, `DOMAIN.md`, `PRODUCT.md` and `STATE_MACHINES.md`
untouched. Two of them have moved since, both during the Stage 8 review and both
because an implementation could not satisfy every frozen document at once:

- `API_CONTRACT.md` is at **Revision 7**. § 7.3 and § 8 now state what
  `POST /v1/settlements` returns while preflight is still running — `202
  Accepted`, and `status: null` between creation and the end of preflight and
  only then. The five customer statuses are unchanged and no sixth one was
  invented; null is the absence of a status, and such a settlement is unlisted
  but readable by id.
- `ARCHITECTURE.md` is at **Revision 4**. § 7's job-class list was missing
  `beneficiary.verify`, which `POST /v1/beneficiaries/{id}/verify` needs and
  which `SECURITY.md § 8` requires to be worker-owned. `D-19` closes with it.

Both are recorded in `decisions/`. `DESIGN_SYSTEM.md`, `DOMAIN.md`,
`PRODUCT.md` and `STATE_MACHINES.md` retain their existing digests.

These are the SHA-256 digests as frozen; any byte-level change to a document
changes its digest, so this block identifies exactly which file set is signed
off.

```
a33f9f44e9cf2facbf1970292d72768e071bb84840c0055cd445001396ed9e2d  docs/API_CONTRACT.md
6b2951a02a3f790f10093d617b478ba5bbd3a1caeb9c8367a176c51baa8204c4  docs/ARCHITECTURE.md
86a5620cc34c31403d25045a636c13c870fa1d4f48ee08bf98d95f05127f792a  docs/DESIGN_SYSTEM.md
930139ec6f527d17e3ebb6c50f4814305e97862328f05679a7fbe8418de43ba7  docs/DOMAIN.md
1b2826b57dd496f20785386f2e23a7bf2d036b9283a5d9779bbc65f0cacd0f00  docs/IMPLEMENTATION_PLAN.md
e089e862a19fadaa09d413a9b78f3d4cacb6252727564c837bfa8a15f03ee736  docs/PRODUCT.md
f785ca841719d8fb5b92f47149b71b55a14b174b099406f4765825283e74e044  docs/SECURITY.md
112bb74eca390cef4e780c807eed47f4d1f730e2abf81b44fb33ffb3ebfdc182  docs/STATE_MACHINES.md
```

This README is the manifest holder and is deliberately not listed in it. Nothing
in `docs/` changes again without a new revision number and a new manifest.

Decisions taken after the freeze live in `decisions/` as numbered ADRs and are
folded into the register at the next revision.

## How to review this

Read in this order: `PRODUCT` → `DOMAIN` → `STATE_MACHINES` → `ARCHITECTURE` →
`SECURITY` → `API_CONTRACT` → `DESIGN_SYSTEM` → `IMPLEMENTATION_PLAN`.

The last document ends with an **open decisions register**. Those are the items
that genuinely cannot be resolved from the master prompt alone and need a
founder or a design-partner conversation. Everything else in these documents is
a decision already made — argue with it, but it is not left hanging.

## The rule that governs everything here

> Tell INRSettle who in India must receive how much INR. INRSettle executes the
> settlement through connected liquidity and payout infrastructure and gives you
> one final settlement result.

If a feature, a screen, a field or an endpoint does not reinforce that sentence,
it does not belong in V1.

## Clean sheet

No product logic, UI, information architecture, workflow, terminology or code is
carried over from any previous INRSettle project. The only inherited assets are
the name, the logo, the brand signature and the company category.

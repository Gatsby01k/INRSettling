# ADR 0013 — Batch authorization is a fan-out, not a new kind of authorization (D-12)

Status: **Split** · 2026-09-04 · Implemented in Stage 7

## Why this lives here and not in `docs/`

Stage 0 Revision 7 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

The register asks three questions in one line:

> **`D-12`** *"Batch authorization semantics. Does one action authorize 143
> settlements? What permission does that need, and what is the blast radius of a
> mistake?"*

They are not equally open. The second has an answer the codebase has already
given once, and the first and third turn out to be about different things —
mechanism and policy — which is where the split falls.

## Decision — split

### Technical mechanism: CLOSED

**One action authorizes 143 settlements by performing `T08` one hundred and
forty-three times.** There is no batch-level transition, no bulk path, and no
code that authorizes a settlement other than `authorizeSettlement`.

That follows from `INV-30` directly. *"A batch is a container, not a
transaction"* means a batch cannot be the subject of a financial decision; the
settlements can, and each of them already has a transition for it with guards
that were written to be checked. `authorizeBatch` iterates and calls the
existing service, and every row therefore gets:

- **its own guard evaluation** — `quote_valid_for_authorization`,
  `beneficiary_verified`, and the rest, checked against *that* settlement;
- **its own separation-of-duties check**, against the same per-workspace policy
  `D-07` closed, evaluated per row because creator-and-authorizer is a fact about
  a settlement rather than about a file;
- **its own audit record**, naming its own actor and its own settlement;
- **its own transaction**, so a row refused by its guards is refused *alone*.

That last point is `INV-30` at the one operation where the all-or-nothing
instinct is strongest. A batch of 143 in which two rows have expired quotes
authorizes 141 and reports the two, rather than refusing 143 because of two.

**The permission is `settlement:authorize`, and there is no second one.** `D-07`
settled this shape when it closed separation of duties:

> *"`settlement:authorize` remains the capability; separation of duties
> constrains **who** may exercise it, and does not become a second permission."*

Minting `batch:authorize` would repeat exactly the mistake that reasoning
rejected. Authorizing a settlement in a batch is the same act as authorizing one
alone — the person is committing to the same payment, under the same frozen
terms, with the same consequences. A separate capability would let a workspace
grant somebody the ability to authorize 143 settlements but not one, which is
precisely backwards.

**Blast radius is bounded by what already exists, and is made investigable.**
Each authorization is individually cancellable up to its own point of no return
(`INV-36`), individually auditable, and individually visible on its settlement.
What Stage 7 adds is the record of the *action*: a `batch.authorized` audit entry
carrying how many rows were eligible, how many were authorized, how many were
refused, and the settlement ids it touched. A mistake's reach is only
investigable if something wrote down how far it reached.

### Blast-radius policy: EXTERNAL

Three questions are deliberately **not** answered, because none of them has an
engineering answer and all of them need evidence nobody has yet:

1. **Is there a maximum number of settlements one action may authorize?** A cap
   is a real control, and any number chosen now would be invented. The evidence
   needed is the distribution of real batch sizes, which arrives with the pilot.
2. **Does Live require a second confirmation for a batch above some size?** Same
   shape as `D-07`'s Sandbox/Live asymmetry, and it should be answered the same
   way — by what the blast radius actually costs, which depends on partner terms
   that do not exist.
3. **Should a batch authorization be reversible as one action?** It cannot be
   today, and that is the honest default: each settlement's cancellability is its
   own, governed by its own point of no return, and a bulk undo that raced 143
   PONRs would tell a customer their batch was cancelled while some of it was
   live in India. Building it would need `D-15`'s placement answered first.

No cap, no threshold, no confirmation step and no bulk undo is invented. What
Stage 7 does provide is the evidence those policies will need: every batch
authorization records its extent, so the size and shape of the behaviour is
measurable before anyone has to bound it.

## Consequences

- `D-12` is closed on mechanism and open on policy, needed before the first Live
  workspace runs a large batch — Stage 11 in practice.
- Adding a cap later is a check in `authorizeBatch` against a configured number,
  not a redesign: the fan-out already refuses rows individually and reports them.
- The absence of `batch:authorize` is load-bearing and should stay absent. If a
  future stage wants to let someone run batches without letting them authorize
  settlements, the thing they want is a *different action* — import and
  validation, which needs no financial capability at all — not a weaker version
  of the same one.

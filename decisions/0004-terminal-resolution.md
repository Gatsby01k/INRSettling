# ADR 0004 — `FAILED` projects to `CANCELLED` with a resolution reason (D-03)

Status: **Accepted** · 2026-09-02 · Implemented in Stage 3

## Why this lives here and not in `docs/`

Stage 0 Revision 3 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

`D-03` asked whether the customer-facing state set needs a sixth member to
distinguish a settlement that *failed* from one that was *cancelled*. The
candidate name in the register was `NOT_COMPLETED`.

The pressure behind the question is real. Internally these are two different
states with different causes, different operational follow-up and different
reporting. `PRODUCT.md § 3` nonetheless fixes the customer-facing set at five —
`READY`, `SETTLING`, `SETTLED`, `ACTION_REQUIRED`, `CANCELLED` — and Stage 3 had
to either honour that or make the case for widening it.

## Decision

**`FAILED` and `CANCELLED` both project to the customer-facing state
`CANCELLED`.** The difference between them is carried by a *resolution reason* —
a code from a closed set, with a customer-facing sentence attached. There is no
`NOT_COMPLETED` and no sixth customer-facing settlement state.

## Why this is the right shape rather than a compromise

The five customer states answer one question: *what is happening to my money.*
`FAILED` and `CANCELLED` have the same answer to it — nothing was delivered and
your liquidity is released. By the test that generated the state set, they are
one state.

What genuinely differs is *why*, and a reason line says that better than a state
name ever could. "Cancelled — our payout partner declined this transfer and we
could not complete it" is information a customer can act on. A state called
`NOT_COMPLETED` sitting next to a state called `CANCELLED` is a puzzle they have
to solve first, and the answer is not in the name.

There is also a cost to the sixth state that is easy to underweight at the point
of adding it. A customer-facing state is a public API value, a filter in every
list view, a column in every export, a branch in every integrator's switch
statement, and a row in every status-mapping table a partner maintains. It is
the most expensive kind of thing to add and nearly impossible to remove. A
reason code is additive: new codes can be introduced without breaking anyone,
and an unknown code degrades to the state, which is still correct.

`API_CONTRACT.md § 7.4` already carries `resolution: { code, message }`, so this
reading closes `D-03` without changing a single wire contract. That is a signal
the frozen documents already assumed this answer.

## What is implemented

- `packages/domain/src/settlements/resolution.ts` — the closed set of nine
  resolution codes, each bound to exactly one terminal status and carrying one
  customer-facing sentence.
- `projectCustomerStatus` maps `FAILED` and `CANCELLED` to `CANCELLED`, as
  before; the decision changes the comment above it from "narrowed and left
  open" to closed, and adds the reason beside it.
- The customer surfaces render the badge from the state and the explanation from
  the reason. `customerStateBadge` no longer takes the resolution at all, so the
  badge cannot drift into being a sixth state by another route.
- `packages/domain/src/__tests__/resolution.test.ts` — including a test that
  the string `NOT_COMPLETED` appears in neither status set.

## What this does not decide

Nothing about pricing. The invariant that authorization freezes the quoted
economics and that fees are explicit rather than buried in the FX rate is
untouched: a terminal settlement still shows the terms it was authorized on, and
a resolution reason is an explanation of an outcome, never an adjustment to it.

`D-08` (FX spread and rate sourcing) and `D-09` (fee schedule) remain **open**
pending real partner evidence, unchanged by this decision.

## Consequences

- Every path to a terminal state must supply a resolution code. A terminal
  settlement with no reason would show a bare "Cancelled" and would be a
  regression to the state of affairs this decision rejects.
- The set is closed and typed, so adding a reason is a deliberate act with a
  customer-facing sentence attached to it, reviewed as copy.
- If real usage later shows customers genuinely cannot tell the two apart from
  the reason alone, the evidence for reopening `D-03` will be specific — which
  reason line failed, and how — rather than a hunch at design time.

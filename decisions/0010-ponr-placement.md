# ADR 0010 — The point of no return stays at the dispatch commit (D-15)

Status: **Accepted for V1** · 2026-09-03 · Confirmed in Stage 5

## Why this lives here and not in `docs/`

Stage 0 Revision 7 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

`D-15` is careful about what is and is not open, and the register says so:

> *"Its **mechanism** is settled and not open: the boundary is the commit of the
> dispatch transaction (`INV-36`), and cancellation is serialized against it by
> row lock. What remains open is **where in the flow that transaction is
> placed**."*

The register also names the prize: some Indian payout providers allow a queued
instruction to be withdrawn before a batch cut-off. If the first real partner
does, dispatch can be split so the boundary lands at the provider's own cut-off
instead, and *"the customer's cancellation window gets materially longer — a
real product advantage."*

## Decision

**The boundary stays immediately before the outbound call, unchanged for V1.**

This is the conservative placement the register describes, and Stage 5 confirms
rather than revisits it. Moving it requires a real partner that offers
withdrawable queued instructions, and that partner does not exist yet.

## What Stage 5 verified, rather than assumed

Building the outbound call is what made the boundary's properties testable for
the first time, and all three hold:

- **The call is outside the transaction.** `submitDispatchedPayout` takes the
  connection pool rather than a transaction, so a caller cannot wrap a network
  call in a row lock — that is a type error, which is a better place to learn it
  than an incident.
- **A failed call does not un-cross the boundary.** Scenario `…0010` dispatches,
  commits, then fails the outbound call. `point_of_no_return_at` stays stamped,
  the attempt stays at number 1 with its original key, and a second dispatch is
  refused. Recovery is a status pull.
- **A timed-out call is not a failed one.** Scenarios `…0005` and `…0010` both
  throw the same `PayoutTimeout` carrying the same information, and only a pull
  separates "the payout exists" from "it does not".

## What would move it, and what would have to be true first

A split dispatch — cross at the provider's cut-off rather than at our submit —
needs all of the following from a real partner, and none is available today:

1. a queue-and-withdraw API with a documented withdrawal window;
2. an authoritative way to know an instruction is still withdrawable, because a
   cancellation that races the cut-off is worse than no cancellation at all;
3. the cut-off times themselves, which is `D-13`.

Note the dependency: `D-15b` cannot be answered before `D-13`, since the
extended cancellation window *is* the cut-off schedule. Answering them together
with the first partner is the sensible sequence.

**Moving it changes placement only.** The commit-boundary rule and the locking
discipline hold either way, and `INV-36` is written to survive the change: it
specifies the transaction's contents and its ordering, not where in the flow it
sits.

## Consequences

- Customers get the shorter cancellation window in V1. That is the honest
  trade: a window we can actually honour, rather than a longer one we might have
  to withdraw.
- `D-15` stays **open on placement** and closed on mechanism, exactly as the
  register has it. Stage 5 adds evidence, not an answer.

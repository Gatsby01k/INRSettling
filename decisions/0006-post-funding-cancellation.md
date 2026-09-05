# ADR 0006 — Post-funding cancellation: mechanism closed, policy external (D-16)

Status: **Accepted** · 2026-09-03 · Implemented in Stage 4

## Why this lives here and not in `docs/`

Stage 0 Revision 6 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

`D-16` asks what happens when a settlement is cancelled after its drawdown has
confirmed. The register frames it exactly right: *"Cancelling after a confirmed
drawdown reverses a real funding movement. Is it always allowed, fee-bearing, or
rate-limited? A workspace that reserves and cancels repeatedly ties up facility
availability."*

That question has a mechanical half and a commercial half, and they have very
different owners. What *happens to the money* is an invariant. Whether the
customer may do it, and what it costs them, is a commercial policy that depends
on what the reversal costs INRSettle — which depends on the liquidity partner's
terms, which do not exist yet.

## Decision — split

**Technical invariant: CLOSED.** The compensation is decided by where the money
got to, and by nothing else.

`compensateCancellation` reads the reservation and branches once:

| Reservation state | Compensation | Effect on availability |
|---|---|---|
| `ACTIVE` — funding never moved | Release it (V03) | Immediate: `reserved` falls |
| `CONSUMED` — funding moved | Request a repayment (Y01) | **None, until the repayment confirms** |
| `RELEASED` / `EXPIRED` | Nothing is owed | None |

Two things about the `CONSUMED` row carry the weight.

It **must not** release the reservation. `INV-22` is explicit that a consumed
reservation has no release path, and the reason is arithmetic: the value has
already moved from `reserved` to `drawn`, so releasing would credit `reserved`
for value it no longer holds and the facility would be counted twice. Attempting
it is a typed error at three layers — the domain returns
`consumed_cannot_be_released`, the service refuses, and the database trigger
rejects it even from raw SQL.

And the repayment **does not** restore capacity when it is created. `INV-46`:
`drawn` falls on a `CONFIRMED` repayment and on nothing else. Between the
cancellation and the provider's confirmation, the customer's *Available to
settle* stays reduced — correctly, because the money is genuinely still out. The
frozen `PRODUCT.md` (Revision 5) says where to explain that: on the affected
settlement, as one line, not as a fifth Overview metric.

**Commercial policy: EXTERNAL.** Whether post-funding cancellation is always
permitted, fee-bearing, or rate-limited is not decided here, and Stage 4 invents
no fee, no rate limit and no cooling-off period. The mechanism above is what
happens *given* that a cancellation has been permitted; the permitting is a
policy layer above it.

## What was deliberately not decided

- No cancellation fee, of any amount or shape.
- No rate limit on reserve-then-cancel, and no threshold at which a workspace is
  throttled. The abuse the register worries about — a workspace tying up
  availability by repeatedly reserving and cancelling — is real, but the
  countermeasure is a commercial and trust decision, and picking a number now
  would be inventing a policy rather than implementing one.
- No answer to whether the customer is charged for the FX movement across the
  reversal. That is adjacent to `D-17` and belongs with it.

What Stage 4 *does* provide is the observability the policy will need: every
cancellation after funding creates a `CANCELLATION_AFTER_DRAWDOWN` repayment
against a named settlement, so the rate and the cost of this behaviour are
measurable before anyone has to price it.

## Consequences

- A policy decision later is a new layer, not a rewrite: the mechanical
  consequence is already correct and tested.
- Operations can see money in flight back to the facility (`repayment_in_flight`)
  and can tell it apart from capacity, which is the distinction `INV-46` exists
  to protect.
- If the answer turns out to be "fee-bearing", the fee is a quote-time
  disclosure and lands under `D-09b`, which is already the home for commercial
  fee parameters.

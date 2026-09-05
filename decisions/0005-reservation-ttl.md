# ADR 0005 — Reservation TTL: mechanism closed, duration external (D-05)

Status: **Accepted** · 2026-09-03 · Implemented in Stage 4

## Why this lives here and not in `docs/`

Stage 0 Revision 6 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

`D-05` asks for the liquidity reservation TTL, with the register's own summary
of the tension: *"Too short strands settlements; too long strands liquidity."*

Both failure modes are real and they pull in opposite directions. A TTL shorter
than the drawdown round-trip expires reservations for settlements that were
about to fund, so a customer's settlement fails for a reason that has nothing to
do with them. A TTL longer than necessary holds capacity against settlements
that have quietly stopped progressing, so a workspace with a healthy facility
cannot settle.

The right number depends on facts nobody has yet: what the drawdown round-trip
actually takes with the first liquidity partner, at what percentile, and how
often it stalls rather than fails.

## Decision — split

**Technical invariant: CLOSED.** The TTL mechanism is built and enforced.

- Every reservation carries an explicit `expires_at`, set at creation from a
  caller-supplied duration. It is `NOT NULL`: a reservation without an expiry is
  unrepresentable, so "we forgot to set one" cannot happen.
- Expiry is V04 in the frozen table, driven by the reservation sweeper, and it
  drives T28 on the settlement. It releases the reservation and returns the
  capacity through the same balanced ledger movement a cancellation uses.
- Expiry is idempotent with release (`INV-22`), so a reservation that expires
  while a cancellation is in flight is released exactly once.
- **A `CONSUMED` reservation never expires.** The sweeper's index covers only
  `status = 'ACTIVE'`, and the trigger refuses the transition regardless. A
  drawdown that confirmed a moment before the TTL elapsed must not have its
  funding released.

**Commercial and operational parameter: EXTERNAL.** The duration is supplied as
configuration and is not compiled in anywhere. `reserveLiquidity` takes
`ttlSeconds` as a required argument with **no default**, and rejects a
non-positive value. There is deliberately no fallback: a default would become
the answer by accident, and the first person to notice would be a customer whose
settlement expired.

The sandbox value used in tests is stated at the test's top, as a test fixture,
in the same way the sandbox pricing configuration is labelled.

## What was deliberately not decided

No duration. Not "15 minutes because that seems reasonable", not a value copied
from another payments system with a different funding leg. `D-05` remains open
on the number, to be set from observed drawdown latency with the first real
partner.

## Consequences

- Choosing the number later is a configuration change, not a code change.
- A wrong number is visible rather than silent: expired reservations open T28
  with `FACILITY_SUSPENDED`/`LIQUIDITY_UNAVAILABLE`-class exceptions that
  operations sees, and the rate of them is the signal that the TTL is wrong.
- If the first partner's drawdown latency turns out to be bimodal — usually
  seconds, occasionally minutes — the answer may be a per-rail TTL rather than
  one number. Nothing here forecloses that: the duration is already an argument
  rather than a constant.

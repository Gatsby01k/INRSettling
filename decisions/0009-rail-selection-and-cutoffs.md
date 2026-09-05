# ADR 0009 — Rail selection is ours; cut-offs and windows are the provider's (D-13)

Status: **Accepted** · 2026-09-03 · Implemented in Stage 5

## Why this lives here and not in `docs/`

Stage 0 Revision 7 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

`D-13` asks for cut-off times, banking holidays and rail windows, and the
register says why they matter: *"`estimated_delivery` must be honest. 'Under 30
minutes' at 2am on a bank holiday is a broken promise."*

Stage 5 has to select a rail before it can submit anything — T15's guard is
`rail_selected`. So the question could not be deferred entirely. What could be
deferred, and was, is every number.

## Decision — split

**Technical mechanism: CLOSED.**

- The customer never chooses a rail and never sees one. `PRODUCT.md § 8`:
  *"picks a beneficiary, not NEFT or IMPS. The `payouts` module selects the
  rail."*
- `selectRail` is a pure function over the provider's **declared capabilities**:
  which rails it offers, each rail's minimum and maximum, which destination
  kinds it can pay, whether it is open right now, and how long it expects a
  terminal status to take.
- Among rails that can carry the payment, the fastest is preferred
  (`UPI → IMPS → RTGS → NEFT`). That ordering is a fact about the rails
  themselves rather than about any commercial arrangement, which is why it is
  safe to state in code.
- Three distinct refusals, because they need different responses: no rail serves
  this destination kind, no rail's limits fit this amount, and every rail that
  fits is currently closed. The third will resolve by waiting and the first two
  will not — telling operations "everything is shut" is a different problem from
  "this payment cannot be made".

**Provider-operational parameters: EXTERNAL.**

Every number comes from the provider, at runtime, through `capabilities()`:

| Parameter | Where it comes from |
|---|---|
| Which rails are available | `PayoutCapabilities.rails` |
| Per-rail minimum and maximum | `RailCapability.minMinor` / `maxMinor` |
| Whether a rail is open right now | `RailCapability.open` |
| Terminal-status SLA per rail | `RailCapability.terminalStatusSlaSeconds` |

Cut-off times and banking holidays enter as the `open` flag rather than as a
calendar this codebase maintains. That is deliberate: a partner that knows its
own windows can answer the question directly, and **a partner that cannot answer
it is telling us something we need to know before we promise a delivery
estimate.** Reimplementing the Indian banking calendar here would hide that
signal behind our own guess.

## What was deliberately not decided

- No cut-off times, no holiday calendar, no per-rail windows.
- No `estimated_delivery` copy. The register's concern is that the estimate must
  be honest, and an honest estimate needs the numbers above. Stage 5 shows no
  delivery estimate to a customer at all rather than showing one it cannot
  support.
- The one figure with a real-world referent — the ₹2,00,000 RTGS floor — is
  still *declared by the simulator* rather than asserted by the domain, so a
  partner with different terms needs no code change.

The sandbox capability values in `SANDBOX_RAIL_CAPABILITIES` are labelled as
fixtures in their own comment, the same discipline as the sandbox pricing
configuration and the preflight rule sets.

## Consequences

- The SLA that drives the T18 sweeper is stored **on the attempt at dispatch**,
  not looked up later. A provider may change what it declares, and an attempt
  should be judged against the SLA it actually went out under.
- Choosing rails better later — by cost, by success rate, by time of day — is a
  change to one pure function with a declared input, not a change to the
  execution path.
- `D-13` remains open on the numbers, and is needed by Stage 5 in the register's
  terms only in the sense that the *mechanism* had to exist. The numbers are
  needed before a customer is shown a delivery estimate, which is Stage 8 at the
  earliest and Stage 11 in practice.

# ADR 0011 — The return observation window is triage, and its duration is the partner's (D-04)

Status: **Split** · 2026-09-03 · Implemented in Stage 6

## Why this lives here and not in `docs/`

Stage 0 Revision 7 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

`D-04` arrives at Stage 6 already half-answered, and the register is unusually
firm about which half:

> *"**Role is settled and not open** (`STATE_MACHINES.md § 8.6`). This window is
> return-triage policy, not a finality concept … What remains open is the
> **duration per rail**, to be confirmed with the payout partner."*

`§ 8.6` also records why the name changed: *"'Finality hold window' implies
`SETTLED` is provisional until the window elapses … There is not."*

## Decision — split

**Technical mechanism: CLOSED.**

- `triageReturnArrival` is a pure function taking a credit time, a return time
  and a window, answering one question: ordinary or anomalous. It has no other
  outputs and no other callers.
- Within the window, a return takes `N02` on an authoritative check. Outside it,
  the return still **opens** — `N01` always produces `OBSERVED` — and is then
  escalated by `N04` in the same commit. A late return is never dropped; it is
  routed to a human, because *"a return this late means the provider's own
  reporting is in question."*
- The window a return was judged against is **stored on the return**
  (`window_seconds_at_open`, `arrival_elapsed_seconds`, `arrived_within_window`).
  Since the duration is open, a return judged under today's window must not be
  silently re-read under tomorrow's.
- The triage function is unreachable from finality, structurally rather than by
  convention: `FinalityEvidence` has no field a duration could arrive in, and
  `evaluateFinality` has no clock to read one from. A test asserts both, and
  `scripts/check-finality-integrity.mjs` fails the build if a duration is ever
  attached to a settled settlement in any file, in prose or in an identifier.

**Duration per rail: EXTERNAL.**

No number appears anywhere in the codebase. `windowSeconds` is a required input
with a legitimate `null`, and `null` means *"the partner has not supplied one"* —
which makes every arrival ordinary rather than applying an invented threshold.

That default direction is deliberate and is the safer of the two. An invented
window that is too short sends real, ordinary returns to `MANUAL_REVIEW` on the
strength of a number nobody agreed; a `null` window means we triage nothing until
we can triage it correctly, and every return still gets its authoritative check.

## What was deliberately not decided

- No duration, per rail or otherwise.
- No customer-facing exposure of a return-risk timestamp. `§ 8.6` says this *"is
  not a V1 question and is not carried as an open decision"*, and Stage 6 shows
  the customer nothing of the kind — the return notice carries the return's own
  state, amount, reason and date, and no window at all.

## Consequences

- `D-04` remains open on the duration, needed before the first real payout
  partner goes live (Stage 11), and needed by nothing before then.
- Supplying it is a configuration change, not a code change.

# ADR 0008 — Register housekeeping queued for the next baseline amendment

Status: **Applied at Revision 7** · 2026-09-03 · Documentation only

## What this is

A holding record for four register corrections that were **decided but not yet
folded into the frozen documents**. Revision 6 did this for `D-03`, `D-08` and
`D-09`; these were the next batch, written down so the amendment would be a
transcription rather than an act of recall.

**All of it is now in the baseline at Revision 7**, including the fifth item
below, which became `D-18`. This file stays as the working record of what was
decided and why; the register is the normative statement.

No code changes and no redesign followed from any of them. Each was already
implemented and tested; the register simply did not say so.

## 1. `D-07` — close it

**Register text before Revision 7:** *"Is separation of duties (creator ≠ authorizer)
default-on for all workspaces, or configurable?"* — listed as needed by Stage 1
and still shown as open.

**The adopted policy, decided at Stage 0 sign-off and implemented in Stage 1:**
separation of duties is **configurable per workspace**, defaulting **off in
Sandbox and on in Live**. Every policy change is separately audited, the creator
may not be the authorizer where it is enabled, and the capability remains
`settlement:authorize`.

Implemented in `security-policy.service.ts` and enforced at T08; proved by the
*"separation of duties at T08 — Stage 1 policy, unchanged"* block in
`settlement-lifecycle.test.ts`.

Register action: strike through, mark **CLOSED**, `| *closed* |`. ✅ *Applied at
Revision 7, together with the matching correction to `SECURITY.md § 3.2`, which
had carried the open question in its own words.*

## 2. `D-11` — keep it open

**Explicitly not closed.** Beneficiary verification method for V1 — penny drop,
provider lookup, or both — remains open pending real verification-provider
evidence, exactly as Stage 2 left it.

What exists is the *port* (`BeneficiaryVerificationProvider`) that all three
candidate answers satisfy without a domain rewrite, a deterministic sandbox
adapter, and a versioned `NameMatchPolicySet` so no threshold is compiled in.
See `decisions/0003-verification-abstraction.md`.

Register action: **none**, beyond saying so out loud. ✅ *Applied at Revision 7:
the register row now states that it is deliberately open, what was built
instead, and that it should not be closed by tidying — because the risk to an
open decision that already has an abstraction around it is that someone reads
the abstraction as the answer.*

## 3. `D-05` — record the split

Reservation TTL, per `decisions/0005-reservation-ttl.md`:

- **Technical mechanism: CLOSED.** `expires_at` is `NOT NULL`; V04 expiry drives
  T28; expiry is idempotent with release; a `CONSUMED` reservation never
  expires.
- **TTL duration: EXTERNAL**, pending observed drawdown latency with the first
  real partner. `reserveLiquidity` takes `ttlSeconds` with no default and
  rejects a non-positive value.

Register action: split into `D-05a` (closed) and `D-05b` (external), following
the `D-08`/`D-09` shape. ✅ *Applied at Revision 7.*

## 4. `D-16` — record the split

Post-funding cancellation, per `decisions/0006-post-funding-cancellation.md`:

- **Compensation mechanism: CLOSED.** Decided by where the money got to:
  `ACTIVE` → release; `CONSUMED` → request a repayment that restores nothing
  until it confirms; released/expired → nothing owed.
- **Commercial policy: EXTERNAL.** Whether it is always allowed, fee-bearing or
  rate-limited. No fee, rate limit or cooling-off period is invented.

Register action: split into `D-16a` (closed) and `D-16b` (external). ✅ *Applied
at Revision 7, together with the `SECURITY.md § 3.2` sentence on post-funding
cancellation monitoring, which now points at `D-16b` rather than at `D-16`
whole.*

## A fifth item, noted rather than decided — now `D-18`

Stage 4's drawdown evidence matching **fails closed on a partial drawdown**: a
provider that funds less than requested produces `amount_mismatch`, no
reservation consumption and no ledger movement, and the settlement stays in
`DRAWDOWN_REQUESTED` rather than being marked confirmed.

That is the safe behaviour and it needs no decision to be correct. What has *no*
owner yet is the operational question of what should then happen — retry, top
up, fail the settlement, or escalate to an operator — and whether a partial
funding leg should carry a fee or a commercial consequence.

This is adjacent to `D-14` (partial credit at payout, Stage 6) but is not the
same question: `D-14` is about value that reached the beneficiary, this is about
value that never left the facility.

✅ *Applied at Revision 7 as `D-18`, taking the next available number.* The
register records the invariant as closed and the production response policy as
external and **required before Stage 11** — the first real provider integration,
and therefore the first moment a partial drawdown can actually happen. No retry,
top-up or failure economics is written down, because none has been decided.
Recording it as a numbered entry is what keeps "nobody decided this" visible,
rather than leaving it to be inferred later from a refusal nobody can explain.

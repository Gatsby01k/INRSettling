# ADR 0001 — Separation of duties is configurable per workspace (D-007)

Status: **Accepted** · 2026-08-31 · Implemented in Stage 1

## Why this lives here and not in `docs/`

Stage 0 Revision 3 is frozen with a SHA-256 manifest in the README. Recording a
decision by editing a frozen document would invalidate the signed baseline, so
decisions taken after the freeze live in `decisions/` and are folded into the
register at the next revision.

## Decision

Separation of duties — the rule that the principal which created a settlement
cannot authorize it — is **configurable per workspace and per environment**.

- **Sandbox: OFF by default.** A single developer can exercise the whole flow.
- **Live: ON by default.** Money does not move on one principal's say-so.
- A workspace admin may explicitly disable it for live.
- Every policy change is a separate audited security action.
- The rule applies consistently to human and API principals.
- `settlement:authorize` remains the capability. This is a workspace policy
  layered on top of RBAC, not a second role model.

## How it is built

`workspace_security_policies (workspace_id, environment, separation_of_duties_enabled)`.
An absent row means the environment default, never "off" — a workspace that has
never touched the setting gets the safe value in live.

`evaluateSeparationOfDuties()` is pure: it takes the two principals and the
policy and returns a decision that explains itself. It knows nothing about
settlements. Stage 3 wires it into the authorize transition (T08), where it can
only ever narrow a capability decision RBAC has already made.

Principal identity is `(type, id)`. A user and an API key are different
principals; two API keys are different principals.

`setSeparationOfDuties()` requires `security_policy:manage`, and writes the
change, one audit record and one domain event in a single transaction.

## Interpretation applied, for review

"A workspace admin may explicitly disable it for Live" is implemented as
*explicitly*: turning it off in live requires `confirmLiveDowngrade: true` and a
non-empty `reason`. Turning it **on** needs neither. This is the one change that
widens what a single compromised principal can do, so it is the one that should
take two deliberate steps. If that friction is unwanted, remove the two guards
in `security-policy.ts` — the audit record is unaffected either way.

## The API-key question, closed

An earlier draft compared principal identity alone. That left a real hole: a
human who both uses the UI and holds an API key could create a settlement as
`user:U` and approve it as `api_key:K` — two distinct principals to the check,
one person in reality.

The rule is now about *people*, not just about distinctness:

| Policy | Authorizer | Outcome |
|---|---|---|
| OFF | API key with `settlement:authorize` | **permitted** |
| OFF | the human who created it | permitted |
| ON | any API key, job or provider | **refused** — `human_approver_required` |
| ON | the human who created it | refused — `separation_of_duties` |
| ON | a different permitted human | permitted |
| ON | a human, on an API-created settlement | permitted |

Two consequences worth stating plainly.

**Unattended operation still exists**, and it lives where it belongs: behind the
explicit live downgrade in `setSeparationOfDuties`, which is audited, needs a
stated reason and a confirmation. A workspace that wants a key to approve turns
separation of duties off and says so. It does not get there by holding a second
credential that happens to count as a different principal.

**The refusal names the two real routes** — ask an approver, or have an admin
turn the policy off — rather than describing the check that fired. Copy that
explains the mechanism instead of the fix is how customers end up inventing the
workaround we just closed.

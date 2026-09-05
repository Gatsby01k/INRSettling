# ADR 0003 — Verification is a port with no live adapter (D-11)

Status: **Accepted** · 2026-09-02 · Implemented in Stage 2

## Why this lives here and not in `docs/`

Stage 0 Revision 3 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

`D-11` — whether V1 verifies a beneficiary by penny drop, by provider lookup, or
by both with a fallback, and who bears the cost and latency — is **open**. It is
a commercial and UX decision that depends on what the first payout partner
offers, charges and takes.

Stage 2 must ship a working verification flow anyway.

## Decision

Verification is expressed as a single port, `BeneficiaryVerificationProvider`,
which all three candidate answers satisfy without a domain rewrite:

- a synchronous lookup returns `verified` or `failed` immediately;
- a penny drop returns `verifying` with a `providerReference` and resolves later
  through `interpret()` and a callback;
- a both-then-fall-back adapter composes the two behind the same interface.

`method` is recorded per verification, so the decision is observable in data
rather than assumed in code.

**Sandbox resolves to a deterministic simulator. Live resolves to nothing and
refuses.** `verificationProviderFor('live')` throws
`NoVerificationProviderError` rather than substituting the simulator, because a
simulated verification in live would be a claim that money can be delivered when
nothing checked.

**Product language is method-neutral.** Customers see "Verify beneficiary",
"Verifying", "Verified", "Could not verify". *Penny drop*, *provider lookup*,
*provider* and *name match score* appear in no customer-facing string, and a UI
test asserts it. Whichever way `D-11` lands, the copy does not change.

## Integrity rules that do not depend on D-11

These hold for any adapter, and are enforced in `verification.service.ts`:

- A result may only be applied to the **destination version** it was requested
  for. The provider is not trusted to get this right and is not asked to; a
  callback naming a different version is refused and the refusal is audited.
- A redelivered callback is a no-op, keyed on `(provider_id, provider_event_id)`.
- The raw payload is persisted before interpretation (`INV-33`), and
  interpretation never throws (`INV-43`).
- A refusal that records something returns rather than throwing, so the audit
  row recording it survives the transaction.
- The domain's name-match floor overrides the provider's verdict: a result
  reported as verified below `NAME_MATCH_THRESHOLD` is recorded as
  `name_mismatch`. A partner's threshold is a commercial setting; ours is an
  invariant.

## What closes D-11

Pricing and latency evidence from the first payout partner, plus a decision on
whether a roughly one-minute penny drop is acceptable inside the New Settlement
flow or must move to a background step. The `verifying` outcome and the callback
path already implement the asynchronous answer.

## Open sub-decision, flagged

`NAME_MATCH_THRESHOLD = 80` is a placeholder with no evidence behind it, and it
interacts with `D-11`: a penny drop and a registry lookup return
differently-shaped name data. The domain enforces that a floor exists and that a
provider cannot report a pass below it. The number itself should be revisited
against real match-score distributions from the first partner.

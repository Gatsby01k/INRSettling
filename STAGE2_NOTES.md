# Stage 2 — Beneficiaries, destination versions, verification, preflight

Built against the frozen Revision 3 baseline (with the R4 accessibility and R5
product amendments). All eight `docs/` digests in `README.md` verify unchanged;
nothing in this stage amended the signed baseline.

Stage 2 scope was: `Beneficiary`, `PayoutDestination` + immutable
`PayoutDestinationVersion`, the verification abstraction, a deterministic
sandbox verification provider, and the preflight requirement engine. Quotes,
settlement execution, the state machine, liquidity, payout execution,
reconciliation, receipts, batches and real provider integrations are **not**
implemented, and nothing here reaches into them.

---

## 1. Domain and schema

### Migration `0004_beneficiaries.sql`

Five tenant tables and two global reference tables.

| Table | Tenant-scoped | Notes |
|---|---|---|
| `beneficiaries` | yes | identity only; PAN encrypted, last 4 in clear |
| `payout_destinations` | yes | stable handle; carries **no** payout details |
| `payout_destination_versions` | yes | append-only, trigger-enforced |
| `destination_verifications` | yes | keyed to a **version**, never a destination |
| `provider_events` | yes | raw payloads, stored before interpretation |
| `preflight_rule_sets` | no — global | versioned reference data (`D-06`) |
| `purpose_codes` | no — global | versioned reference data (`D-06`) |

The two reference tables are the only additions to the RLS gate's exception set,
each with a recorded reason and `required: false`. They hold no tenant data, are
identical for every workspace, and are `SELECT`-only to `inrsettle_app`.

`DELETE` is granted on **nothing** this migration creates. A beneficiary or
destination is disabled, never removed: Stage 3 binds a settlement to a
destination version, and history that money moved against must not be deletable
out from under it.

### Domain modules (`packages/domain`)

Pure — no ORM, no database, no framework. Only `node:crypto`, `@inrsettle/money`
and `@inrsettle/contracts`.

```
beneficiaries/beneficiary.ts        identity validation, derived status
beneficiaries/destination.ts        details, normalisation, content hash, masking
beneficiaries/verification-port.ts  the BeneficiaryVerificationProvider port
preflight/requirement.ts            the four-field Requirement and its inspector
preflight/rules.ts                  condition language, policy rules, evaluator
preflight/rule-set-io.ts            parse / serialise / checksum reference data
```

### Identifier prefixes registered

`ben_` beneficiary · `dst_` payout destination · `dvr_` destination version ·
`dvf_` verification · `pev_` provider event · `pfr_` preflight run.

---

## 2. Destination-version invariants

**A destination id is a handle the customer owns. A destination *version* is the
immutable thing money is sent to.** Everything else follows from that.

- **`INV-44` — versions are append-only.** Enforced by a `BEFORE UPDATE` trigger
  that raises `restrict_violation` if any payout detail changes, plus the
  absence of a `DELETE` grant. `superseded_at` is the one writable field, and it
  is write-once. Proved by `packages/app/src/__tests__/beneficiaries.test.ts`
  ("the database refuses to mutate a version even if application code tries").

- **Editing appends.** `editPayoutDestination` inserts a new version at
  `version_number + 1`, stamps `superseded_at` on the previous one, and moves
  `current_version_id`. The new version starts `UNVERIFIED` —
  `INITIAL_VERSION_VERIFICATION` is a constant, not a default a call site can
  override.

- **A no-op save creates nothing.** `details_fingerprint` is an **HMAC-SHA256**
  over `version | workspace | environment | canonical details`, under a secret
  held outside the database. Identical details in the same tenant scope
  fingerprint identically, so opening the edit form and pressing save cannot
  silently un-verify a working destination.

  It is keyed rather than a plain digest because a bank account is a small,
  structured input space — an IFSC from a published list plus a bounded run of
  digits. An unkeyed SHA-256 sitting beside the ciphertext would be enumerable
  offline in seconds, which would undo `INV-12` without touching the encryption.
  Scoping by workspace and environment also stops the column revealing that two
  tenants pay the same beneficiary. The value is opaque: it is in no DTO, no
  event, no audit record and no log, and tests assert each.

- **Normalisation and validation agree by construction.** Both run on
  `normalisePayoutDetails`. This was a real defect found in testing: a lowercase
  IFSC hashed as identical but was rejected by the validator, so a customer
  could be refused for typing something we would have stored unchanged.

- **`INV-45` — verification belongs to a version.** `destination_verifications`
  references `destination_version_id`; there is no path from a verification to a
  destination that does not go through a version.

- **History survives.** A superseded version keeps its own verification status,
  `verified_at` and name-match decision. It is never retroactively invalidated.

- **Kind is immutable per destination.** A bank account cannot become a UPI ID
  under the same id — that would let a verified destination become an unrelated
  one under an identifier a settlement may already reference. Add a separate
  destination instead.

- **Ready for Stage 3.** `INV-11` needs "a settlement is authorized against one
  exact verified version". The read model already exposes the version id, the
  verification is keyed to it, and `current_version_id` is deliberately *not*
  what a settlement should bind to.

---

## 3. Verification provider contract

### The port (`packages/domain/src/beneficiaries/verification-port.ts`)

```ts
interface BeneficiaryVerificationProvider {
  readonly id: string
  readonly method: 'penny_drop' | 'provider_lookup' | 'manual'
  supports(kind: DestinationKind): boolean
  verify(request: VerificationRequest): Promise<VerificationOutcome>
  interpret?(raw: unknown): VerificationCallback | null
}
```

`VerificationRequest` names a `destinationVersionId` and carries a `requestId`
that is the idempotency key. `VerificationOutcome` is `account_confirmed` |
`failed` | `verifying`. Failure codes are a **closed** taxonomy; an unrecognised
provider code maps to `unavailable` rather than throwing (`INV-43`).

The outcome is `account_confirmed`, not `verified`, and the distinction is the
point: a provider confirms the **account**; the versioned name-match policy
decides the **name**. A provider reporting a confirmation with evidence its
policy rejects does not produce a verified destination.

**`D-11` is not answered by this file.** Whether V1 verifies by penny drop, by
provider lookup, or by both — and who bears the cost and latency — remains open.
What is settled is the shape of the question, and all three answers satisfy this
interface without a domain rewrite. No real provider and no PayMate reference
appears anywhere in the codebase.

**Product language.** Customers see "Verify beneficiary", "Verifying",
"Verified", "Could not verify". The words *penny drop*, *provider lookup*,
*provider* and *name match score* appear in no customer-facing string; a UI test
asserts this.

### Sandbox simulator (`packages/providers`)

No randomness, no clock, no network. The scenario is a pure function of the
payout details: the **last two digits** of a bank account number, or the handle
prefix of a VPA.

| Suffix | VPA prefix | Scenario |
|---|---|---|
| `01` | `notfound` | account not found |
| `02` | — | account closed |
| `03` | — | account frozen |
| `04` | `mismatch` | confirmed, but the registry name is a different person |
| `05` | — | invalid IFSC |
| `06` | — | rejected by bank |
| `07` | `pending` | accepted, resolves by callback |
| `08` | — | provider returns a code we have never seen (`INV-43`) |
| `09` | — | confirmed, partial name evidence |
| `10` | — | confirmed, rail returned no name |
| — | `unknown` | VPA not registered |
| anything else | — | confirmed, exact name evidence |

The same request always produces the same outcome, and two provider instances
agree. The pending scenario's `providerReference` is derived from the request
id, so a retry correlates to the same check.

**Live has no adapter and refuses rather than substituting the simulator.**
`verificationProviderFor('live')` throws `NoVerificationProviderError`. A
simulated verification in live would be a lie about whether money can be
delivered.

### Callback integrity

`ingestVerificationCallback` does three things in a fixed order:

1. **Persist verbatim first** (`INV-33`), under a unique
   `(provider_id, provider_event_id)`. A redelivery is a no-op.
2. **Interpret** — never throws; an unreadable payload stays stored and inert.
3. **Apply only to the version that was asked about.** The verification row
   records the version; a callback naming any other version is refused and the
   refusal is audited.

Every refusal **returns** rather than throwing, because throwing would roll back
the audit row that records the refusal. That rule was learned in Stage 1 and is
applied here from the start.

**Untrusted evidence is stored and never applied.** `signatureValid` gates state
change: a payload that did not authenticate is persisted verbatim and audited —
an unsigned callback is itself evidence worth keeping — but it can never move a
version to VERIFIED. The gate sits *before* interpretation, so an
unauthenticated payload does not even influence which verification row is read.
Anything else would make "verified" mean "somebody posted to our webhook".

The provider's own verdict is not the last word on the name either: the
versioned name-match policy decides, and it fails closed.

### The callback scope bridge

A webhook arrives with no tenant context but must write RLS-scoped tables.
`resolve_verification_scope(text)` is `SECURITY DEFINER`, returns only
`(workspace_id, environment)` for one verification id, is granted to
`inrsettle_app` alone, and cannot enumerate. The alternative — a global raw
event table outside RLS — would have put provider payloads containing account
data outside tenant isolation entirely. This is the smaller hole and it is
auditable in one place.

---

## 4. Preflight rule and versioning model

### Two kinds of rule, and the distinction is not stylistic

**Policy rules** are compiled into `packages/domain/src/preflight/rules.ts`.
They restate closed decisions and frozen invariants and are deliberately not
configurable, because changing one would change the domain:

| Code | Fires when |
|---|---|
| `payout_destination_required` | the beneficiary has no usable destination |
| `beneficiary_account_unverified` | the current version has never been checked |
| `beneficiary_account_verification_failed` | a check ran and did not pass |
| `beneficiary_verification_in_progress` | a check is running |
| `beneficiary_rejected` | an operator rejected the beneficiary |
| `beneficiary_disabled` | someone in the workspace disabled it |
| `purpose_required` | no purpose chosen |
| `liquidity_facility_required` | **live** and no active facility (`D-10`, closed) |

`liquidity_facility_required` is raised from a single boolean fact. No facility,
balance, drawdown or repayment is modelled — liquidity itself is Stage 4.

**Reference rules are data.** Everything depending on the RBI/AD-bank
purpose-code taxonomy and its document rules (`D-06`, open) is loaded from
`reference/preflight/*.json` into `preflight_rule_sets`, carrying its own
`source`: `sandbox_fixture` | `ad_bank` | `provider`. Nothing in the domain
asserts what the AD bank requires.

### Guards that keep `D-06` visibly open

The shipped fixture says on its face that it is not regulatory truth, and three
independent layers stop a simulator assumption becoming a production rule:

1. The **parser** rejects a `sandbox_fixture` rule set whose purpose codes carry
   a `regulatory_code`.
2. The **table constraint** `sandbox_fixture_has_no_regulatory_code` rejects the
   same thing at the database, even for a hand-written insert.
3. The **CI gate** `scripts/check-requirement-copy.mjs` rejects it at build time.

`activeRuleSetVersion` prefers an `ad_bank` or `provider` set over a sandbox
fixture and, for **live**, will not fall back to a fixture at all. The day
`D-06` is answered, live stops using the simulator's rules without any
application change.

### Determinism

`runPreflight(subject, ruleSet)` is pure and total. The subject is a value with
a closed fact set — a rule cannot reach past it into the database, a clock or a
provider, which makes determinism a property of the type rather than a promise.

Output is normalised by `sortRequirements` (blocking before advisory, then by
code), so evaluation order cannot leak into the result — asserted by running the
rule set in reverse and comparing.

Every outcome carries `ruleSetVersion`, `ruleSetSource`, `engineVersion` and a
`fingerprint` over the rendered requirements. `PREFLIGHT_ENGINE_VERSION` is
bumped whenever evaluation semantics change, so a re-run after an engine change
is explainable rather than mysterious.

A published rule-set version is immutable: re-loading a changed file under the
same version is an error, not a silent overwrite, and reading one back
re-parses and re-checksums rather than trusting the row.

### The four-field requirement

```ts
interface Requirement {
  code: string                    // stable machine code
  severity: 'blocking' | 'advisory'
  title: string                   // one line, states the missing thing
  detail: string                  // one sentence of context
  action: RequirementAction       // one named action, closed union
}
```

The action union is closed so the interface can render a real button for every
requirement it is ever handed. Ids in actions are bound by the evaluator from
the subject, so a rule can never name a beneficiary that is not the one being
checked. Copy may interpolate only four tokens (`amount`, `beneficiary_name`,
`destination_summary`, `purpose_label`); an unknown token is a build failure.

---

## 5. UI surfaces

`packages/ui` gained three of the frozen `DESIGN_SYSTEM.md § 5` domain
components — and only three, the ones these surfaces need:

- **`StatusIndicator`** — dot plus label, the single source of status rendering.
  The dot is `aria-hidden`; status is never encoded in colour alone.
- **`RequirementCard`** — "title, detail, one action button. Cannot render
  without all three", enforced by the type: all three props are required.
- **`BeneficiaryPicker`** — search-first combobox showing the masked destination
  summary and verification state inline.

`AmountDisplay`, `SettlementProgress`, `QuoteSummary`, `Reference`, `EventRow`,
`ReceiptDocument` and `MetricTile` remain deferred; the scope test's deferred
list was narrowed from `STAGE_2_PLUS` to `STAGE_3_PLUS` and still fails CI if
one is built early.

`apps/app/src/beneficiaries/` holds the five surfaces, presentational and
callback-driven so every state renders in Storybook and asserts in jsdom:

| Surface | States covered |
|---|---|
| Beneficiaries list | default, loading, empty, no-match, error |
| Beneficiary detail | verified, edited-needs-reverification, verifying, failed, no destination |
| Create beneficiary | empty, field errors, submitting |
| Edit payout destination | warns about re-verification, unchanged, never-verified |
| Preflight panel | ready, action required, action running, loading, ready-with-advice |

The edit screen states plainly what saving does, because the consequence is
real: a new version is created, it is unverified, and settlements cannot be
authorized against it until it is checked. Hiding that would let someone break
their own settlement flow by fixing a typo.

Tests assert the product rules, not the markup: no CRM vocabulary appears
anywhere on these screens, no aggregate "3 problems" count replaces an
explanation, and no full account number is renderable.

---

## 6. Security and integrity

- **Envelope encryption** (`packages/app/src/crypto/field-encryption.ts`).
  AES-256-GCM with a per-value data key wrapped by a KEK held outside the
  database. Ciphertext is bound by AAD to `(field, workspace, environment)`, so
  a ciphertext lifted from one row cannot be replayed into another — asserted by
  a test that tries.
- **No decrypt-for-display path exists.** `DestinationVersionView` has no
  account-number field. The only decryption function is not exported from the
  package barrel and its single caller hands the plaintext straight to a
  provider adapter.
- **Masking is proved, not asserted.** One test scans every `audit_log.before`,
  `audit_log.after` and `events.payload` in the database for the account-number
  prefix and requires zero matches.
- **RLS discovery is automatic.** The Stage 1 catalogue-driven gate picked up all
  five new tenant tables with no change; a test names them so the gate cannot
  pass vacuously.
- **Audit coverage.** Beneficiary creation, destination creation, every new
  destination version, every verification request, every verification outcome,
  and every rejected callback.

---

## 7. Stage 2 exit-criteria matrix

| Criterion | Status | Evidence |
|---|---|---|
| Every requirement has code/title/detail/action; CI rejects an incomplete rule | ✅ | `scripts/check-requirement-copy.mjs`; `scripts/__tests__/check-requirement-copy.test.ts` runs the real gate against broken fixture trees |
| No generic validation-failure copy anywhere | ✅ | same gate greps the whole tree; `docs/` exempt as the specification, elsewhere an explicit same-line marker is required |
| Editing payout details creates a new UNVERIFIED version | ✅ | `beneficiaries.test.ts` "INV-44 — editing appends a version and never mutates one" |
| Verification is demonstrably version-specific | ✅ | `beneficiaries.test.ts` "INV-45"; callback version-mismatch test |
| Preflight deterministic and versioned | ✅ | domain determinism suite + `preflight.test.ts` "deterministic and versioned across repeated runs" |
| RLS / audit / masking / environment isolation for every new table | ✅ | `isolation.test.ts` (17 tests, catalogue-driven) + `beneficiaries.test.ts` INV-12 and INV-31 blocks |
| Deterministic simulator scenarios reproducible, per destination kind | ✅ | `packages/providers/src/__tests__/sandbox.test.ts` (31 tests): bank + VPA, both reproducible |
| Name-match policy is versioned, sourced and fails closed | ✅ | `packages/domain/src/__tests__/name-match.test.ts` (34 tests); `80` only in `SANDBOX_NAME_MATCH_POLICIES` |
| Destination change detection is a private keyed fingerprint | ✅ | `packages/app/src/__tests__/destination-fingerprint.test.ts` (14 tests) |
| Untrusted callback evidence cannot verify | ✅ | `verification-trust.test.ts` "untrusted evidence cannot verify" |
| Bank/IFSC and VPA validation and verification | ✅ | `sandbox.test.ts` + `verification-trust.test.ts` "the UPI path end to end" |
| Full account details never reach DTOs, UI, events, audit or logs | ✅ | `packages/app/src/__tests__/leakage.test.ts` (20 tests) + `surfaces.test.tsx` INV-12 block |
| Clean CI from a fresh checkout | ✅ | see below |

---

## 8. Defects found and fixed during this stage

Recorded because each was a real bug, not a style preference.

1. **Stale compiled output shadowed the TypeScript.** A `tsc -b` run that
   violated a project's `rootDir` still emitted, writing `.js` and `.d.ts` files
   into `src`. Vitest resolves `./foo.js` to a real `foo.js` in preference to
   `foo.ts`, so the suite silently ran against stale compiled code and kept
   passing. Fixed the project references, and added
   `scripts/check-source-tree.mjs` as a hard CI gate — a green suite testing the
   wrong code is worse than a red one.

2. **`pnpm ci` is a reserved pnpm command.** The CI workflow's `run: pnpm ci`
   fails with `ERR_PNPM_CI_NOT_IMPLEMENTED` on pnpm 10. Only the clean-checkout
   run surfaced it. The script is now `verify`, invoked as `pnpm run verify`.

3. **The rule-set validator threw instead of reporting.** `validateRules` is the
   CI gate over data-loaded rule sets; a malformed rule crashed it rather than
   producing a defect. Made total.

4. **Normalisation and validation disagreed.** A lowercase IFSC hashed as
   identical to its uppercase form but was rejected by the validator — a
   customer would be refused for typing something we would have stored
   unchanged. Both now run on `normalisePayoutDetails`.

5. **The database round trip was asymmetric.** Rule sets were stored in the
   parsed camelCase shape and read back with a parser expecting the wire shape,
   and purpose-code row order changed the checksum. Added `toRuleSetJson` with a
   `parse(serialise(x)) === x` test, and canonicalised purpose-code order.

6. **A failed penny drop rejected the beneficiary.** `deriveBeneficiaryStatus`
   mapped any failed verification to `REJECTED`, which routed a customer with a
   mistyped IFSC to support instead of to the fix. `rejected` is now an explicit
   operator decision; a failed rail check leaves the beneficiary
   `pending_verification` and raises a requirement that names the edit.

---

## 9. Decisions that cannot be resolved without external evidence

Both stay **open**. Stage 2 implemented the abstractions that support either
answer without a domain rewrite, and neither blocked the sandbox build.

### `D-06` — regulatory purpose-code taxonomy and document rules

**What is unknown.** The RBI/FEMA purpose-code table applied by the authorised
dealer bank for inward remittance, and which documents are required at which
amount bands for which purposes.

**Why it cannot be settled here.** The exact table is provider- and AD-bank
specific. Writing one down would produce a system that looks compliant and is
not — the most expensive kind of wrong.

**What was built instead.** Rules and purpose codes are versioned reference
data with a recorded `source`. The shipped fixture is labelled
`sandbox_fixture`, carries no regulatory codes (enforced in three places), and
live refuses to fall back to it.

**What closes it.** A purpose-code table and document matrix from the first real
payout partner and its AD bank, loaded as an `ad_bank` rule set. No code change
is required to adopt it.

### `D-11` — beneficiary verification method for V1

**What is unknown.** Whether V1 verifies by penny drop, by provider lookup, or
by both with a fallback; and who bears the cost and the latency.

**Why it cannot be settled here.** It is a commercial and UX decision that
depends on what the first payout partner actually offers, what it charges, and
how long it takes. Choosing on our own would bake a guess into the New
Settlement flow.

**What was built instead.** One port, three admissible methods, and a registry
where adding a real adapter is a registration rather than a refactor. Product
copy is method-neutral throughout.

**What closes it.** Provider pricing and latency evidence, plus a decision on
whether a ~1-minute penny drop is acceptable inside the settlement flow or must
move to a background step. The `verifying` outcome and callback path already
support the asynchronous answer.

### Name matching — no longer a judgement call in the domain

An earlier revision carried `NAME_MATCH_THRESHOLD = 80` as a domain constant.
That was wrong in kind, not just in value: it asserted that every provider and
method reports name similarity on one comparable 0..100 scale, which cannot be
true before `D-11` is answered and is not true of a UPI lookup that returns no
name at all.

It has been replaced by a versioned, sourced `NameMatchPolicySet` keyed by
`(providerId, method)`, supporting all four shapes the evidence can take:

| Policy | When it applies |
|---|---|
| `not_required` | the method carries no name evidence; requires a stated reason |
| `provider_assertion` | the provider asserts pass/fail and we record its word |
| `numeric_score` | the provider scores, on a `scaleMax` the policy declares |
| `registry_name` | the provider returns a name and INRSettle matches it |

`80` survives **only** as `SANDBOX_NAME_MATCH_POLICIES` — explicitly labelled
simulator configuration whose own description says it is not a real provider
policy and that `D-11` is open.

Three properties are enforced and tested:

- **It fails closed.** Evidence a policy cannot use is `insufficient_evidence`,
  never a pass — including a score outside its declared scale, which is a
  configuration error rather than a number to guess at.
- **There is no default policy.** An unregistered `(provider, method)` pair
  returns `undefined` and cannot verify. A permissive fallback would apply rules
  nobody wrote; a fake unreachable threshold would be a policy pretending to be
  one.
- **Evidence does not substitute across kinds.** A provider score cannot satisfy
  a registry-name policy, and vice versa.

`compareNames` is INRSettle's own comparison for the `registry_name` case:
deterministic, token-set based, tolerant of middle initials, honorifics and
corporate suffixes. It is deliberately simple and explainable rather than a
fuzzy-matching library, and the real algorithm is chosen with a partner's data
in hand.

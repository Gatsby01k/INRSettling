# ADR 0002 — Preflight reference data is sourced, versioned and checksummed (D-06)

Status: **Accepted** · 2026-09-02 · Implemented in Stage 2

## Why this lives here and not in `docs/`

Stage 0 Revision 3 is frozen with a SHA-256 manifest in the README. Recording a
decision by editing a frozen document would invalidate the signed baseline, so
decisions taken after the freeze live in `decisions/` and are folded into the
register at the next revision.

## Context

`D-06` — the RBI/FEMA purpose-code taxonomy applied by the authorised dealer
bank, and the document rules per purpose and amount band — is **open**, and can
only be closed with evidence from the first real payout partner.

Stage 2 needs preflight to work end to end in sandbox. The obvious shortcut is
to write a plausible purpose-code table into the domain and move on. That
produces a system which *looks* compliant and is not, and the mistake is
invisible until a real settlement is rejected by a real bank.

## Decision

Preflight rules split in two, and the split is enforced rather than documented.

**Policy rules** are compiled into the domain. They restate closed decisions and
frozen invariants — `INV-11`, `INV-44`, `INV-45`, `D-10`. They are not
configurable, because changing one would change the domain.

**Reference rules are data.** Anything depending on `D-06` is loaded from
`reference/preflight/*.json` into `preflight_rule_sets`, carrying a `source` of
`sandbox_fixture`, `ad_bank` or `provider`, plus a SHA-256 checksum over its
canonical form.

Three consequences follow, and each is enforced in code:

1. **A `sandbox_fixture` may not carry a regulatory purpose code.** Rejected by
   the parser, by the `sandbox_fixture_has_no_regulatory_code` table constraint,
   and by the `check:requirement-copy` CI gate. Three layers because the failure
   mode — a guess quietly acquiring the authority of a database row — is silent.

2. **Live will not fall back to a sandbox fixture.** `activeRuleSetVersion`
   prefers `ad_bank` and `provider` sets and, for live, returns null rather than
   a fixture. Sandbox preflight running on invented rules is fine and labelled;
   live preflight running on them is not.

3. **A published version is immutable.** Re-loading a changed file under an
   existing version is an error, not an overwrite, and a rule set read back from
   the database is re-parsed and re-checksummed rather than trusted. A preflight
   outcome cites its `ruleSetVersion`, so it must stay explainable later.

## What closes D-06

A purpose-code table and document matrix obtained from the first payout partner
and its AD bank, loaded as a rule set with `source: 'ad_bank'`. No application
change is required to adopt it: live begins using it the moment it is present.

## Consequences

- The sandbox fixture is deliberately unsuitable for production and says so in
  its own `description`, which the tests assert.
- The engine carries a `PREFLIGHT_ENGINE_VERSION` alongside the rule-set version,
  so a change in evaluation semantics is distinguishable from a change in rules.
- Reference tables are global rather than tenant-scoped, and are the only two
  additions to the RLS gate's reviewed exception set. They are `SELECT`-only to
  the application role; loading runs as the migration credential.

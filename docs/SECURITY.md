# SECURITY.md

Status: **Stage 0 — Revision 7 · FROZEN 2026-09-03 · register cleanup (`D-07` closed; `D-16` split)**
Depends on: `DOMAIN.md`, `ARCHITECTURE.md`

This document covers security *and* financial integrity, because in this product
they are the same subject. A bug that lets a settlement change its amount is a
security incident, not a defect.

---

## 1. Threat model

What we are actually defending against, in priority order:

1. **Cross-tenant leakage** — workspace A seeing or affecting workspace B.
2. **Forged or replayed finality** — anything that makes a settlement look
   settled when the money did not arrive, or arrived differently.
3. **Duplicate payout** — a retry, a redelivered webhook or a double-click
   creating a second real credit in India.
4. **Over-allocation of the liquidity facility** — concurrent settlements
   drawing more than the facility can support.
5. **Silent mutation of financial history** — an operator, a migration or an
   admin script editing a settled record.
6. **Credential compromise** — API keys, provider credentials, webhook secrets.
7. **Beneficiary data exposure** — account numbers in logs, exports, events.

Out of scope for V1 as an engineering control, and named so it is not forgotten:
sanctions and AML screening depth, which is a compliance-programme question tied
to `D-02`, not something to invent in code.

## 2. Tenant isolation

**INV-31** is enforced in the database, not in application discipline.

- Every tenant-scoped table has `workspace_id` and `environment`, both `NOT
  NULL`, both in the primary composite indexes.
- Postgres **row-level security** is enabled and forced (`FORCE ROW LEVEL
  SECURITY`) on every such table.
- The application's database role does **not** have `BYPASSRLS`.
- The connection wrapper sets `app.workspace_id` and `app.environment` with `SET
  LOCAL` at the start of every transaction, from the authenticated principal —
  never from a request body, query parameter or header.
- A connection that has not set both variables can read nothing. The default
  policy denies.

Cross-tenant reads exist only in Internal Operations, only through an explicitly
named role, and every one is written to the audit log with the operator, the
workspace and the reason.

Test obligation: for every tenant-scoped table, an integration test that sets
workspace A's context and asserts zero rows of workspace B are visible to
`SELECT`, `UPDATE` and `DELETE`.

## 3. Identity and access

### 3.1 Human access

Session authentication for `app` and `ops`. Email identity with a second factor
that is **mandatory, not optional**, for every user in every workspace — TOTP at
minimum, WebAuthn preferred. There is no "remind me later".

Sessions are short, bound to a device fingerprint, revocable from settings, and
invalidated on role change. `ops` sessions are shorter still and additionally
network-restricted.

### 3.2 Roles

| Role | Can | Cannot |
|---|---|---|
| `viewer` | Read settlements, beneficiaries, batches, receipts | Create or change anything |
| `operator` | Create beneficiaries and settlements, run preflight, request quotes, import batches | **Authorize a settlement**, manage keys, change roles |
| `approver` | Everything `operator` can, plus `settlement:authorize` | Manage keys or roles |
| `admin` | Workspace settings, members, roles, API keys, webhook endpoints | Authorize (unless also `approver`); edit any financial record |
| `developer` | API keys, webhook endpoints, logs, replay in sandbox | Authorize; read beneficiary account numbers |

Internal (INRSettle staff) roles are entirely separate and never granted inside a
customer workspace: `ops_read`, `ops_resolve` (resolve exceptions, with reason),
`ops_liquidity` (facility limits, repayments), `ops_admin`. No internal role
includes a capability to set a settlement to `SETTLED` — that capability does not
exist for any principal (§6).

**Separation of duties:** creating a settlement and authorizing it are different
permissions, and a workspace may require them to be different people. `D-07` is
**closed**: this is **configurable per workspace, defaulting off in Sandbox and
on in Live**. Configurable because a one-person workspace cannot satisfy it and
would otherwise be locked out of its own product; on by default in Live because
that is where a compromised operator account has real blast radius, and a
default that has to be turned on is a default nobody turns on. Every change to
the setting is separately audited — the policy is itself a control, so relaxing
it must be as visible as using it.

`settlement:cancel` is a separate scope from `settlement:authorize`. Because
cancellation is possible after authorization but before the point of no return,
it is a real capability with financial effect — it can release reserved
liquidity and reverse a confirmed drawdown — and it is audited as such. Repeated
post-funding cancellation is monitored: a workspace that reserves and cancels in
a pattern is tying up facility availability, and ops is alerted rather than left
to notice. What that alert should *lead to* — a fee, a rate limit, or nothing —
is `D-16b`, still open; the monitoring exists regardless, and is what will make
the policy answerable from evidence rather than from guesswork.

### 3.3 API keys

- Format `sk_live_…` / `sk_test_…`, generated with a CSPRNG, shown exactly once.
- Stored as SHA-256 of the secret plus a short searchable prefix. The plaintext
  never touches the database, a log or an email.
- Bound to one workspace **and** one environment. A `sk_test_` key cannot address
  a live object, and the failure is `not_found`, never `forbidden` — a wrong-
  environment key must not confirm that an object exists.
- Scoped: a key carries a permission set, and `settlement:authorize` is a scope a
  key must be explicitly granted.
- Rotatable with an overlap window; revocation is immediate and global.
- Rate limited per key, with limits published in the API reference.

## 4. Webhook trust

### 4.1 Outbound, to customers

Signature header:

```
INRSettle-Signature: t=1756636800,v1=<hex hmac-sha256>
```

signed over `"{t}.{raw_body}"` with the endpoint's secret. Documented
verification snippets in the API reference, including the constant-time
comparison, because a customer who compares with `==` is a vulnerability we
introduced.

Rules published and enforced: **reject any timestamp outside a five-minute
tolerance in either direction** (`|now − t| > 300s`) — a stale timestamp is the
signature of a replay and must fail exactly as a future-dated one does; treat
`event.id` as an idempotency key; expect redelivery; never trust the payload's
`status` as the sole basis for releasing goods — re-read the settlement via the
API for anything irreversible.

Secrets are rotatable with dual-secret overlap so rotation never drops an event.

### 4.2 Inbound, from providers

This is the finality attack surface, and it is treated as hostile.

1. Read the **raw** body before any parsing.
2. Verify the signature against the provider's current key, constant-time.
3. Reject any timestamp outside tolerance in **either** direction — stale as
   well as future-dated. Stale is the common case and is what a replay looks
   like; the check is `|now − t| > tolerance`, never `t > now + tolerance`.
4. Persist the raw event, headers and verification result (`INV-33`) — *then*
   interpret it.
5. Deduplicate on the provider's event id. A replay is a recorded no-op.
6. Apply the transition through the domain, which re-asserts its own guards. The
   webhook proposes; the state machine decides.
7. An input the mapping table does not cover is still ingested, persisted,
   acknowledged and routed to a non-customer-actionable default, and it alarms
   (`INV-43`). A provider must never be able to stall event processing, or
   surface a message to a customer, by sending something we have not seen
   before.

**An unverified webhook never produces a state change.** It is stored, alarmed
on, and dropped. If a provider cannot sign its callbacks, INRSettle does not
trust callbacks from that provider at all and uses authenticated status pulls as
the only source of truth for that adapter.

## 5. Preventing duplicate payouts

- Every mutating public endpoint accepts and, for settlement creation and
  authorization, **requires** an `Idempotency-Key`. Key plus workspace plus
  environment plus a request-body fingerprint is unique; a replay returns the
  original response, and a reused key with a different body is a hard error.
- Every call to a payout provider carries a deterministic idempotency key
  derived from `settlement_id + attempt_number` (`INV-25`).
- A settlement holds at most one non-terminal payout attempt (`INV-24`).
- A cancellation request never races payout dispatch. Both take the same
  settlement row lock, so they are strictly ordered, and the point of no return
  is the commit of the dispatch transaction (`INV-36`). A failed or timed-out
  outbound call does not move the boundary back: a durable attempt with a stable
  idempotency key already exists, so recovery is an authoritative status pull
  (`INV-24`), never a cancellation and never a second dispatch. A cancellation
  that could execute concurrently with a dispatch is the same class of bug as a
  duplicate payout, and is prevented the same way — by the database, not by the
  caller.
- `UNKNOWN` is resolved by an authoritative status pull, never by resubmitting.
- The UI's authorize action is single-flight and disabled on submit, but that is
  a nicety; the server-side guarantees above are the actual control.

## 6. Immutability and audit

- `events`, `provider_events`, `ledger_entries`, `audit_log` and
  `facility_events` have `UPDATE` and `DELETE` revoked from the application role
  at the database level.
- `settlements.status` is writable only in a transaction that also inserts the
  matching event row; a database trigger enforces this (`INV-17`).
- Once `SETTLED`, the settlement's financial fields are rejected by a trigger for
  any update, and the row has no legal outgoing transition at all (`INV-38`).
  Facts arising afterwards — a returned credit above all — are written as linked
  aggregates that reference the settlement, never as changes to it
  (`STATE_MACHINES.md § 8.4`). A `SettlementReturn` can only be opened by a
  trusted provider event, held to the same standard as finality condition F3
  (`INV-39`), and only upheld by an authoritative check (`INV-40`).
- **No principal, internal or external, can set a settlement to `SETTLED`.** The
  finality evaluator is the only writer of that transition, and it evaluates
  conditions rather than accepting instructions. There is no force-settle, no
  admin override, and no "mark as paid" control in any surface.
- Every audit record carries: actor type and id, workspace, environment, subject,
  action, before/after where applicable, request id, IP, user agent, timestamp,
  and — for operator resolutions — a mandatory free-text reason.
- Audit records are exportable and retained for the statutory period, which is
  part of `D-02`.

## 7. Money integrity as a security control

Restating from `DOMAIN.md` because these are enforced here too:

- No floating point anywhere in the money path (`INV-01`), enforced by a lint
  rule that bans `parseFloat`, `Number()` and arithmetic operators on anything
  typed as `Money`.
- Money is stored as `BIGINT` minor units with an adjacent currency column
  (`INV-02`), checked in CI against the migration files.
- Cross-currency arithmetic is impossible by type (`INV-03`).
- Recipient INR is never rounded (`INV-05`); rounding is funding-side, upward,
  and disclosed (`INV-06`).
- Facility availability can never go negative (`INV-19`), enforced by a database
  `CHECK` as well as by the row lock.

## 8. Data protection

| Data | Treatment |
|---|---|
| Beneficiary account number | Encrypted at rest with an envelope key from the KMS; only last 4 in clear (`INV-12`) |
| VPA | Stored, masked in the UI beyond the handle |
| PAN / tax id | Encrypted at rest, masked everywhere, never in events or webhooks |
| Uploaded documents | Object storage, server-side encrypted, private, short-lived presigned URLs, per-workspace prefix |
| Provider payloads | Persisted for reconciliation and audit, access-controlled, never rendered into customer surfaces |
| Passwords | None — no password auth |

**Payout execution happens only in `worker`, so only `worker` holds the
capabilities payout execution needs.** Decryption of a payout destination happens
in `worker` alone, only to construct a payout instruction, and is itself audited.
Neither the customer app nor the public API process holds the destination
decryption capability or any payout-provider credential.

| Process | Payout-provider credentials | Destination decryption |
|---|---|---|
| `app` | no | no |
| `ops` | no | no |
| `api` | **no** | **no** |
| `worker` | yes | yes |

`api` does not need either: it renders masked details from the last four digits
held in clear, and it records intent that `worker` executes. Granting it
credentials "because it is also a backend" is exactly the reasoning that turns a
public-facing process into a payout oracle.

**Logs contain no account numbers, no PANs, no full provider payloads, no API
keys, no session tokens.** A structured-logging wrapper redacts by field name and
by pattern (IFSC-adjacent digit runs, key prefixes), and a CI test asserts that a
representative payout instruction serialises to a log line containing none of its
sensitive fields.

## 9. Secrets

No secret in client code, in a `NEXT_PUBLIC_` variable, in a repository, or in a
build artefact. Provider credentials and webhook secrets live in the platform
secret manager, scoped per environment, injected at runtime, rotatable without a
code change. Secret scanning runs on every commit and on every PR.

## 10. Regulatory posture — the question that sits above all of this

Two things must be settled by the founder with counsel, not inferred by an
engineer, and they change what the rest of this document has to say:

- **`D-02` — What is INRSettle, legally, in this corridor?** Software on top of a
  licensed partner's rails, or a regulated entity in its own right? India's
  framework for cross-border payment facilitation has specific authorisation
  requirements, and the answer determines KYB depth, screening obligations,
  record-retention periods, reporting duties, and who owns the compliance
  programme.
- **`D-01` — Where may payment data be stored?** India applies data-localisation
  requirements to payment system data. Whether and how they bind INRSettle
  follows from `D-02`, and the answer constrains hosting region, database
  location, backup topology and possibly provider choice.

Both are marked blocking before Stage 11 (first real integrations) in
`IMPLEMENTATION_PLAN.md`. Neither blocks Stages 1–10, which are built against
simulators.

## 11. Pre-launch security obligations

Before any real money moves:

1. Independent penetration test of `app`, `ops` and `api`.
2. Third-party review of the finality evaluator and the reservation concurrency
   path specifically — the two places where a subtle bug is expensive.
3. Documented and rehearsed incident response, including a provider-compromise
   scenario and a key-rotation drill.
4. Restore-from-backup drill with a verified point-in-time recovery.
5. Failure drills from `ARCHITECTURE.md § 12` executed against staging with
   results recorded in `ops/`.
6. Access review: every human and machine principal, every scope, justified.

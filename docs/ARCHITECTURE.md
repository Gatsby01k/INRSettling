# ARCHITECTURE.md

Status: **Stage 0 — Revision 4 · FROZEN 2026-09-05 · `beneficiary.verify` added to § 7 (Stage 8 review)**
Depends on: `DOMAIN.md`, `STATE_MACHINES.md`

---

## 1. Decision record: the stack

**Decision.** A single pnpm monorepo. Next.js (App Router) and TypeScript for
every user-facing surface and the public API; PostgreSQL as the only datastore;
Drizzle as the query layer; a Postgres-backed job runner. No Redis, no Kafka, no
microservices in V1.

**Why.** The hard part of this product is correctness under concurrency and an
auditable financial state machine — not scale. One Postgres instance with real
transactions, row locks and row-level security gives us atomic reservations
(`INV-20`), transactional outbox (`INV-32`) and tenant isolation (`INV-31`) with
far less machinery than a distributed design, and it is the design a payments
engineer can audit in an afternoon. TypeScript everywhere keeps one language
across the customer app, the ops app, the API and the workers, which matters
more than raw type strength at this team size.

**What would change this decision.** A regulatory requirement to hold Indian
payment data in-country under specific infrastructure terms (see `D-01`); a
counterparty demanding a formally verified core; or throughput beyond roughly a
few hundred settlements per second, which V1 will not approach.

**Reversibility.** High for the surfaces, deliberately high for the core. All
financial logic lives in `packages/domain` as plain TypeScript with no Next.js,
no React and no HTTP types in its imports. If the core ever needs to move to Go
or the JVM, it moves as a unit with a defined interface, not as a rewrite of the
whole product.

## 2. Repository layout

```
inrsettle-vnext/
├─ apps/
│  ├─ app/           Next.js — customer product (Overview, Settlements, …)
│  ├─ ops/           Next.js — Internal Operations, separately deployed
│  ├─ api/           Next.js route handlers — the public /v1 REST API
│  └─ worker/        Node process — jobs, sweepers, webhook delivery
├─ packages/
│  ├─ domain/        the entire financial core; no framework imports
│  │  ├─ identity/  beneficiaries/  preflight/  quotes/  settlements/
│  │  ├─ liquidity/ payouts/  reconciliation/  batches/  receipts/
│  │  └─ events/    audit/  money/  ids/
│  ├─ db/            Drizzle schema, migrations, RLS policies, seed
│  ├─ providers/     ports + adapters + deterministic simulators
│  ├─ ui/            design system components and tokens
│  ├─ contracts/     Zod schemas shared by API, apps and SDK
│  └─ testing/       fixtures, scenario builders, container harness
├─ docs/             this Stage 0 set
└─ ops/              runbooks, failure drills, migration playbooks
```

**Dependency rule, enforced by lint:**

```
apps/*      →  packages/ui, packages/contracts, packages/domain
packages/domain  →  packages/money, packages/ids, packages/db (types only)
packages/domain  ✗  never imports react, next, or any provider SDK
packages/providers  →  packages/domain (ports only)
```

A pull request that makes `packages/domain` import React fails CI. This is the
mechanical enforcement of `INV-10` — the UI never owns financial truth.

## 3. Runtime topology

| Process | Contains | Scaling | Notes |
|---|---|---|---|
| `app` | Customer product | horizontal, stateless | Session auth only |
| `ops` | Internal Operations | horizontal, stateless | Separate deployment, separate hostname, separate access control, IP-restricted |
| `api` | Public `/v1` | horizontal, stateless | API-key auth only; no session cookies accepted. Holds **no** payout credentials and **no** destination decryption capability |
| `worker` | Jobs, sweepers, webhook delivery, reconciliation, finality evaluation | horizontal, leader-free | All financial progression happens here |
| `postgres` | Everything | primary + replica | Replica for reporting reads only, never for financial decisions |

Ops is a separate deployment and not a route group inside the customer app.
Sharing a process with the customer surface is exactly how an internal control
leaks into a customer session.

**All state progression is asynchronous and lives in `worker`.** A request never
drives a settlement through more than one transition; it records intent and
enqueues. This is what makes retries, provider outages and partial failure
tractable.

## 4. Data layer

- **PostgreSQL 16+**, one logical database, schema-per-concern where it helps.
- **Drizzle ORM** with `drizzle-kit` migrations. SQL-first, so locking, partial
  indexes and `CHECK` constraints stay visible and reviewable in the codebase.
- **Migrations are forward-only** and reviewed like financial code. No
  destructive migration on a table holding financial history without an
  explicit, separately approved playbook in `ops/`.
- **Money columns** are always `(*_minor BIGINT, *_currency TEXT)` (`INV-02`).
  A CI check greps the schema for any numeric column whose name suggests money
  and fails the build if it is not a `BIGINT` pair.
- **Row-level security** on every tenant-scoped table, driven by session
  variables set by the connection wrapper on every checkout:

```sql
SET LOCAL app.workspace_id = $1;
SET LOCAL app.environment  = $2;
```

Application code cannot bypass it: the runtime role has no `BYPASSRLS`. The one
role that can read across tenants is used only by the ops process and only for
explicitly cross-tenant screens, and every such read is audited.

- **Append-only tables** (`events`, `provider_events`, `ledger_entries`,
  `audit_log`, `facility_events`) have `UPDATE` and `DELETE` revoked from the
  application role at the database level. Immutability is a grant, not a
  convention.

## 5. Provider architecture

Provider neutrality is an engineering principle, not a customer message. The
customer never sees provider names.

**Ports** (interfaces owned by `packages/domain`):

```ts
interface LiquidityProvider {
  getFacility(ref): Promise<FacilitySnapshot>
  requestDrawdown(cmd: DrawdownCommand): Promise<DrawdownAck>
  getDrawdown(ref): Promise<DrawdownStatus>
  submitRepayment(cmd): Promise<RepaymentAck>
}

interface PayoutProvider {
  capabilities(): PayoutCapabilities          // rails, limits, cut-off times
  submitPayout(cmd: PayoutCommand): Promise<PayoutAck>
  getPayout(ref): Promise<PayoutStatus>       // authoritative status pull
  verifySignature(raw, headers): VerifiedEvent | InvalidSignature
}

interface BeneficiaryVerificationProvider {
  verifyBankAccount(cmd): Promise<VerificationResult>   // penny drop / lookup
  verifyVpa(cmd): Promise<VerificationResult>
}

interface FxRateProvider  { getRate(pair): Promise<FxRate> }
interface DocumentStore   { put(...), presignedGet(...) }
interface NotificationSender { send(...) }
```

**Adapters** live in `packages/providers/<name>/` and may not import anything
from `packages/domain` except the port and its types. Adding a provider is a new
directory plus a config entry. It is never a domain change (`INV-10`).

Every adapter must implement: a stable idempotency key on every mutating call,
signature verification for inbound events, timeout and retry policy with
jittered backoff, and a **status pull** used to resolve `UNKNOWN` rather than
resubmitting.

Every adapter must also ship its **mapping table** — provider vocabulary to
INRSettle taxonomy — as versioned data, and must classify anything it cannot map
into one of two buckets the domain can always act on: *terminal rejection* or
*indeterminate*. An adapter that throws on an unrecognised provider code is
defective; `INV-43` defines where unmapped inputs go.

Adapters are called from jobs, never from inside a database transaction. The
dispatch transaction commits first and enqueues the call (`INV-36`); the adapter
runs afterwards and can fail freely, because the durable record of the attempt
already exists and recovery is a status pull. No adapter method may be invoked
while a row lock is held.

### 5.1 Deterministic simulators

`MockLiquidityProvider` and `MockIndiaPayoutProvider` are first-class code with
tests, not throwaway stubs.

**Deterministic, not random.** Behaviour is selected by input, so every scenario
is reproducible and every test is stable. Selection is by a magic segment of the
beneficiary account number in sandbox:

| Sandbox account suffix | Simulated outcome |
|---|---|
| `…0000` | Happy path: accepted → credited with UTR → reconciles MATCHED |
| `…0001` | Credited with a ₹5,000 shortfall → reconciliation MISMATCH |
| `…0002` | Rejected by beneficiary bank: account closed |
| `…0003` | No terminal status within SLA → `UNKNOWN` → exception |
| `…0004` | Credited and settled, then returned — opens a `SettlementReturn`, leaves the settlement `SETTLED` and its receipt hash unchanged |
| `…0005` | Provider timeout on submit; status pull shows the payout *did* exist |
| `…0006` | Name mismatch at verification |
| `…0007` | Slow drawdown, so a cancellation request lands mid-flight and must be held to the next checkpoint |
| `…0008` | Cancellation requested microseconds after the dispatch commit — must be refused with `past_point_of_no_return` |
| `…0009` | Provider returns an error code, a return reason and an event type that no mapping table has ever seen — must ingest, persist, route to a non-customer-actionable default, alarm, and keep the queue draining (`INV-43`) |
| `…0010` | Dispatch commits, then the outbound call fails; the status pull later shows the payout was created — must resolve without a second dispatch |
| `…0011` | Two partial returns totalling exactly the delivered amount, then a third — the third must breach the cap and go to `MANUAL_REVIEW` (`INV-49`) |
| `…0012` | The same return delivered twice, once by webhook and once by status pull — must produce exactly one `SettlementReturn` (`INV-50`) |
| `…0013` | Repayment submitted, no terminal status within SLA, then the pull shows it confirmed — availability must move only at that point (`INV-46`, `INV-47`) |
| `…0014` | Return arriving outside the rail's `return_observation_window` — must open in `MANUAL_REVIEW`, not on the normal path |

The simulators also expose a controllable clock so return observation windows,
expiries and SLA breaches can be exercised in seconds. Every scenario in
`PRODUCT.md § 18` is a scripted, replayable fixture.

## 6. Events, outbox and webhooks

```
transition ──┬─> settlements.status        (same transaction)
             ├─> events                    (append-only)
             └─> outbox                    (pending deliveries)
                        │
                   worker picks up
                        │
             ┌──────────┴──────────┐
        webhook delivery      internal projections
```

- Domain events and the state change share one transaction (`INV-32`).
- The outbox is drained by the worker with `SELECT … FOR UPDATE SKIP LOCKED`.
- Webhook delivery: signed, retried with exponential backoff and jitter over
  roughly 24 hours, with per-endpoint circuit breaking. Every attempt is logged
  and visible to the customer in Developers → Event logs, with a manual replay
  action.
- Inbound provider events are persisted raw *before* interpretation (`INV-33`),
  keyed by the provider's own event id, so redelivery is a no-op.

## 7. Job runner

**Graphile Worker** on the same Postgres. Rationale: transactional job
enqueueing (a job cannot exist without the transaction that created it),
`LISTEN/NOTIFY` for low latency, no extra infrastructure to secure or reason
about.

Job classes: `preflight.run`, `beneficiary.verify`, `quote.expire`,
`liquidity.reserve`, `liquidity.drawdown`, `payout.dispatch` (the outbound call,
enqueued by the dispatch transaction), `payout.poll`, `reconcile.run`,
`finality.evaluate`, `receipt.generate`, `webhook.deliver`, `batch.ingest`,
plus the sweepers in `STATE_MACHINES.md § 8`.

`beneficiary.verify` was added by **Revision 4**, in Stage 8. It was missing
rather than deliberately absent: `API_CONTRACT.md § 8` publishes
`POST /v1/beneficiaries/{id}/verify`, performing a verification requires
decrypting a payout destination, and § 8 of `SECURITY.md` grants that capability
to `worker` alone — so the endpoint can only record intent, and the intent had
no class to be enqueued onto. See `decisions/0014-beneficiary-verification-job.md`.

Every job is idempotent, takes an advisory lock on its subject, and is safe to
run twice. Jobs that touch money assert their expected pre-state and abort
rather than force a transition.

## 8. Environments

`sandbox` and `live` are a first-class dimension, not two deployments.

- Every tenant-scoped row carries `environment`.
- Every API key is bound to one environment (`sk_test_` / `sk_live_`).
- RLS filters on `environment` as well as `workspace_id` (`INV-31`).
- Sandbox binds to simulators; live binds to real adapters. The binding is
  configuration, and there is no code path by which a sandbox request can reach
  a live adapter or a live credential.
- Sandbox data is freely resettable; live data is never deleted.

## 9. Receipts and PDF

The canonical receipt is one serialisation in `packages/domain/receipts`. The UI
renders it, the API returns it, and the PDF is produced by headless Chromium
rendering the *same* template. One source, three surfaces, one `content_hash`
(`INV-29`). PDFs are generated once, stored in object storage, and served by
short-lived presigned URL.

## 10. Configuration and secrets

No secrets in client code, ever (`SECURITY.md § Secrets`). Configuration is
validated at boot by a Zod schema; the process refuses to start on a missing or
malformed value rather than failing at the first payout. Provider credentials
live in the platform secret manager, are scoped per environment, and are **held
only by `worker`**, the sole process that executes against providers. `app`,
`ops` and `api` hold neither payout-provider credentials nor the
payout-destination decryption capability (`SECURITY.md § 8`).

## 11. Observability

- **OpenTelemetry** traces spanning request → job → provider call, correlated by
  `settlement_id` and `request_id`.
- **Structured logs**, no PII, no account numbers, no full payloads
  (`SECURITY.md`). Provider payloads are referenced by `provider_event_id`.
- **The metrics that matter:** settlement funnel by state, time-to-settle p50 and
  p95, exception rate by cause, reconciliation mismatch rate and value, facility
  utilisation and headroom, webhook delivery success, provider latency and error
  rate by adapter.
- **Alarms that page:** availability projection disagreeing with the ledger
  (`INV-23`), any settlement in `EXCEPTION` past its SLA, mismatch value above a
  threshold, drawdown confirmed without a corresponding reservation, any attempt
  to update a status without a paired event.

## 12. Testing strategy

| Layer | Tool | Covers |
|---|---|---|
| Domain unit | Vitest | Pure state machine, money arithmetic, preflight rules. No database. |
| Money property tests | fast-check | Rounding never loses or invents value; INR recipient amounts are exact |
| Integration | Vitest + Testcontainers Postgres | RLS, locking, outbox, sweepers, the concurrency test in `STATE_MACHINES.md § 9` |
| Provider contract | Vitest | Every adapter, real and simulated, satisfies the same port test suite |
| End-to-end | Playwright | The nine-step demo flow, the ACTION_REQUIRED case, the batch, the webhook |
| Failure drills | scripted | Provider outage, duplicate webhook, replayed webhook, clock skew, partial drawdown, return after finality |

CI gates: type check, lint including the dependency-boundary rule, the money
column check, unit, integration, and the exhaustive illegal-transition test.

## 13. Deployment

Customer app, ops and api deploy independently. The worker deploys as a
long-running process with graceful drain — it must finish or safely abandon
in-flight jobs, never be killed mid-transaction. Database migrations run as a
separate gated step, never as an application boot side effect.

**Hosting region is not a free choice.** India's regulatory framework contains
data-localisation requirements for payment system data, and whether INRSettle is
in scope depends on its regulatory posture and on how the payout partner is
licensed. This is decision **`D-01`** and it is upstream of the hosting
contract, the database region and possibly the choice of provider. Treat it as
blocking before Stage 11, and settle it with counsel rather than inferring it.

## 14. Deliberately not doing

Microservices. Event sourcing as the primary store (events are an append-only
audit and integration channel; the aggregate row is the read model). Kafka.
Redis. A separate FX engine. GraphQL. Multi-region writes. A plugin system for
providers. Any of these can be added later against evidence; none earns its
operational cost in V1.

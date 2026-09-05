# Stage 1 — foundation notes

Built against the signed Stage 0 baseline (Revision 4/5). The manifest in
`README.md` is authoritative and is shipped alongside this code so it can be
verified against the code it governs.

## Scope

Stage 1 is the foundation named in `IMPLEMENTATION_PLAN.md`: repository
foundation, auth, workspaces, RBAC, database, audit/event infrastructure and the
design system.

**Deliberately absent** — settlements, quotes, beneficiaries, destination
versions, liquidity, payouts, reconciliation, receipts, returns and batches.
Their tables, transitions and invariants arrive in the stages that own them. A
test fails the build if a component whose name references a financial concept is
registered in the design system, so the restraint is enforced rather than
intended.

Two invariants the baseline states have nothing to attach to yet:
`INV-32`'s status-event constraint trigger attaches to `settlements` (Stage 3),
and the separation-of-duties evaluator is not wired to a transition until T08
exists (Stage 3). Both are implemented and tested as far as they can be.

## Layering

```
packages/money, ids, contracts   pure primitives
packages/domain                  PURE policy. No ORM, no database, no framework.
packages/db                      schema, migrations, RLS, the tenant-scoped client
packages/app-services            application layer: transactions, repositories, orchestration
packages/jobs                    the enqueue bridge
packages/ui                      design system
```

`ARCHITECTURE.md § 2` allows the domain database *types* only. This repository
takes the stricter line: `packages/domain` depends on nothing but the pure
packages, states what it needs from the outside as ports, and those ports are
implemented in `@inrsettle/app-services`. Both halves are tested — the lint rule
is proven to bite against a probe file, and the shipped source and manifest are
scanned for forbidden imports.

## Database privilege matrix

| | `inrsettle_app` | `inrsettle_worker` |
|---|---|---|
| Owns `graphile_worker` schema | no | **yes** |
| CREATE on database | no | **no** (granted for migration, revoked by 0003) |
| CREATE on `public` | no | **no** (granted for migration, revoked by 0003) |
| CONNECT | yes | yes |
| Queue tables (SELECT/INSERT/UPDATE/DELETE) | **none** | yes (as owner) |
| `graphile_worker.add_job` | **no** | yes |
| `public.enqueue_job` | **EXECUTE** | yes (owner) |
| `public.enqueue_job` — **PUBLIC** | **no EXECUTE** (default grant revoked by 0002) | |
| `job_tasks` registry | **none** | yes (as owner) |
| BYPASSRLS / superuser | no | no |
| Product tables | RLS-scoped read/write | not used |
| `events`, `audit_log` | SELECT + INSERT only | — |

The application enqueues through one `SECURITY DEFINER` function that accepts
only registered tasks. It has no ownership, no DDL and no direct access to the
queue.

**Migration ordering is load-bearing:**

1. `0001_init.sql` — as the database owner.
2. Graphile Worker's own migrations — **as `inrsettle_worker`**, which therefore
   owns every queue object.
3. `0002_job_queue_bridge.sql` — **as `inrsettle_worker`**, so the bridge carries
   the queue role's definer rights.
4. `0003_revoke_bootstrap.sql` — **as the database owner**, plus the
   database-level `REVOKE CREATE`. A role cannot revoke a grant it did not make;
   an earlier revision put these statements in `0002` and they silently did
   nothing until the privilege-matrix test caught it.

`installJobQueue()` in `@inrsettle/testing` is the reference implementation.

## Decisions taken while building

**Roles are a set.** `SECURITY.md § 3.2` describes an admin who is also an
approver. A single `memberships.role` column with `UNIQUE(workspace, environment,
user)` could not represent that, so roles live in `membership_roles` and a
principal's capabilities are the union of the roles held.

**Memberships are environment-scoped**, satisfying `INV-31` literally and
letting a person hold `approver` in sandbox and `viewer` in live.

**Role changes revoke sessions in the same transaction.** A privilege change that
leaves an old session usable is a privilege change that has not happened yet.

**`establishSession` returns a result rather than throwing.** A refusal writes an
audit row; throwing out of the caller's transaction would roll that row back, so
the refusal would destroy its own record. The test that caught this asserts the
audit rows exist.

**An invisible user is `no_membership`, not `user_disabled`.** RLS makes `users`
visible only through a membership in the current scope, so an absent row means
"not a member here". Reporting "disabled" would be wrong and would imply the
account exists.

**A refusal that records something cannot throw.** `establishSession` and
`resolveSession` both write an audit row — and `resolveSession` revokes the
session on a device mismatch — before refusing. Throwing out of the caller's
transaction rolled those writes back, so the defensive action was undone by the
refusal that triggered it. Both return a discriminated result instead;
`…OrThrow` wrappers exist for call sites that want an exception. Two tests
caught this, the second after the first had already taught the lesson.

**Sessions are bound to their device context.** A session established with a
fingerprint resolves only when the same one is presented; a mismatch revokes the
session and audits it, because a session id replayed from elsewhere is the
signature of a stolen token rather than a mistake.

**The primitive catalogue is read from the frozen document.** The coverage test
parses `DESIGN_SYSTEM.md § 5` rather than trusting the registry, because a
registry that defines its own universe reported full coverage while ten
primitives were missing.

**Disabled reasons use `aria-disabled`, not `disabled`.** A natively disabled
button leaves the tab order and takes its explanation with it; the reason is
associated with `aria-describedby` and activation is blocked in the handler.

## Exit criteria

| Criterion | Result |
|---|---|
| RLS isolation for every tenant-scoped table | **met** — table set discovered from the catalogue, with a reviewed global exception set |
| Boundary lint fails a React import into `packages/domain` | **met** — seven forbidden imports proven, plus a scan of the shipped source |
| Money-column check fails a `NUMERIC` amount | **met** — with negative fixtures |
| Append-only tables reject `UPDATE`/`DELETE` | **met** — by grant |
| A job enqueued in a rolled-back transaction does not run | **met** — plus the full privilege matrix |
| Storybook publishes every primitive with all five states | **met** — the full frozen § 5 catalogue (22) plus `EmptyState`, 118 stories, verified from the build artifact, plus behaviour tests |

## Running it

```bash
pnpm install --frozen-lockfile
pnpm ci   # typecheck -> lint -> money-column check -> build-storybook -> test

export TEST_ADMIN_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres'
```

The Storybook build precedes the tests because the coverage test reads
`storybook-static/index.json`. `.github/workflows/ci.yml` runs this against a
Postgres 16 service from a clean checkout and asserts no generated artifact is
present before it starts.

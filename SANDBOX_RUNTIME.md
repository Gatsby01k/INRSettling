# Partner sandbox

For the separate Saber-issued sandbox connection and test workflow, see
[Saber Money integration](SABER_SANDBOX.md).

This runtime connects the existing public API, PostgreSQL, Graphile Worker,
verification, funding, payout, reconciliation, receipts and customer webhooks.
The browser workspace at `/workspace` uses the same HTTP API as a partner.
**All provider responses and funds are simulated. The runtime refuses live mode.**

## Run locally

Requirements: Node 24+, pnpm 10.28, Docker Compose (or a dedicated PostgreSQL 16+
database), and the pinned Playwright Chromium. Existing production landing-page
deployment is independent of this runtime.

```sh
pnpm install --frozen-lockfile
pnpm --filter @inrsettle/providers exec playwright-core install chromium
pnpm sandbox:configure
pnpm sandbox:db
pnpm sandbox:migrate
pnpm sandbox:provision
pnpm sandbox
```

Open `http://127.0.0.1:8080/workspace`. Read the test key from
`.sandbox/ws_partner_sandbox.json` and enter it in the connection form. The
key remains in tab memory, is cleared from its input on connection, and is not
saved to browser storage. Use synthetic beneficiary details only.

`sandbox:configure` creates `.env.sandbox` with random credentials and field
keys, with owner-only file permissions. It refuses to overwrite an existing
file. Keep this file and `.sandbox/` out of Git. Do not regenerate encryption
keys when restarting an existing database: its ciphertext needs the original
keys. To change the port, set `INRSETTLE_PORT` in `.env.sandbox`.

For a native test Postgres, set `INRSETTLE_ADMIN_DATABASE_URL` before running
`sandbox:configure` and skip `sandbox:db`. The database must already exist.
Use a dedicated cluster: the database roles are cluster-global. Migrations
never drop a database, refuse changed previously applied SQL, and journal
each applied migration. Reference data is versioned and checksum-checked.

For separate processes, run `pnpm sandbox:api` and `pnpm sandbox:worker` in
different terminals. `pnpm sandbox` starts both for local development. SIGINT
and SIGTERM drain active jobs, close browser rendering and release pools.

## Exercise the flow

1. Add a beneficiary. The supplied synthetic happy-path name is Aarti Sharma;
   account `5010012340000`, IFSC `HDFC0000123`.
2. Wait for verification, then request ₹1,000.00 funded in USDT.
3. Review the saved quote and authorize the instruction.
4. Watch the settlement complete, inspect its receipt record and download PDF.
5. Register a public HTTPS webhook receiver and store the returned signing
   secret. Apply the published signature and event-ID deduplication rules.

```sh
pnpm sandbox:smoke
# For a different configured port:
INRSETTLE_BASE_URL=http://127.0.0.1:8189 pnpm sandbox:smoke
```

The smoke script uses HTTP only and prints an ID, status and receipt hash.
It does not log the API key or mutate financial rows directly.

The sandbox selector supports bank rejection (`…0002`), a lost provider reply
whose credit still exists (`…0005`), a shortfall (`…0001`, use ₹10,000 or more),
and beneficiary name mismatch (`…0006`). A shortfall must remain an exception;
it cannot produce a settled receipt. Some scenarios require explicit operational
resolution; they are not auto-retried or silently changed to success.

The existing sandbox document rules may block larger amounts. This workspace
does not implement document upload or human MFA enrollment. It does not relax
those requirements or replace them with a frontend status change.

## Integration surface

- `/v1/*`: existing API-key-only contract and scopes.
- `/openapi.json`: generated OpenAPI 3.1; `pnpm build:openapi` regenerates it.
- `/api-reference`: complete prose reference and examples.
- `/workspace/receipt?settlement_id=…`: authenticated PDF download for the
  connected workspace. Returns 409 while rendering is pending.
- `/healthz`: process liveness; `/readyz`: database connectivity. Readiness
  does not assert provider availability or an operating worker.

The API persists authorization and its execution job in one transaction.
Graphile owns durable queue claims; each state change goes through existing
application services. Sandbox provider answers are stored in a separate schema
under a separate database role, so a worker restart retains the counterparty's
idempotency record. Each settlement is serialized across workers by a session
advisory lock; no provider call holds a database transaction or settlement row
lock. Cancellation takes the ordinary application path and respects dispatch.

Customer webhooks use public HTTPS destinations only, pin the resolved address
for TLS connections and do not follow redirects. Loopback, private, link-local
and mapped IPv6 addresses are refused. Local receivers can be injected in tests,
but are not enabled through a public runtime option.

## Verification

```sh
TEST_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres pnpm test:runtime
TEST_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres pnpm run verify
```

The test admin credential must be able to create disposable databases and roles.
Tests create their own database and remove it afterwards. Existing data is not
used as a fixture. CI supplies an isolated PostgreSQL service. PDF tests use the
pinned browser; an explicit `INRSETTLE_CHROMIUM_PATH` can override its location.

The complete verification includes real HTTP requests, PostgreSQL RLS, durable
authorization with the worker stopped, resumed execution, stable idempotency,
signed webhook delivery, PDF download, browser rendering, and concurrent first
requests against a rate-limit bucket.

## Boundaries before production

This is a development and partner-evaluation runtime. It supplies no real
liquidity, legal approval, market rates or provider credentials. The combined
local process and `.env.sandbox` are not production secret isolation. A production
rollout needs separate process credentials, KMS-backed encryption boundaries,
region/backup decisions, real provider contracts, reconciliation reports,
monitoring and restore/security drills. See the partner checklist and runbook.

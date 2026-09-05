-- ============================================================================
-- 0012 — the public /v1 API
--
-- Scope: what `apps/api` needs and nothing else — scope resolution for a bearer
-- key, idempotency claims, the request log, webhook endpoints and their
-- delivery history, and per-key rate limiting.
--
-- Enforced here rather than in application code:
--   INV-31  every new tenant table carries workspace_id + environment with RLS
--           enabled and forced; the discovery gate finds them without being told
--   § 3.3   a sk_test_ key cannot address a live object, and the failure is
--           not_found — which falls out of RLS rather than out of a handler
--   § 4     one claim per (workspace, environment, endpoint, key); a different
--           body under a live key is a conflict, never a second execution
--
-- Two security corrections to earlier stages ride along, because Stage 8 adds
-- the second scope-resolution function and the pattern has to be right before
-- there are two of them. Both are explained where they appear.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Binding the tenant scope — a guard, not just a setter
-- ---------------------------------------------------------------------------
--
-- `withTenant` set the two GUCs with two `set_config(…, true)` statements. That
-- is correct at the top of a transaction and quietly wrong inside one.
--
-- `SET LOCAL` is transaction-scoped, and a subtransaction that *commits* keeps
-- its changes: a nested scoped transaction (Drizzle issues a SAVEPOINT, not a
-- new connection) therefore rebinds the enclosing transaction's scope for
-- everything that follows it. Workspace A's request would go on reading and
-- writing as workspace B, with `WITH CHECK` accepting every insert, because as
-- far as the database is concerned the caller said it was B.
--
-- Nothing in the tree does this today. The reason to close it now is that this
-- stage introduces the first code path where a scope is chosen from data —
-- an API key's own workspace — rather than from a session that was already
-- fixed, and that is the shape in which the mistake gets made.
--
-- Re-binding to the *same* scope stays legal: it is a no-op, and forbidding it
-- would ban harmless composition.
CREATE FUNCTION set_tenant_scope(p_workspace text, p_environment text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  cur_ws  text;
  cur_env text;
BEGIN
  cur_ws  := nullif(current_setting('app.workspace_id', true), '');
  cur_env := nullif(current_setting('app.environment',  true), '');

  IF cur_ws IS NOT NULL AND (cur_ws <> p_workspace OR cur_env IS DISTINCT FROM p_environment) THEN
    RAISE EXCEPTION
      'tenant scope is already bound to %/% and cannot be rebound to %/% inside one transaction',
      cur_ws, cur_env, p_workspace, p_environment
      USING ERRCODE = 'raise_exception';
  END IF;

  PERFORM set_config('app.workspace_id', p_workspace,   true);
  PERFORM set_config('app.environment',  p_environment, true);
END
$fn$;

GRANT EXECUTE ON FUNCTION set_tenant_scope(text, text) TO inrsettle_app;

-- ---------------------------------------------------------------------------
-- 2. The scope resolver — answering "whose is this?" before RLS can be set
-- ---------------------------------------------------------------------------
--
-- The public API authenticates with a bearer key whose *workspace and
-- environment are properties of the key itself*. But `api_keys` is RLS-forced
-- on `workspace_id = current_workspace_id()`, and the runtime role is
-- NOBYPASSRLS. The scope cannot be set until the key is read, and the key
-- cannot be read until the scope is set.
--
-- Stage 2 met the same wall for provider callbacks and answered it with
-- `resolve_verification_scope`. This is the same answer, and the two are now
-- given one owner: a role whose entire purpose is to map an opaque id to a
-- tenant, holding column-level SELECT on exactly the two columns sets that
-- requires and no privilege on anything else in the database.
--
-- Why a dedicated role rather than the obvious alternatives:
--
--   *Superuser-owned.* This is what both functions get by default, because
--   CREATE FUNCTION assigns ownership to the applying role and migrations are
--   applied as the owner. A SECURITY DEFINER function owned by a superuser and
--   executable by the application is a standing invitation: today's body is a
--   fixed parameterised SELECT, and every future edit to it silently runs with
--   rights that bypass every grant and every policy in the database. Correcting
--   `resolve_verification_scope` below is why this migration touches Stage 2.
--
--   *BYPASSRLS on the resolver.* Bounded only by the grants the role happens to
--   hold, so one `GRANT SELECT ON ALL TABLES` or one `ALTER DEFAULT PRIVILEGES`
--   later and it reads settlements and payout destinations across every tenant.
--   A permissive policy on one table cannot widen that way, and it is visible in
--   `pg_policies`, where the isolation gate already looks.
--
--   *Making the resolver own `api_keys`.* Does not work and would be worse if it
--   did: FORCE ROW LEVEL SECURITY exists precisely to strip the owner's
--   exemption, so it would read nothing — and an owner can `ALTER TABLE … NO
--   FORCE` and `DROP POLICY`, which is strictly more power, not less.
-- First, a prerequisite that only shows up once a definer function exists with a
-- search_path that does not include `public`.
--
-- `current_environment()` is called by **every** RLS policy in the database, and
-- its body casts with a bare `::environment`. A `LANGUAGE sql` function is
-- re-parsed when it is inlined into the query that triggered the policy — under
-- the *caller's* search_path. So the moment a policy is evaluated inside a
-- function pinned to `pg_catalog, pg_temp`, the cast fails with `type
-- "environment" does not exist`, and the failure looks like it comes from
-- whatever ran last rather than from the policy.
--
-- Schema-qualifying the cast fixes the class, not just this instance: any future
-- caller with a hardened search_path now works, and pinning the two functions'
-- own search_path means they no longer depend on their caller's at all.
CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT nullif(current_setting('app.workspace_id', true), '')
  $fn$;

CREATE OR REPLACE FUNCTION current_environment() RETURNS public.environment
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT nullif(current_setting('app.environment', true), '')::public.environment
  $fn$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrsettle_resolver') THEN
    CREATE ROLE inrsettle_resolver NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO inrsettle_resolver;

-- Column-level, so the resolver cannot read a key's name, its creator or its
-- usage history even by accident. `secret_sha256` is here because it is the
-- lookup predicate; it is never returned.
GRANT SELECT (id, workspace_id, environment, scopes, revoked_at, secret_sha256)
  ON api_keys TO inrsettle_resolver;
GRANT SELECT (id, workspace_id, environment)
  ON destination_verifications TO inrsettle_resolver;

-- Permissive policies are OR'd with the tenant policies, so `inrsettle_app`
-- is unaffected. NOTE for anyone editing roles later: RLS role matching uses
-- `has_privs_of_role`, which follows inheritance — `GRANT inrsettle_resolver TO
-- inrsettle_app` would hand the application these policies directly, with no
-- SET ROLE required. That grant must never exist, and the isolation gate
-- asserts it does not.
CREATE POLICY api_keys_resolver ON api_keys
  AS PERMISSIVE FOR SELECT TO inrsettle_resolver USING (true);
CREATE POLICY destination_verifications_resolver ON destination_verifications
  AS PERMISSIVE FOR SELECT TO inrsettle_resolver USING (true);

-- `pg_temp` is named explicitly and last. It is otherwise searched *first*, and
-- TEMPORARY on a database is granted to PUBLIC by default, so leaving it
-- implicit lets a caller put an object ahead of everything the definer resolves.
CREATE FUNCTION resolve_api_key(p_secret_sha256 text)
RETURNS TABLE (
  key_id       text,
  workspace_id text,
  environment  public.environment,
  scopes       text[],
  revoked      boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- This function exists to learn a scope. Calling it from inside a transaction
  -- that already has one means the caller is about to overwrite a scope it did
  -- not establish, so it is refused rather than answered.
  IF nullif(current_setting('app.workspace_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'resolve_api_key must not be called inside a tenant-scoped transaction'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN QUERY
    SELECT k.id, k.workspace_id, k.environment, k.scopes, k.revoked_at IS NOT NULL
    FROM public.api_keys k
    WHERE k.secret_sha256 = p_secret_sha256
    LIMIT 1;
END
$fn$;

ALTER FUNCTION resolve_api_key(text) OWNER TO inrsettle_resolver;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO inrsettle_app;

-- The Stage 2 correction. Same function, same body, correct owner and a
-- search_path that no longer includes a schema the worker role can create in.
ALTER FUNCTION resolve_verification_scope(text) OWNER TO inrsettle_resolver;
ALTER FUNCTION resolve_verification_scope(text) SET search_path = pg_catalog, pg_temp;

-- The third and last thing this role may answer: *which tenants have webhook
-- deliveries waiting*.
--
-- `ARCHITECTURE.md § 6` says the outbox is drained by the worker with
-- `SELECT … FOR UPDATE SKIP LOCKED`, and the drain does exactly that — but it
-- cannot start, because a NOBYPASSRLS worker cannot see that a workspace it has
-- not been told about has pending rows. This closes precisely that gap and
-- nothing else: it returns **scope pairs**, never an event, never a payload,
-- never an id. The drain that follows runs as the ordinary application role
-- under the ordinary tenant policy, so every row it touches is RLS-filtered in
-- the normal way.
--
-- What it discloses to a caller who already holds the application's credentials:
-- that some workspace has undelivered events. That is the smallest hole that
-- makes a global drain possible, and it is smaller than the alternative of
-- putting event scope into a job payload, which would put the same fact in the
-- queue instead — with the event id beside it.
GRANT SELECT (workspace_id, environment, status, next_attempt_at)
  ON outbox TO inrsettle_resolver;
CREATE POLICY outbox_resolver ON outbox
  AS PERMISSIVE FOR SELECT TO inrsettle_resolver USING (true);

CREATE FUNCTION pending_outbox_scopes(p_limit integer DEFAULT 50)
RETURNS TABLE (workspace_id text, environment public.environment)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT DISTINCT o.workspace_id, o.environment
  FROM public.outbox o
  WHERE o.status = 'pending' AND o.next_attempt_at <= now()
  LIMIT p_limit
$fn$;

ALTER FUNCTION pending_outbox_scopes(integer) OWNER TO inrsettle_resolver;
REVOKE ALL ON FUNCTION pending_outbox_scopes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pending_outbox_scopes(integer) TO inrsettle_app;

-- ---------------------------------------------------------------------------
-- 3. API version pinning — API_CONTRACT.md § 2
-- ---------------------------------------------------------------------------
-- Date-based and per workspace, overridable per request by the
-- `INRSettle-Version` header. One version exists; the machinery is here so the
-- second one is a data change rather than a redesign.
ALTER TABLE workspaces ADD COLUMN api_version text NOT NULL DEFAULT '2026-08-31';

-- ---------------------------------------------------------------------------
-- 4. Idempotency claims — API_CONTRACT.md § 4
-- ---------------------------------------------------------------------------
--
-- The claim, the operation it protects and the response it replays all commit
-- in ONE transaction. That is the whole design, and everything below follows:
--
--   *No lease, and no sweeper needed for correctness.* A process that dies
--   mid-operation rolls the claim back with the work, so there is no
--   "in progress" row left describing something that never happened, and no
--   reclaim path that could run a payment twice.
--
--   *Concurrency is the unique index.* A second request holding the same key
--   blocks on the index slot until the first commits or aborts, then either
--   sees the committed row (replay) or takes the slot (proceeds). A short
--   `lock_timeout` around that one statement turns the wait into
--   `409 idempotency_in_progress`.
--
-- What is deliberately NOT in the unique key: `request_fingerprint`.
-- `SECURITY.md § 5` reads "key plus workspace plus environment plus a
-- request-body fingerprint is unique", but its next clause — "a reused key with
-- a different body is a hard error" — is only reachable if the fingerprint is
-- *compared* rather than *keyed*. Keying on it would make a different body a
-- different row, and a different row is a second settlement. The clause is the
-- requirement; the sentence is loose, and this comment is here because the
-- omission otherwise looks like one.
--
-- `endpoint` is the CONCRETE request target, not the route template. The
-- contract's own worked example authorizes with no request body at all, so on
-- `/authorize`, `/cancel` and `/verify` the fingerprint is a constant: under a
-- template, one key reused across two settlements would replay the first
-- settlement's response and the second would silently never be authorized.
CREATE TABLE idempotency_claims (
  id                   text PRIMARY KEY,
  workspace_id         text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment          environment NOT NULL,
  -- "POST /v1/settlements/stl_2Rn8Kq5TzYw6/authorize"
  endpoint             text NOT NULL,
  idempotency_key      text NOT NULL,
  request_fingerprint  text NOT NULL,
  fingerprint_version  text NOT NULL,
  request_id           text NOT NULL,
  -- The object the operation acted on, when there is one. Checked against the
  -- request path on every replay, so a claim can never answer for a different
  -- object even if `endpoint` is one day built wrongly.
  subject_id           text,
  response_status      integer,
  -- text, not jsonb, for two reasons. jsonb cannot represent U+0000 and raises
  -- 22P05, which inside this transaction would take the settlement down with the
  -- bookkeeping — deterministically, so every retry would fail identically.
  -- And a replay promises "the original response": jsonb reorders keys and
  -- collapses duplicates, so it would return a different document.
  response_body        text,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at         timestamptz,
  expires_at           timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',

  CONSTRAINT idempotency_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  -- Printable ASCII only, so `key` and `key ` cannot be two claims that
  -- read identically in a log.
  CONSTRAINT idempotency_key_charset CHECK (idempotency_key ~ '^[\x20-\x7E]+$'),
  -- A half-written claim is unrepresentable: either the operation finished and
  -- both are set, or it did not and neither is.
  CONSTRAINT idempotency_response_complete
    CHECK ((response_status IS NULL) = (completed_at IS NULL)),
  CONSTRAINT idempotency_response_body_with_status
    CHECK ((response_status IS NULL) = (response_body IS NULL))
);

CREATE UNIQUE INDEX idempotency_claims_key
  ON idempotency_claims (workspace_id, environment, endpoint, idempotency_key);
-- Retention only. The claim lookup must NEVER filter on expires_at: an expired
-- row still holds the index slot, so a liveness filter produces a state where
-- the insert says "already claimed" and the select says "no such claim".
CREATE INDEX idempotency_claims_expiry ON idempotency_claims (expires_at);

-- ---------------------------------------------------------------------------
-- 5. Request log — PRODUCT.md § 13
-- ---------------------------------------------------------------------------
-- Append-only, like every other log in this system. `request_id` is the id: it
-- is on every response, in every error envelope and in every log line, so it is
-- the one string a customer sends us and the one we look up.
--
-- No request body and no response body. This table is read by developers in a
-- product surface, and a settlement request body carries beneficiary details;
-- SECURITY.md § 8's rule about what may appear in a log does not stop applying
-- because the log is pretty.
CREATE TABLE api_requests (
  id                    text PRIMARY KEY,
  workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment           environment NOT NULL,
  api_key_id            text,
  method                text NOT NULL,
  path                  text NOT NULL,
  route                 text NOT NULL,
  status                integer NOT NULL,
  error_type            text,
  error_code            text,
  api_version           text NOT NULL,
  idempotency_key       text,
  idempotency_replayed  boolean NOT NULL DEFAULT false,
  duration_ms           integer NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX api_requests_scope_idx ON api_requests (workspace_id, environment, created_at DESC);
CREATE INDEX api_requests_key_idx   ON api_requests (workspace_id, environment, api_key_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. Webhook endpoints — API_CONTRACT.md § 10, SECURITY.md § 4.1
-- ---------------------------------------------------------------------------
--
-- The signing secret is stored encrypted, in the same envelope shape as a
-- payout destination (`INV-12`), for a reason worth stating: it is the one
-- customer-facing secret in the system, it must be *retrievable* because a
-- customer configures their verifier with it, and a database disclosure that
-- yielded it would let anyone forge a settlement.settled event at that endpoint.
--
-- Two secrets, not one. Rotation with overlap is what makes it possible to
-- rotate without dropping an event: both are live until the old one expires,
-- and a delivery is signed with both, so the customer can cut over on their own
-- schedule (SECURITY.md § 4.1).
CREATE TABLE webhook_endpoints (
  id                      text PRIMARY KEY,
  workspace_id            text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment             environment NOT NULL,
  url                     text NOT NULL,
  description             text,
  -- Empty means every customer-visible type. A type not in
  -- API_CONTRACT.md § 10.2 is refused at the application layer, because an
  -- endpoint subscribed to an internal event is a request to leak the internal
  -- state machine.
  event_types             text[] NOT NULL DEFAULT '{}',
  status                  text NOT NULL DEFAULT 'enabled'
                          CHECK (status IN ('enabled', 'disabled', 'circuit_open')),
  secret_ciphertext       text NOT NULL,
  previous_secret_ciphertext text,
  previous_secret_expires_at timestamptz,
  consecutive_failures    integer NOT NULL DEFAULT 0,
  circuit_opened_at       timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              text NOT NULL,
  disabled_at             timestamptz,

  CONSTRAINT webhook_endpoint_https CHECK (url LIKE 'https://%'),
  CONSTRAINT webhook_previous_secret_pairing
    CHECK ((previous_secret_ciphertext IS NULL) = (previous_secret_expires_at IS NULL)),
  CONSTRAINT webhook_circuit_pairing
    CHECK ((status = 'circuit_open') = (circuit_opened_at IS NOT NULL))
);
CREATE INDEX webhook_endpoints_scope_idx ON webhook_endpoints (workspace_id, environment)
  WHERE status = 'enabled';

-- One row per (event, endpoint). The outbox says an event is ready to leave;
-- this says where it is going and how far it has got, and it is unique on the
-- pair so a re-drained outbox row cannot produce a second delivery chain.
--
-- `attempt_count` and `next_attempt_at` live here rather than on the outbox
-- because two endpoints for one event fail independently: an endpoint that is
-- down must not hold back one that is up (the same reasoning as INV-30, applied
-- to delivery).
CREATE TABLE webhook_deliveries (
  id                text PRIMARY KEY,
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment       environment NOT NULL,
  endpoint_id       text NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id          text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- 'replay' rows are deliberate re-sends, which is why the unique index below
  -- covers only the automatic ones: a replay is a new chain, on purpose.
  origin            text NOT NULL DEFAULT 'outbox'
                    CHECK (origin IN ('outbox', 'replay', 'test')),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed', 'exhausted')),
  attempt_count     integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  first_attempt_at  timestamptz,
  succeeded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX webhook_deliveries_automatic
  ON webhook_deliveries (endpoint_id, event_id) WHERE origin = 'outbox';
CREATE INDEX webhook_deliveries_due
  ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX webhook_deliveries_event_idx
  ON webhook_deliveries (workspace_id, environment, event_id);

-- Append-only. "Every attempt, its response code and its body are visible in
-- Developers → Event logs" (API_CONTRACT.md § 10.3) is a promise about this
-- table, and a promise about attempts cannot be kept by a table that overwrites
-- the previous one.
CREATE TABLE webhook_attempts (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment    environment NOT NULL,
  delivery_id    text NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  status_code    integer,
  -- Truncated by the application. A customer's error page is theirs, not
  -- something to store in full.
  response_body  text,
  error          text,
  duration_ms    integer NOT NULL,
  attempted_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT webhook_attempt_outcome CHECK (status_code IS NOT NULL OR error IS NOT NULL)
);
CREATE UNIQUE INDEX webhook_attempts_sequence
  ON webhook_attempts (delivery_id, attempt_number);
CREATE INDEX webhook_attempts_scope_idx
  ON webhook_attempts (workspace_id, environment, attempted_at DESC);

-- ---------------------------------------------------------------------------
-- 7. Rate limits — API_CONTRACT.md § 11
-- ---------------------------------------------------------------------------
-- Fixed window per key per bucket. Reads and writes have separate buckets and
-- batch ingestion has its own, so a batch import cannot exhaust the allowance a
-- dashboard poll needs.
--
-- The limits themselves are configuration, not a number chosen here: see the
-- sandbox fixture in the application layer, labelled as one for the same reason
-- the pricing fixtures are.
CREATE TABLE api_rate_limits (
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment   environment NOT NULL,
  api_key_id    text NOT NULL,
  bucket        text NOT NULL CHECK (bucket IN ('read', 'write', 'batch')),
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, environment, api_key_id, bucket)
);

-- ------------------------------------------------------ row-level security --

ALTER TABLE idempotency_claims  ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_claims  FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_requests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_requests        FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints   ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints   FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries  FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_attempts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_attempts    FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_rate_limits     ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_rate_limits     FORCE  ROW LEVEL SECURITY;

CREATE POLICY idempotency_claims_tenant ON idempotency_claims
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY api_requests_tenant ON api_requests
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY webhook_endpoints_tenant ON webhook_endpoints
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY webhook_deliveries_tenant ON webhook_deliveries
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY webhook_attempts_tenant ON webhook_attempts
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY api_rate_limits_tenant ON api_rate_limits
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

-- ------------------------------------------------------------------ grants --

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_claims TO inrsettle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints  TO inrsettle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO inrsettle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_rate_limits    TO inrsettle_app;

-- Append-only, like `events` and `audit_log`: the delivery history is the
-- evidence behind "we tried, here is what your endpoint said", and evidence
-- that can be edited is not evidence.
GRANT SELECT, INSERT ON api_requests     TO inrsettle_app;
GRANT SELECT, INSERT ON webhook_attempts TO inrsettle_app;
REVOKE UPDATE, DELETE, TRUNCATE ON api_requests     FROM inrsettle_app;
REVOKE UPDATE, DELETE, TRUNCATE ON webhook_attempts FROM inrsettle_app;

-- `outbox` was created in Stage 1 and, until now, drained by nobody. It already
-- carries the grants the drainer needs (0001); Stage 8 is what finally reads it.

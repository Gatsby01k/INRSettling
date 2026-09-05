-- ============================================================================
-- INRSettle vNext — Stage 1 foundation
--
-- Scope: identity, RBAC, API keys, workspace security policy, append-only
-- events and audit, and the outbox. No financial tables: settlements, quotes,
-- beneficiaries, liquidity, payouts, reconciliation and receipts arrive in
-- Stages 2-6 and are deliberately absent here.
--
-- Enforced here rather than in application code:
--   INV-02  money is (…_minor BIGINT, …_currency TEXT); no NUMERIC amounts
--   INV-31  tenant isolation by RLS on workspace_id AND environment
--   INV-32  events are append-only (UPDATE/DELETE revoked from the app role)
--   INV-34  audit is append-only and actor-attributed
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The runtime role. Deliberately NOT superuser and NOT BYPASSRLS: the isolation
-- guarantee is that application code *cannot* opt out of it (SECURITY.md § 2).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrsettle_app') THEN
    CREATE ROLE inrsettle_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- The queue role. Owns the Graphile Worker schema, runs its migrations, and is
-- the identity the worker pool connects as. It is deliberately a *different*
-- role from inrsettle_app: the application must be able to enqueue and nothing
-- more, so it holds no ownership and no DDL authority over the queue.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrsettle_worker') THEN
    CREATE ROLE inrsettle_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE TYPE environment    AS ENUM ('sandbox', 'live');
CREATE TYPE workspace_role AS ENUM ('viewer', 'operator', 'approver', 'admin', 'developer');
CREATE TYPE principal_type AS ENUM ('user', 'api_key', 'job', 'provider');
CREATE TYPE kyb_status     AS ENUM ('pending', 'approved', 'rejected', 'suspended');
CREATE TYPE mfa_method     AS ENUM ('totp', 'webauthn');

-- Session context, set with SET LOCAL by the connection wrapper on every
-- transaction. Never taken from a request body, header or query parameter.
CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS text
  LANGUAGE sql STABLE AS $fn$
    SELECT nullif(current_setting('app.workspace_id', true), '')
  $fn$;

CREATE OR REPLACE FUNCTION current_environment() RETURNS environment
  LANGUAGE sql STABLE AS $fn$
    SELECT nullif(current_setting('app.environment', true), '')::environment
  $fn$;

-- ---------------------------------------------------------------- identity --

CREATE TABLE workspaces (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  legal_name    text,
  kyb_status    kyb_status NOT NULL DEFAULT 'pending',
  number_format text NOT NULL DEFAULT 'international'
                CHECK (number_format IN ('international', 'indian')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Users are global: one person may belong to several workspaces. There is no
-- password column and there never will be — SECURITY.md § 3.1.
CREATE TABLE users (
  id          text PRIMARY KEY,
  email       text NOT NULL,
  full_name   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- A second factor is mandatory for every user in every workspace. The domain
-- refuses to establish a session without a verified method; this table is where
-- "verified" lives.
CREATE TABLE user_mfa_methods (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method      mfa_method NOT NULL,
  label       text,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_mfa_methods_user_idx ON user_mfa_methods (user_id);

-- Memberships are environment-scoped. INV-31 requires every tenant-scoped row
-- to carry workspace_id AND environment, and the scoping is not ceremonial: it
-- lets a person hold `approver` in sandbox while holding `viewer` in live.
-- A membership is the identity of "this user, in this workspace, in this
-- environment". The roles they hold there are a separate table, because the
-- frozen RBAC model grants *sets* of roles: SECURITY.md § 3.2 describes an
-- admin who is also an approver, and a single `role` column cannot represent
-- that. Capabilities are the union of the roles held (capabilitiesFor()).
CREATE TABLE memberships (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment  environment NOT NULL,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  UNIQUE (workspace_id, environment, user_id)
);
CREATE INDEX memberships_scope_idx ON memberships (workspace_id, environment);
CREATE INDEX memberships_user_idx  ON memberships (user_id);

CREATE TABLE membership_roles (
  membership_id text NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment   environment NOT NULL,
  role          workspace_role NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  granted_by    text,
  PRIMARY KEY (membership_id, role)
);
CREATE INDEX membership_roles_scope_idx ON membership_roles (workspace_id, environment);

-- Sessions. A session exists only where a verified second factor was presented
-- (SECURITY.md § 3.1), and `mfa_method` records which one, so "was this session
-- established under MFA" is answerable from the row rather than from trust.
CREATE TABLE sessions (
  id                 text PRIMARY KEY,
  workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment        environment NOT NULL,
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_method         mfa_method NOT NULL,
  device_fingerprint text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text
);
CREATE INDEX sessions_user_idx  ON sessions (workspace_id, environment, user_id);
CREATE INDEX sessions_live_idx  ON sessions (expires_at) WHERE revoked_at IS NULL;

-- API keys: SHA-256 of the secret only. The plaintext never reaches the
-- database, a log or an email — SECURITY.md § 3.3.
CREATE TABLE api_keys (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment   environment NOT NULL,
  name          text NOT NULL,
  prefix        text NOT NULL,
  secret_sha256 text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  CONSTRAINT api_keys_prefix_matches_environment CHECK (
    (environment = 'live'    AND prefix LIKE 'sk\_live\_%') OR
    (environment = 'sandbox' AND prefix LIKE 'sk\_test\_%')
  )
);
CREATE UNIQUE INDEX api_keys_secret_key ON api_keys (secret_sha256);
CREATE INDEX api_keys_scope_idx ON api_keys (workspace_id, environment);

-- Workspace security policy — decision D-007.
-- Separation of duties is configurable per workspace and per environment:
-- sandbox OFF by default so a single developer can exercise the full flow,
-- live ON by default so money never moves on one principal's say-so.
CREATE TABLE workspace_security_policies (
  workspace_id                   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment                    environment NOT NULL,
  separation_of_duties_enabled   boolean NOT NULL,
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  updated_by_type                principal_type,
  updated_by_id                  text,
  PRIMARY KEY (workspace_id, environment)
);

-- ------------------------------------------------------- events and audit --

-- Append-only. UPDATE and DELETE are revoked from inrsettle_app below, so
-- immutability is a grant rather than a convention (INV-32).
CREATE TABLE events (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment  environment NOT NULL,
  type         text NOT NULL,
  subject_type text NOT NULL,
  subject_id   text NOT NULL,
  actor_type   principal_type NOT NULL,
  actor_id     text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_scope_idx   ON events (workspace_id, environment, created_at DESC);
CREATE INDEX events_subject_idx ON events (workspace_id, environment, subject_type, subject_id);
CREATE INDEX events_type_idx    ON events (workspace_id, environment, type);

CREATE TABLE audit_log (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment  environment NOT NULL,
  actor_type   principal_type NOT NULL,
  actor_id     text NOT NULL,
  action       text NOT NULL,
  subject_type text NOT NULL,
  subject_id   text NOT NULL,
  before       jsonb,
  after        jsonb,
  reason       text,
  request_id   text,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_scope_idx   ON audit_log (workspace_id, environment, created_at DESC);
CREATE INDEX audit_log_subject_idx ON audit_log (workspace_id, environment, subject_type, subject_id);

-- The outbox is a delivery worklist, not a financial record, so it is mutable.
-- Rows are written in the same transaction as their event (INV-32) and drained
-- by the worker with SELECT … FOR UPDATE SKIP LOCKED.
CREATE TABLE outbox (
  id              text PRIMARY KEY,
  event_id        text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment     environment NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at) WHERE status = 'pending';

-- ------------------------------------------------------ row-level security --
-- Default-deny. A connection that has not set both session variables reads
-- nothing: current_workspace_id() is NULL and every policy fails.

ALTER TABLE workspaces                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE users                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_mfa_methods           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_methods           FORCE  ROW LEVEL SECURITY;
ALTER TABLE memberships                ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships                FORCE  ROW LEVEL SECURITY;
ALTER TABLE membership_roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles           FORCE  ROW LEVEL SECURITY;
ALTER TABLE sessions                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_keys                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE workspace_security_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_security_policies FORCE  ROW LEVEL SECURITY;
ALTER TABLE events                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE events                     FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_log                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE outbox                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox                     FORCE  ROW LEVEL SECURITY;

CREATE POLICY workspaces_tenant ON workspaces
  USING (id = current_workspace_id())
  WITH CHECK (id = current_workspace_id());

-- Users are visible only through a membership in the current scope.
CREATE POLICY users_tenant ON users
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = users.id
      AND m.workspace_id = current_workspace_id()
      AND m.environment  = current_environment()));
-- users and user_mfa_methods are global identity tables: a person exists once
-- and may belong to several workspaces, so they carry no workspace_id column
-- and are reached only through a membership in the current scope. They are the
-- reviewed exception set in the RLS discovery test.

CREATE POLICY user_mfa_tenant ON user_mfa_methods
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = user_mfa_methods.user_id
      AND m.workspace_id = current_workspace_id()
      AND m.environment  = current_environment()));

CREATE POLICY memberships_tenant ON memberships
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY membership_roles_tenant ON membership_roles
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY sessions_tenant ON sessions
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY api_keys_tenant ON api_keys
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY security_policies_tenant ON workspace_security_policies
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY events_tenant ON events
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY audit_log_tenant ON audit_log
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY outbox_tenant ON outbox
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

-- ------------------------------------------------------------------ grants --

GRANT USAGE ON SCHEMA public TO inrsettle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspaces, users, user_mfa_methods, memberships, membership_roles, sessions,
  api_keys, workspace_security_policies, outbox
  TO inrsettle_app;

-- Append-only: the application may write history and read it, and can do
-- nothing else to it. This is what makes immutability a grant, not a habit.
GRANT SELECT, INSERT ON events    TO inrsettle_app;
GRANT SELECT, INSERT ON audit_log TO inrsettle_app;
REVOKE UPDATE, DELETE, TRUNCATE ON events    FROM inrsettle_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM inrsettle_app;

-- The queue role needs somewhere to put the enqueue bridge (migration 0002).
GRANT USAGE, CREATE ON SCHEMA public TO inrsettle_worker;

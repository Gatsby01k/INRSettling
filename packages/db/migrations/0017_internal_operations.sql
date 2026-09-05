-- ============================================================================
-- 0017 — Stage 9: Internal Operations
--
-- `PRODUCT.md § 14`, `SECURITY.md § 2`, `§ 3.1`, `§ 3.2`, `§ 6`.
--
-- Three things, and the third is the one that matters.
--
--   1. INRSettle staff identity: operators, their internal roles, their
--      sessions. Global tables, because a member of staff is not tenant data.
--   2. `principal_type` gains `operator`, so an audit record answers "was this
--      the customer or was this us" by its type rather than by whoever reads it
--      recognising the id.
--   3. `inrsettle_ops` — the **explicitly named role** `SECURITY.md § 2`
--      requires for cross-tenant reads.
--
-- ## The shape of ops access, and why it is asymmetric
--
-- **Ops reads across tenants. Ops writes do not exist.**
--
-- `inrsettle_ops` is granted `SELECT` and nothing else — no INSERT, no UPDATE,
-- no DELETE, on any table, ever. An operator action on a settlement is a
-- *tenant-scoped write performed by the ordinary application role* inside a
-- normal `withTenant` transaction, exactly like a customer action. That is the
-- whole design:
--
--   * every RLS policy, every CHECK, every trigger, `INV-32`'s status/event
--     pairing and the settled-row immutability guard all apply to an operator
--     unchanged, because the operator is using the same path;
--   * there is no second write path to audit, harden, or forget about;
--   * "no ops action can set SETTLED or edit a settled record" is not a rule the
--     ops code has to remember — it is the database refusing, to the same role,
--     for the same reason it refuses everyone else.
--
-- The privilege ops holds is therefore exactly one thing: the ability to *see*
-- a workspace it was not scoped to. Nothing else.
--
-- ## Why a permissive policy rather than BYPASSRLS
--
-- The same reasoning migration `0012` recorded for `inrsettle_resolver`, and it
-- has more force here because this role sees more. `BYPASSRLS` is bounded only
-- by whatever grants the role happens to hold, so one `GRANT ALL ON ALL TABLES`
-- later it is reading and writing everything. A permissive `FOR SELECT` policy
-- cannot widen that way: it is per-table, it is SELECT-only, and it is visible
-- in `pg_policies`, where the isolation gate already looks.
--
-- NOTE, repeated from `0012` because it is the failure that would undo all of
-- this: RLS role matching uses `has_privs_of_role`, which follows inheritance.
-- `GRANT inrsettle_ops TO inrsettle_app` would hand the customer-facing
-- application every one of these cross-tenant policies with no `SET ROLE`
-- required. That grant must never exist, and the isolation gate asserts it does
-- not.
-- ============================================================================

-- ------------------------------------------------------- the named ops role --

-- **First**, before anything that names it.
--
-- A `CREATE POLICY … TO inrsettle_ops` earlier in this file than the role would
-- apply cleanly on any cluster that already had the role from a previous run and
-- fail on a genuinely fresh one — roles are cluster-global while migrations are
-- per-database, so the residue of one test database masks the ordering defect
-- for every database created after it. That is precisely the shape of bug that
-- ships: it passes locally, passes in CI on a warm cluster, and fails once, on
-- the first production deployment.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrsettle_ops') THEN
    CREATE ROLE inrsettle_ops NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO inrsettle_ops;

-- ---------------------------------------------------------- principal type --

-- `operator` is INRSettle staff acting in Internal Operations.
ALTER TYPE principal_type ADD VALUE IF NOT EXISTS 'operator';

CREATE TYPE internal_role AS ENUM ('ops_read', 'ops_resolve', 'ops_liquidity', 'ops_admin');

-- ------------------------------------------------------- operator identity --

-- Global, deliberately. `SECURITY.md § 3.2`: internal roles are *"entirely
-- separate and never granted inside a customer workspace"*. There is no
-- `workspace_id` on this table or the next, so there is nowhere to put one —
-- the separation is structural rather than a rule somebody enforces.
CREATE TABLE internal_operators (
  id           text PRIMARY KEY,
  email        text NOT NULL,
  display_name text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  disabled_at  timestamptz,
  CONSTRAINT suspended_is_stamped CHECK (status <> 'suspended' OR disabled_at IS NOT NULL)
);
CREATE UNIQUE INDEX internal_operators_email ON internal_operators (lower(email));

CREATE TABLE internal_operator_roles (
  operator_id text NOT NULL REFERENCES internal_operators(id) ON DELETE CASCADE,
  role        internal_role NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  text NOT NULL REFERENCES internal_operators(id),
  PRIMARY KEY (operator_id, role)
);

-- MFA is mandatory for an operator for the same reason it is mandatory for a
-- customer user (`SECURITY.md § 3.1`) — more so, since this session can see
-- every workspace. `mfa_method` is NOT NULL: a session without a second factor
-- is unrepresentable rather than refused by a check somebody could skip.
CREATE TABLE internal_sessions (
  id            text PRIMARY KEY,
  operator_id   text NOT NULL REFERENCES internal_operators(id) ON DELETE CASCADE,
  mfa_method    mfa_method NOT NULL,
  -- `§ 3.1`: *"Sessions are short, bound to a device fingerprint, revocable
  -- from settings, and invalidated on role change. `ops` sessions are shorter
  -- still and additionally network-restricted."*
  --
  -- "Additionally" is the word that matters: an ops session carries every
  -- restriction a customer session carries, and then the network one on top.
  -- So the fingerprint is NOT NULL here where it is nullable on `sessions` —
  -- a customer may be admitted without one, an operator may not, and an
  -- unbound ops session is unrepresentable rather than refused by a check
  -- somebody could skip.
  device_fingerprint text NOT NULL CHECK (length(btrim(device_fingerprint)) > 0),
  -- The address that established the session, and the allow-list that admitted
  -- it, so "which policy let this in" is answerable a year later when the
  -- policy has changed.
  ip            inet NOT NULL,
  network_policy text NOT NULL,
  user_agent    text,
  established_at timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  -- Why it was revoked. A device mismatch revokes rather than merely refusing,
  -- exactly as a customer session does: a session id replayed from somewhere
  -- else is the signature of a stolen token, not an ordinary error.
  revoked_reason text
);
CREATE INDEX internal_sessions_operator ON internal_sessions (operator_id, established_at DESC);

-- ------------------------------------------------ operator action recording --

-- What an operator did, and why, independent of any one workspace.
--
-- This does **not** replace `audit_log`: an operator action on a settlement is
-- written into that settlement's workspace audit log, where the customer can
-- see it, and that is the point. This table is the second half of the same
-- record — the cross-tenant view, so "what has this operator been doing" is one
-- query rather than a scan of every workspace.
--
-- A read is an action here. `SECURITY.md § 2` requires *every* cross-tenant
-- read to be written down with the operator, the workspace and the reason, and
-- a table that only recorded writes would answer "who changed this" while
-- leaving "who looked at this" unanswerable.
CREATE TABLE operator_actions (
  id            text PRIMARY KEY,
  operator_id   text NOT NULL REFERENCES internal_operators(id),
  session_id    text REFERENCES internal_sessions(id),
  kind          text NOT NULL CHECK (kind IN ('read', 'write')),
  action        text NOT NULL,
  -- The workspace whose data was reached. NOT NULL: an ops action that touched
  -- no workspace is not an ops action, and a nullable column here would become
  -- the place where an unattributed read hides.
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment   environment NOT NULL,
  subject_type  text,
  subject_id    text,
  reason        text NOT NULL CHECK (length(btrim(reason)) >= 8),
  request_id    text,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_actions_operator ON operator_actions (operator_id, created_at DESC);
CREATE INDEX operator_actions_workspace ON operator_actions (workspace_id, environment, created_at DESC);
CREATE INDEX operator_actions_subject ON operator_actions (subject_type, subject_id, created_at DESC);

-- Financial history is not editable and neither is the record of who looked at
-- it. Append-only, in the database, for the same reason the ledger is.
CREATE OR REPLACE FUNCTION operator_actions_are_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'operator_actions is append-only (SECURITY.md § 6)'
    USING ERRCODE = 'raise_exception';
END $$;

CREATE TRIGGER operator_actions_no_update
  BEFORE UPDATE OR DELETE ON operator_actions
  FOR EACH ROW EXECUTE FUNCTION operator_actions_are_append_only();

-- Tenant-scoped, with the ordinary policy, on purpose.
--
-- This table carries a `workspace_id` because every row is about a workspace,
-- and once it does, `INV-31` applies to it like everything else. The
-- consequence is the right one: a customer reading their own audit trail can
-- see that INRSettle looked at their settlement, who did, and why. An internal
-- access record the customer cannot see would be a worse record.
ALTER TABLE operator_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_actions FORCE  ROW LEVEL SECURITY;

CREATE POLICY operator_actions_tenant ON operator_actions
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

-- And the cross-tenant read, for the one question this table exists to answer:
-- *what has this operator been doing*. That question spans workspaces by
-- definition, and answering it from the per-workspace log would mean scanning
-- every workspace in the deployment. Note what this is a read of — our own
-- record of what we did, not a customer's data.
CREATE POLICY operator_actions_ops ON operator_actions
  AS PERMISSIVE FOR SELECT TO inrsettle_ops USING (true);

-- The tables Internal Operations may read, and no others.
--
-- `PRODUCT.md § 14` names settlements, liquidity facilities, reservations,
-- drawdowns, repayments, payout providers, reconciliation queues, exceptions,
-- raw provider events and the audit log. The rest of this list is what a
-- settlement detail view needs to be legible — the quote it was priced on, the
-- beneficiary it is going to, the attempt that was dispatched, the returns
-- against it.
--
-- What is **absent** is as deliberate as what is present. Ops cannot read
-- `api_keys`, `sessions`, `api_requests`, `idempotency_claims`,
-- `webhook_endpoints` and their deliveries, `users`, `memberships`, or
-- `workspace_security_policies`. Those are the customer's own credentials,
-- identity and developer plumbing; none of them is needed to resolve an
-- exception or reconcile a payout, and an internal surface that could read them
-- is a much larger blast radius for one compromised staff account.
DO $$
DECLARE
  t text;
  ops_tables text[] := ARRAY[
    -- § 14, named
    'settlements', 'settlement_exceptions',
    'liquidity_facilities', 'liquidity_reservations', 'drawdowns', 'repayments',
    'provider_events', 'reconciliations', 'audit_log',
    -- what makes those legible
    'workspaces', 'quotes', 'payout_attempts', 'payout_destinations',
    'destination_verifications', 'ledger_entries', 'return_observations',
    'settlement_returns', 'finality_evaluations', 'financial_artifacts',
    'batches', 'batch_rows', 'events'
  ];
BEGIN
  FOREACH t IN ARRAY ops_tables LOOP
    EXECUTE format('GRANT SELECT ON %I TO inrsettle_ops', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR SELECT TO inrsettle_ops USING (true)',
      t || '_ops', t);
  END LOOP;
END $$;

-- The two tables ops reads column-by-column.
--
-- Ops sees a beneficiary and a payout destination in exactly the masked form
-- the customer sees. `SECURITY.md § 8` grants destination decryption to
-- `worker` alone, and while holding a ciphertext is not holding a key, the
-- internal surface is where the temptation to "just add decryption for
-- support" is strongest — so the column is not reachable at all.
--
-- `details_fingerprint` is excluded for its own recorded reason: it is a keyed
-- value whose only job is internal change detection, and its comment on
-- `payout_destination_versions` says *never returned, never logged*.
GRANT SELECT (
  id, workspace_id, environment, display_name, legal_name, type, country,
  tax_id_last4, status, default_destination_id, created_at, created_by,
  updated_at, disabled_at
) ON beneficiaries TO inrsettle_ops;

GRANT SELECT (
  id, workspace_id, environment, destination_id, version_number, kind,
  account_number_last4, ifsc, account_type, account_holder_name, vpa,
  created_at, created_by
) ON payout_destination_versions TO inrsettle_ops;

CREATE POLICY beneficiaries_ops ON beneficiaries
  AS PERMISSIVE FOR SELECT TO inrsettle_ops USING (true);
CREATE POLICY payout_destination_versions_ops ON payout_destination_versions
  AS PERMISSIVE FOR SELECT TO inrsettle_ops USING (true);

-- Reference data the ops surface reads to render what it sees. Not tenant data,
-- so there is no policy to write — only the grant.
GRANT SELECT ON purpose_codes, preflight_rule_sets, provider_mapping_tables,
                settlement_status_events TO inrsettle_ops;

-- The staff tables themselves. `inrsettle_ops` reads them to render "who am I
-- and what may I do"; the *writes* — establishing a session, recording an
-- action, granting a role — belong to the application role, which is the one
-- with a write path and a transaction around it.
GRANT SELECT ON internal_operators, internal_operator_roles, internal_sessions,
                operator_actions TO inrsettle_ops;

GRANT SELECT, INSERT, UPDATE ON internal_operators, internal_operator_roles,
                                 internal_sessions TO inrsettle_app;
-- No UPDATE, no DELETE: the trigger above refuses them anyway, and a grant that
-- says otherwise would be a lie about what is possible.
GRANT SELECT, INSERT ON operator_actions TO inrsettle_app;

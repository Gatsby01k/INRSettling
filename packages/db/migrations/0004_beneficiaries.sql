-- ============================================================================
-- 0004 — Stage 2: beneficiaries, destination versions, verification, preflight
--
-- Scope: DOMAIN.md § 6.2 (beneficiary, payout destination, destination version)
-- and § 6.3 (purpose), plus the preflight rule set. No settlements, quotes,
-- liquidity, payouts, reconciliation, receipts or batches — those tables belong
-- to the stages that own them.
--
-- Enforced here rather than in application code:
--   INV-12  full account numbers encrypted at rest; only last 4 in clear
--   INV-31  tenant isolation by RLS on workspace_id AND environment
--   INV-44  destination versions are append-only
--   INV-45  verification attaches to a version, never to a destination
-- ============================================================================

CREATE TYPE beneficiary_type        AS ENUM ('individual', 'business');
CREATE TYPE beneficiary_status      AS ENUM ('draft', 'pending_verification', 'verified', 'rejected', 'disabled');
CREATE TYPE destination_kind        AS ENUM ('bank_account', 'upi');
CREATE TYPE verification_status     AS ENUM ('unverified', 'verifying', 'verified', 'failed');
CREATE TYPE verification_method     AS ENUM ('penny_drop', 'provider_lookup', 'manual');

-- ------------------------------------------------------------ beneficiary --

-- Deliberately not a CRM (PRODUCT.md § 11): no tags, notes, owners, contacts,
-- lifecycle stages or activity feed. Only what helps someone settle.
CREATE TABLE beneficiaries (
  id                    text PRIMARY KEY,
  workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment           environment NOT NULL,
  display_name          text NOT NULL,
  legal_name            text,
  type                  beneficiary_type NOT NULL,
  country               text NOT NULL DEFAULT 'IN' CHECK (country = 'IN'),
  -- PAN. Encrypted at rest, masked everywhere (SECURITY.md § 8).
  tax_id_ciphertext     text,
  tax_id_last4          text,
  status                beneficiary_status NOT NULL DEFAULT 'draft',
  default_destination_id text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  disabled_at           timestamptz
);
CREATE INDEX beneficiaries_scope_idx ON beneficiaries (workspace_id, environment, created_at DESC);
CREATE INDEX beneficiaries_name_idx  ON beneficiaries (workspace_id, environment, lower(display_name));

-- --------------------------------------------- destination and its versions --

-- The stable handle the customer owns. Carries no payout details itself: those
-- live in versions, so that editing them cannot change what an already
-- authorized settlement will pay (INV-44, INV-45).
CREATE TABLE payout_destinations (
  id                 text PRIMARY KEY,
  workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment        environment NOT NULL,
  beneficiary_id     text NOT NULL REFERENCES beneficiaries(id) ON DELETE CASCADE,
  kind               destination_kind NOT NULL,
  current_version_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL,
  disabled_at        timestamptz
);
CREATE INDEX payout_destinations_scope_idx ON payout_destinations (workspace_id, environment);
CREATE INDEX payout_destinations_ben_idx   ON payout_destinations (beneficiary_id);

-- Append-only. A trigger below rejects UPDATE of any payout detail, so
-- immutability is enforced by the database rather than by discipline.
CREATE TABLE payout_destination_versions (
  id                       text PRIMARY KEY,
  workspace_id             text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment              environment NOT NULL,
  destination_id           text NOT NULL REFERENCES payout_destinations(id) ON DELETE CASCADE,
  version_number           integer NOT NULL,
  kind                     destination_kind NOT NULL,

  -- bank_account
  account_number_ciphertext text,
  account_number_last4      text,
  ifsc                      text CHECK (ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_type              text CHECK (account_type IS NULL OR account_type IN ('savings', 'current')),
  account_holder_name       text,

  -- upi
  vpa                       text,

  -- Keyed fingerprint (HMAC-SHA256) of workspace + environment + the canonical
  -- payout details, under a secret held outside the database. It answers "did
  -- anything actually change" without being an offline-guessable digest of a
  -- bank account: the input space is small and structured, so a plain hash
  -- stored beside the ciphertext would undo INV-12. Opaque; never returned,
  -- never logged.
  details_fingerprint       text NOT NULL,

  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                text NOT NULL,
  superseded_at             timestamptz,

  UNIQUE (destination_id, version_number),
  CONSTRAINT destination_version_shape CHECK (
    (kind = 'bank_account'
       AND account_number_ciphertext IS NOT NULL AND account_number_last4 IS NOT NULL
       AND ifsc IS NOT NULL AND account_holder_name IS NOT NULL AND vpa IS NULL)
    OR
    (kind = 'upi'
       AND vpa IS NOT NULL AND account_number_ciphertext IS NULL AND ifsc IS NULL)
  )
);
CREATE INDEX pdv_scope_idx ON payout_destination_versions (workspace_id, environment);
CREATE INDEX pdv_dest_idx  ON payout_destination_versions (destination_id, version_number DESC);

-- Payout details are frozen at insert. `superseded_at` is the one field a later
-- version may set, and only from NULL.
CREATE OR REPLACE FUNCTION reject_destination_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.destination_id            IS DISTINCT FROM OLD.destination_id
  OR NEW.version_number            IS DISTINCT FROM OLD.version_number
  OR NEW.kind                      IS DISTINCT FROM OLD.kind
  OR NEW.account_number_ciphertext IS DISTINCT FROM OLD.account_number_ciphertext
  OR NEW.account_number_last4      IS DISTINCT FROM OLD.account_number_last4
  OR NEW.ifsc                      IS DISTINCT FROM OLD.ifsc
  OR NEW.account_type              IS DISTINCT FROM OLD.account_type
  OR NEW.account_holder_name       IS DISTINCT FROM OLD.account_holder_name
  OR NEW.vpa                       IS DISTINCT FROM OLD.vpa
  OR NEW.details_fingerprint       IS DISTINCT FROM OLD.details_fingerprint
  OR NEW.created_at                IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'payout_destination_versions is append-only: edit the destination to create a new version (INV-44)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'superseded_at is write-once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER pdv_append_only
  BEFORE UPDATE ON payout_destination_versions
  FOR EACH ROW EXECUTE FUNCTION reject_destination_version_mutation();

-- ---------------------------------------------------------- verification --

-- Attaches to a destination *version*, never to a destination (INV-45).
CREATE TABLE destination_verifications (
  id                      text PRIMARY KEY,
  workspace_id            text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment             environment NOT NULL,
  destination_version_id  text NOT NULL REFERENCES payout_destination_versions(id) ON DELETE CASCADE,
  status                  verification_status NOT NULL DEFAULT 'verifying',
  method                  verification_method NOT NULL,
  provider_id             text NOT NULL,
  provider_reference      text,
  -- Name-match evidence. There is no global threshold: the policy that decided
  -- is versioned reference data keyed by (provider, method), because a score is
  -- a property of one provider's method and not of "verification" (D-11 open).
  name_match_outcome      text CHECK (name_match_outcome IS NULL
                            OR name_match_outcome IN ('satisfied', 'mismatch', 'insufficient_evidence')),
  name_match_basis        text,
  name_match_score        integer,
  name_match_policy_version text,
  reason_code             text,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  requested_by            text NOT NULL,
  resolved_at             timestamptz,
  provider_event_id       text
);
-- One in-flight verification per version.
CREATE UNIQUE INDEX dv_one_active_per_version
  ON destination_verifications (destination_version_id) WHERE status = 'verifying';
CREATE INDEX dv_scope_idx   ON destination_verifications (workspace_id, environment);
CREATE INDEX dv_version_idx ON destination_verifications (destination_version_id);
-- A provider reference identifies one verification, so a redelivered result
-- cannot open a second.
CREATE UNIQUE INDEX dv_provider_ref
  ON destination_verifications (provider_id, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- Raw provider events, persisted verbatim before interpretation (INV-33).
CREATE TABLE provider_events (
  id                text PRIMARY KEY,
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment       environment NOT NULL,
  provider_id       text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  -- Whether the transport authenticated this payload. A false value does not
  -- stop the event being stored (INV-33) but does stop it changing state:
  -- untrusted evidence may never mark a destination version VERIFIED.
  signature_valid   boolean NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  interpreted_at    timestamptz,
  interpretation    text
);
-- Redelivery of the same provider event is a no-op.
CREATE UNIQUE INDEX provider_events_dedupe
  ON provider_events (provider_id, provider_event_id);
CREATE INDEX provider_events_scope_idx ON provider_events (workspace_id, environment, received_at DESC);

-- ------------------------------------------------------ preflight config --

-- Versioned reference data. Preflight rules that depend on the regulatory
-- purpose-code taxonomy (decision D-06) are *loaded*, not written into the
-- domain: the real table is provider- and AD-bank-specific and is not yet
-- known. `source` records where a row came from so a sandbox fixture can never
-- be mistaken for production regulatory truth.
CREATE TABLE preflight_rule_sets (
  version        text PRIMARY KEY,
  source         text NOT NULL CHECK (source IN ('sandbox_fixture', 'ad_bank', 'provider')),
  description    text NOT NULL,
  rules          jsonb NOT NULL,
  checksum       text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purpose_codes (
  rule_set_version text NOT NULL REFERENCES preflight_rule_sets(version) ON DELETE CASCADE,
  code            text NOT NULL,
  label           text NOT NULL,
  -- The AD-bank / RBI purpose code. NULL until D-06 is answered with evidence;
  -- a sandbox fixture must not present a guess as a regulatory code.
  regulatory_code text,
  source          text NOT NULL CHECK (source IN ('sandbox_fixture', 'ad_bank', 'provider')),
  -- A purpose code belongs to the rule set that defined it. The same code may
  -- mean different things in two versions, so the version is part of its key.
  PRIMARY KEY (rule_set_version, code),
  -- The guard that keeps a simulator assumption from becoming regulatory truth:
  -- a sandbox fixture may not carry a regulatory code at all (D-06 is open).
  CONSTRAINT sandbox_fixture_has_no_regulatory_code
    CHECK (source <> 'sandbox_fixture' OR regulatory_code IS NULL)
);

-- ------------------------------------------------------ row-level security --

ALTER TABLE beneficiaries                ENABLE ROW LEVEL SECURITY;
ALTER TABLE beneficiaries                FORCE  ROW LEVEL SECURITY;
ALTER TABLE payout_destinations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_destinations          FORCE  ROW LEVEL SECURITY;
ALTER TABLE payout_destination_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_destination_versions  FORCE  ROW LEVEL SECURITY;
ALTER TABLE destination_verifications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE destination_verifications    FORCE  ROW LEVEL SECURITY;
ALTER TABLE provider_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_events              FORCE  ROW LEVEL SECURITY;

CREATE POLICY beneficiaries_tenant ON beneficiaries
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY payout_destinations_tenant ON payout_destinations
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY pdv_tenant ON payout_destination_versions
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY dv_tenant ON destination_verifications
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY provider_events_tenant ON provider_events
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

-- ------------------------------------------------- provider callback scope --

-- A provider callback arrives with no tenant context: it carries a verification
-- id the provider was given, and nothing else. Every table it must write is
-- RLS-scoped, so the ingest path has to learn the scope *before* it can set the
-- session GUCs — a chicken-and-egg that RLS cannot resolve on its own.
--
-- This function is the narrowest possible answer. It is SECURITY DEFINER and
-- returns two columns — the workspace and environment of one verification —
-- and no payout data of any kind. It cannot list, search or enumerate: the
-- caller must already hold the exact opaque id, which it only holds because the
-- provider echoed back an id we issued.
--
-- The alternative was a global raw-event table outside RLS, which would have
-- put provider payloads containing account data outside tenant isolation
-- entirely. This is the smaller hole, and it is auditable in one place.
CREATE FUNCTION resolve_verification_scope(p_verification_id text)
RETURNS TABLE (workspace_id text, environment environment)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $fn$
  SELECT v.workspace_id, v.environment
  FROM public.destination_verifications v
  WHERE v.id = p_verification_id;
$fn$;

REVOKE ALL ON FUNCTION resolve_verification_scope(text) FROM PUBLIC;

-- ------------------------------------------------------------------ grants --

-- No DELETE anywhere in this migration. A beneficiary or destination is
-- disabled, never removed: Stage 3 binds a settlement to a destination version,
-- and history that money was sent against cannot be deleted out from under it.
-- Verifications are the evidence for INV-11 and are equally permanent.
GRANT SELECT, INSERT, UPDATE ON
  beneficiaries, payout_destinations, destination_verifications
  TO inrsettle_app;

-- Versions accept INSERT and the one permitted UPDATE (superseded_at); the
-- trigger rejects everything else. DELETE is not granted at all.
GRANT SELECT, INSERT, UPDATE ON payout_destination_versions TO inrsettle_app;

-- Raw provider events are history: written once, never changed except to record
-- that they were interpreted.
GRANT SELECT, INSERT, UPDATE ON provider_events TO inrsettle_app;

-- Reference data is read-only to the application; it is loaded out of band by
-- the reference-data seeder, which connects as the migration role.
GRANT SELECT ON preflight_rule_sets, purpose_codes TO inrsettle_app;

GRANT EXECUTE ON FUNCTION resolve_verification_scope(text) TO inrsettle_app;

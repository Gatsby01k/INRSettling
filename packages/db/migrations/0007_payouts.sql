-- ============================================================================
-- 0007 — Stage 5: payout execution
--
-- Scope: DOMAIN.md § 6.7, STATE_MACHINES.md § 4 (T15–T18) and § 6.3 (P01–P08),
-- SECURITY.md § 4.2. Stage 3 built the payout attempt far enough to carry the
-- durable dispatch identity INV-36 requires; this migration gives it the
-- provider-facing facts it needs to actually execute — the rail it went out on,
-- the provider that carried it, and the raw code that came back.
--
-- No reconciliation, no SettlementReturn, no receipts. Those are Stage 6, and
-- `returned_at` below is the one column that anticipates them, because P08
-- (`CREDITED → RETURNED`) is already in the frozen payout table.
--
-- Enforced here rather than in application code:
--   INV-24  at most one non-terminal payout attempt per settlement
--   INV-25  a stable idempotency key per attempt, globally unique
--   INV-33  raw provider events persisted verbatim before interpretation
--   INV-43  a versioned mapping table is data; the taxonomy stays closed
-- ============================================================================

CREATE TYPE payout_rail AS ENUM ('NEFT', 'RTGS', 'IMPS', 'UPI');

ALTER TABLE payout_attempts
  ADD COLUMN provider_id      text,
  ADD COLUMN rail             payout_rail,
  ADD COLUMN amount_minor     bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  ADD COLUMN amount_currency  text,
  -- The provider's own code for whatever happened, stored unmapped. INV-43:
  -- interpretation is a separate, versioned step, and keeping the raw string
  -- means a mapping added next month can be applied to events from today.
  ADD COLUMN raw_code         text,
  ADD COLUMN mapping_version  text,
  ADD COLUMN submitted_at     timestamptz,
  ADD COLUMN credited_at      timestamptz,
  ADD COLUMN returned_at      timestamptz,
  -- Which SLA applies to this attempt, taken from the rail's declared
  -- capability at dispatch. Stored rather than looked up later because the
  -- provider may change its declaration, and the SLA an attempt was dispatched
  -- under is the one it should be judged by.
  ADD COLUMN sla_seconds      integer CHECK (sla_seconds IS NULL OR sla_seconds > 0);

-- A credited attempt has the evidence a credit requires. T16's frozen guard is
-- "UTR present and well-formed"; the well-formedness is the domain's job, but
-- "present" is checkable here and a CREDITED row without one is a receipt we
-- could not honour.
ALTER TABLE payout_attempts
  ADD CONSTRAINT payout_credit_has_utr CHECK (
    status <> 'CREDITED' OR (utr IS NOT NULL AND length(utr) > 0)
  ),
  ADD CONSTRAINT payout_credit_is_timed CHECK (
    status <> 'CREDITED' OR credited_at IS NOT NULL
  ),
  -- P08 is the only path to RETURNED, and it runs from CREDITED, so a returned
  -- attempt necessarily still carries its UTR and its credit timestamp.
  ADD CONSTRAINT payout_return_follows_credit CHECK (
    status <> 'RETURNED' OR (utr IS NOT NULL AND credited_at IS NOT NULL AND returned_at IS NOT NULL)
  );

-- The T18 sweeper's query: in flight, and past its own SLA.
CREATE INDEX payout_attempts_sla_idx
  ON payout_attempts (dispatched_at)
  WHERE status IN ('SUBMITTED', 'ACCEPTED');

-- ---------------------------------------------- provider mapping tables --
--
-- INV-43: "a versioned, provider-specific mapping table, which is data, not
-- code". Same discipline as the Stage 2 preflight rule sets, and for the same
-- reason: `source` records where a row came from, so a sandbox fixture can
-- never be mistaken for a real provider's documented contract.

CREATE TABLE provider_mapping_tables (
  version        text PRIMARY KEY,
  provider_id    text NOT NULL,
  source         text NOT NULL CHECK (source IN ('sandbox_fixture', 'provider_documentation', 'provider_contract')),
  description    text NOT NULL,
  codes          jsonb NOT NULL,
  checksum       text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provider_mapping_tables_active_idx
  ON provider_mapping_tables (provider_id, effective_from DESC);

-- Reference data is global, not tenant-scoped: the same table interprets every
-- workspace's events, exactly as the preflight rule sets do.
GRANT SELECT ON provider_mapping_tables TO inrsettle_app;

-- ------------------------------------------------------- provider events --
--
-- `provider_events` already exists from Stage 2 with the columns INV-33 needs:
-- the raw payload, the signature verdict, and a unique index on
-- (provider_id, provider_event_id) that makes redelivery a no-op.
--
-- What Stage 5 adds is the link back to what the event was *about*, so an
-- operator looking at a settlement can see every provider event that touched
-- it without a full-table scan of a jsonb column.

ALTER TABLE provider_events
  ADD COLUMN subject_type text,
  ADD COLUMN subject_id   text,
  -- Set when interpretation could not map the provider's vocabulary. This is
  -- the alarm INV-43 requires, made queryable: `WHERE unmapped_code IS NOT
  -- NULL` is the operational view of "codes we have never seen".
  ADD COLUMN unmapped_code text;

CREATE INDEX provider_events_subject_idx
  ON provider_events (subject_type, subject_id, received_at DESC);
CREATE INDEX provider_events_unmapped_idx
  ON provider_events (provider_id, received_at DESC) WHERE unmapped_code IS NOT NULL;

-- Interpretation writes back to the event row it just interpreted, so the app
-- role needs UPDATE. The append-only guarantee INV-33 cares about is over the
-- *payload* and the signature verdict, not the interpretation fields, so the
-- trigger below freezes exactly the former.
CREATE OR REPLACE FUNCTION protect_provider_event() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.provider_id       IS DISTINCT FROM OLD.provider_id
  OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
  OR NEW.event_type        IS DISTINCT FROM OLD.event_type
  OR NEW.payload           IS DISTINCT FROM OLD.payload
  OR NEW.signature_valid   IS DISTINCT FROM OLD.signature_valid
  OR NEW.received_at       IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION
      'provider event % is stored verbatim and its payload and signature verdict are immutable (INV-33)',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER provider_events_protect
  BEFORE UPDATE ON provider_events
  FOR EACH ROW EXECUTE FUNCTION protect_provider_event();

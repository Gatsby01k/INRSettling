-- ============================================================================
-- 0006 — Stage 4: liquidity facilities, reservations, drawdowns, repayments,
--        and the double-entry ledger they all post to
--
-- Scope: DOMAIN.md § 6.6, STATE_MACHINES.md § 6.2 (V01–V04) and § 6.5 (Y01–Y08).
-- No payout provider execution, no reconciliation, no receipts, no returns —
-- those belong to the stages that own them.
--
-- Enforced here rather than in application code, because TypeScript is not a
-- security boundary:
--   INV-19  available = limit − drawn − reserved, and available >= 0 always
--   INV-20  reservation is atomic under the facility row lock
--   INV-21  a settlement holds at most one ACTIVE reservation
--   INV-22  release applies only to an ACTIVE reservation; CONSUMED has no
--           release path, and attempting one is an error rather than a no-op
--   INV-23  every movement of facility value is a balanced double-entry pair in
--           an append-only ledger; drawn and reserved are projections of it
--   INV-31  tenant isolation by RLS on workspace_id AND environment
--   INV-46  capacity returns on a CONFIRMED repayment and on nothing else
--   INV-47  repayment UNKNOWN resolves by status pull, never by resubmission
-- ============================================================================

CREATE TYPE facility_status     AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE reservation_status  AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');
CREATE TYPE drawdown_status     AS ENUM ('REQUESTED', 'CONFIRMED', 'FAILED', 'UNKNOWN');
CREATE TYPE repayment_status    AS ENUM ('REQUESTED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN');
CREATE TYPE repayment_source    AS ENUM (
  'CANCELLATION_AFTER_DRAWDOWN', 'SETTLEMENT_RETURN', 'MANUAL', 'SCHEDULED');
CREATE TYPE ledger_account      AS ENUM ('available', 'reserved', 'drawn');
CREATE TYPE ledger_direction    AS ENUM ('debit', 'credit');
CREATE TYPE ledger_movement     AS ENUM (
  'reservation_created', 'reservation_released', 'reservation_expired',
  'reservation_consumed', 'repayment_confirmed', 'limit_changed');

-- ------------------------------------------------------------- facilities --

CREATE TABLE liquidity_facilities (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment         environment NOT NULL,
  provider_id         text NOT NULL,
  currency            text NOT NULL CHECK (currency = upper(currency)),
  -- INV-02: money is BIGINT minor units beside a currency column, never NUMERIC.
  -- One currency governs the limit, the drawn figure and the reserved figure.
  -- They are subtracted from each other, so they cannot differ; a per-column
  -- currency would be three places for one fact to disagree.
  limit_minor         bigint NOT NULL CHECK (limit_minor >= 0),
  status              facility_status NOT NULL DEFAULT 'ACTIVE',

  -- Projections of the ledger (INV-23), maintained transactionally. They are a
  -- cache of `project_facility_position()` below, and the rebuild test asserts
  -- they agree with it. The ledger is the source of truth; if the two ever
  -- disagree the ledger wins and an alarm fires.
  drawn_minor         bigint NOT NULL DEFAULT 0 CHECK (drawn_minor >= 0),
  reserved_minor      bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 0,

  -- INV-19, as a database fact rather than an application convention. This is
  -- the constraint that makes over-allocation impossible even if every line of
  -- TypeScript above it were wrong.
  CONSTRAINT facility_availability_non_negative
    CHECK (limit_minor - drawn_minor - reserved_minor >= 0)
);

CREATE INDEX liquidity_facilities_scope_idx
  ON liquidity_facilities (workspace_id, environment);

-- The referent for the composite foreign keys below. Every table that carries
-- an amount against a facility points at *this* key rather than at `id` alone,
-- which makes "same facility, same tenant, same currency" a referential fact
-- rather than four application checks that must all be remembered.
ALTER TABLE liquidity_facilities
  ADD CONSTRAINT liquidity_facilities_scope_key
  UNIQUE (id, workspace_id, environment, currency);

-- Deliberately **not** a unique index on (workspace_id, environment, currency).
--
-- The customer sees a single *Available to settle* figure, so it is tempting to
-- enforce a single facility. But nothing in the frozen documents says a
-- workspace has one facility, and a plausible real case breaks it immediately:
-- migrating between liquidity providers means running two facilities in the
-- same currency for a while. Presenting one figure is the surface's job
-- (`PRODUCT.md § 9`), not a reason to make the second facility unrepresentable.
CREATE INDEX liquidity_facilities_currency_idx
  ON liquidity_facilities (workspace_id, environment, currency)
  WHERE status = 'ACTIVE';

-- ----------------------------------------------------------- reservations --

CREATE TABLE liquidity_reservations (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment         environment NOT NULL,
  facility_id         text NOT NULL REFERENCES liquidity_facilities(id),
  settlement_id       text NOT NULL REFERENCES settlements(id),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  amount_currency     text NOT NULL,
  status              reservation_status NOT NULL DEFAULT 'ACTIVE',
  -- D-05: the TTL *mechanism* is closed and lives here; the *duration* is
  -- supplied by configuration and is not compiled in anywhere.
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  released_at         timestamptz,
  released_reason     text,
  consumed_at         timestamptz,

  -- A released or expired reservation says when and why; a consumed one says
  -- when. Neither is optional, because an unattributed release is how a
  -- facility quietly gains capacity nobody can account for.
  CONSTRAINT reservation_release_is_attributed CHECK (
    (status NOT IN ('RELEASED', 'EXPIRED'))
    OR (released_at IS NOT NULL AND released_reason IS NOT NULL AND length(released_reason) > 0)
  ),
  CONSTRAINT reservation_consumption_is_timed CHECK (
    status <> 'CONSUMED' OR consumed_at IS NOT NULL
  ),
  -- The facility must be this tenant's, and the amount must be in the
  -- facility's currency. Both, as one referential fact.
  FOREIGN KEY (facility_id, workspace_id, environment, amount_currency)
    REFERENCES liquidity_facilities (id, workspace_id, environment, currency)
);

-- INV-21, exactly as the invariant words it.
CREATE UNIQUE INDEX liquidity_reservations_one_active
  ON liquidity_reservations (settlement_id) WHERE status = 'ACTIVE';
CREATE INDEX liquidity_reservations_facility_idx
  ON liquidity_reservations (facility_id, status);
CREATE INDEX liquidity_reservations_scope_idx
  ON liquidity_reservations (workspace_id, environment);
-- The sweeper's query: ACTIVE and past its TTL.
CREATE INDEX liquidity_reservations_expiring_idx
  ON liquidity_reservations (expires_at) WHERE status = 'ACTIVE';

-- INV-22, at the database.
--
-- The invariant is unusually specific about the failure mode it wants: an
-- attempt to release a CONSUMED reservation must be "a typed error, not a
-- no-op, so a mistaken code path fails loudly instead of silently
-- double-crediting the facility". A trigger is how that survives a code path
-- nobody reviewed — a later stage's return handler, an ops script, a fix
-- applied at 3am.
CREATE OR REPLACE FUNCTION protect_reservation_row() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.facility_id     IS DISTINCT FROM OLD.facility_id
  OR NEW.settlement_id   IS DISTINCT FROM OLD.settlement_id
  OR NEW.amount_minor    IS DISTINCT FROM OLD.amount_minor
  OR NEW.amount_currency IS DISTINCT FROM OLD.amount_currency
  OR NEW.created_at      IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'reservation % identity and amount are immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'CONSUMED' AND NEW.status IS DISTINCT FROM 'CONSUMED' THEN
    RAISE EXCEPTION
      'reservation % is CONSUMED and has no release path; capacity returns only through a CONFIRMED repayment (INV-22, INV-46)',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('RELEASED', 'EXPIRED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'reservation % is already %, and does not change again', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER liquidity_reservations_protect
  BEFORE UPDATE ON liquidity_reservations
  FOR EACH ROW EXECUTE FUNCTION protect_reservation_row();

-- -------------------------------------------------------------- drawdowns --

CREATE TABLE drawdowns (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment         environment NOT NULL,
  facility_id         text NOT NULL REFERENCES liquidity_facilities(id),
  settlement_id       text NOT NULL REFERENCES settlements(id),
  reservation_id      text NOT NULL REFERENCES liquidity_reservations(id),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  amount_currency     text NOT NULL,
  status              drawdown_status NOT NULL DEFAULT 'REQUESTED',
  -- Stable per drawdown, never per call: a retry presents the same key.
  request_fingerprint text NOT NULL,
  provider_reference  text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  requested_by        text NOT NULL,
  confirmed_at        timestamptz,
  failed_at           timestamptz,
  UNIQUE (request_fingerprint),
  FOREIGN KEY (facility_id, workspace_id, environment, amount_currency)
    REFERENCES liquidity_facilities (id, workspace_id, environment, currency)
);

-- At most one non-terminal drawdown per settlement, for the same reason a
-- settlement has at most one in-flight payout attempt: two funding legs in
-- flight is two chances to move real money for one settlement.
CREATE UNIQUE INDEX drawdowns_one_in_flight
  ON drawdowns (settlement_id) WHERE status NOT IN ('CONFIRMED', 'FAILED');
CREATE INDEX drawdowns_scope_idx ON drawdowns (workspace_id, environment);

CREATE OR REPLACE FUNCTION protect_drawdown_row() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.facility_id         IS DISTINCT FROM OLD.facility_id
  OR NEW.settlement_id       IS DISTINCT FROM OLD.settlement_id
  OR NEW.reservation_id      IS DISTINCT FROM OLD.reservation_id
  OR NEW.amount_minor        IS DISTINCT FROM OLD.amount_minor
  OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint THEN
    RAISE EXCEPTION 'drawdown % identity is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('CONFIRMED', 'FAILED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'drawdown % is terminal (%) and cannot move to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER drawdowns_protect
  BEFORE UPDATE ON drawdowns FOR EACH ROW EXECUTE FUNCTION protect_drawdown_row();

-- ------------------------------------------------------------- repayments --

CREATE TABLE repayments (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment         environment NOT NULL,
  facility_id         text NOT NULL REFERENCES liquidity_facilities(id),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  amount_currency     text NOT NULL,
  source              repayment_source NOT NULL,
  settlement_id       text REFERENCES settlements(id),
  return_id           text,
  status              repayment_status NOT NULL DEFAULT 'REQUESTED',
  -- INV-47: the key an authoritative status pull presents. Y08 mints a new one
  -- by advancing `attempt`, which is what makes a re-request a *new*
  -- submission rather than a second send of the same one.
  attempt             integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  request_fingerprint text NOT NULL,
  provider_reference  text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at        timestamptz,
  confirmed_at        timestamptz,
  failed_at           timestamptz,
  UNIQUE (request_fingerprint),
  UNIQUE (id, attempt),
  FOREIGN KEY (facility_id, workspace_id, environment, amount_currency)
    REFERENCES liquidity_facilities (id, workspace_id, environment, currency),

  -- A repayment attributable to a settlement or a return names it. MANUAL and
  -- SCHEDULED are the two that legitimately name neither.
  CONSTRAINT repayment_source_is_attributed CHECK (
    (source = 'CANCELLATION_AFTER_DRAWDOWN' AND settlement_id IS NOT NULL)
    OR (source = 'SETTLEMENT_RETURN' AND return_id IS NOT NULL)
    OR source IN ('MANUAL', 'SCHEDULED')
  ),
  CONSTRAINT repayment_confirmation_is_timed CHECK (
    status <> 'CONFIRMED' OR confirmed_at IS NOT NULL
  )
);

CREATE INDEX repayments_facility_idx ON repayments (facility_id, status);
CREATE INDEX repayments_scope_idx ON repayments (workspace_id, environment);
-- Operations' `repayment_in_flight` view: value the facility has not got back.
CREATE INDEX repayments_in_flight_idx
  ON repayments (facility_id) WHERE status IN ('REQUESTED', 'SUBMITTED', 'UNKNOWN');

-- At most one *live* repayment per settlement.
--
-- A settlement's funding is drawn once, so it is repaid once. Two live
-- repayments against one settlement is the shape a double restoration takes:
-- two rows, each individually valid, each confirming, each posting a
-- capacity-restoring movement for money that only went out once.
--
-- `FAILED` is excluded because Y08 exists — a failed attempt may be
-- re-requested, and that reuses this same row rather than adding one. A failed
-- row therefore cannot combine with a later request to produce a second
-- restoration: whichever path is live, there is exactly one of it.
CREATE UNIQUE INDEX repayments_one_live_per_settlement
  ON repayments (settlement_id)
  WHERE settlement_id IS NOT NULL AND status <> 'FAILED';

CREATE OR REPLACE FUNCTION protect_repayment_row() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.facility_id  IS DISTINCT FROM OLD.facility_id
  OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
  OR NEW.source       IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'repayment % identity and amount are immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- CONFIRMED is terminal outright. FAILED is terminal for *this attempt* and
  -- permits Y08, which is why it is not listed here.
  IF OLD.status = 'CONFIRMED' AND NEW.status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION
      'repayment % is CONFIRMED; capacity has already been restored and cannot be restored twice (INV-46)',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- INV-47, as a database fact: a re-request must present a *new* fingerprint.
  -- Reusing one is how a repayment is submitted twice and a facility is
  -- credited for money that came back once.
  IF OLD.status = 'FAILED' AND NEW.status = 'REQUESTED' THEN
    IF NEW.attempt <= OLD.attempt THEN
      RAISE EXCEPTION
        'a re-requested repayment (Y08) needs a new attempt number, got % after %', NEW.attempt, OLD.attempt
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.request_fingerprint = OLD.request_fingerprint THEN
      RAISE EXCEPTION
        'a re-requested repayment (Y08) needs a new request_fingerprint, never a resubmission of the old one (INV-47)'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint THEN
    RAISE EXCEPTION 'repayment % fingerprint changes only on a re-request (Y08)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER repayments_protect
  BEFORE UPDATE ON repayments FOR EACH ROW EXECUTE FUNCTION protect_repayment_row();

-- ==========================================================================
-- INV-23 — the double-entry ledger
--
-- "Every movement of facility value is a double-entry pair in an append-only
--  ledger_entries table. drawn and reserved on the facility are projections of
--  the ledger and are rebuildable from it. If the projection and the ledger
--  disagree, the ledger wins and an operational alarm fires."
-- ==========================================================================

CREATE TABLE ledger_entries (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment     environment NOT NULL,
  facility_id     text NOT NULL REFERENCES liquidity_facilities(id),
  -- The two rows of one movement share this. It is what makes a half-written
  -- movement detectable rather than merely unlikely.
  transfer_id     text NOT NULL,
  movement        ledger_movement NOT NULL,
  account         ledger_account NOT NULL,
  direction       ledger_direction NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  amount_currency text NOT NULL,
  -- What caused it, so an entry can be traced back to a settlement or a
  -- repayment without joining through three tables.
  subject_type    text NOT NULL,
  subject_id      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,
  UNIQUE (transfer_id, account),
  FOREIGN KEY (facility_id, workspace_id, environment, amount_currency)
    REFERENCES liquidity_facilities (id, workspace_id, environment, currency)
);

CREATE INDEX ledger_entries_facility_idx ON ledger_entries (facility_id, created_at);
CREATE INDEX ledger_entries_scope_idx ON ledger_entries (workspace_id, environment);
CREATE INDEX ledger_entries_subject_idx ON ledger_entries (subject_type, subject_id);

-- Append-only. Not "we do not update it" — it cannot be updated, by anyone.
CREATE OR REPLACE FUNCTION ledger_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (INV-23); % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- A movement is a *balanced pair*: exactly two rows, one debit and one credit,
-- same amount, same currency. Checked as a DEFERRABLE CONSTRAINT TRIGGER so it
-- fires at COMMIT — the second row of a pair cannot exist when the first is
-- written, and checking early would forbid the only correct way to write one.
CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  rows_in_transfer integer;
  debits           integer;
  credits          integer;
  net              bigint;
  currencies       integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE direction = 'debit'),
         count(*) FILTER (WHERE direction = 'credit'),
         sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END),
         count(DISTINCT amount_currency)
    INTO rows_in_transfer, debits, credits, net, currencies
  FROM ledger_entries WHERE transfer_id = NEW.transfer_id;

  IF rows_in_transfer <> 2 OR debits <> 1 OR credits <> 1 THEN
    RAISE EXCEPTION
      'ledger transfer % has % entries (% debit, % credit); a movement is exactly one of each (INV-23)',
      NEW.transfer_id, rows_in_transfer, debits, credits
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF net <> 0 THEN
    RAISE EXCEPTION 'ledger transfer % does not balance: net %', NEW.transfer_id, net
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF currencies <> 1 THEN
    RAISE EXCEPTION 'ledger transfer % mixes currencies', NEW.transfer_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- The projection, as a function, so the rebuild test and the alarm ask the same
-- question of the same code rather than two implementations that agree today.
CREATE OR REPLACE FUNCTION project_facility_position(fid text)
RETURNS TABLE (drawn_minor bigint, reserved_minor bigint)
LANGUAGE sql STABLE AS $fn$
  SELECT
    COALESCE(sum(CASE WHEN account = 'drawn'
                      THEN CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END
                 END), 0)::bigint,
    COALESCE(sum(CASE WHEN account = 'reserved'
                      THEN CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END
                 END), 0)::bigint
  FROM ledger_entries WHERE facility_id = fid;
$fn$;

-- ------------------------------------------------------ facility protection --

CREATE OR REPLACE FUNCTION protect_facility_row() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'facility % currency is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A CLOSED facility is finished. Reopening one would resurrect a position
  -- whose ledger has already been reconciled and signed off.
  IF OLD.status = 'CLOSED' AND NEW.status IS DISTINCT FROM 'CLOSED' THEN
    RAISE EXCEPTION 'facility % is CLOSED and does not reopen', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A facility cannot be closed while it still holds value. Closing one with
  -- an outstanding drawdown would strand a repayment with nowhere to post.
  IF NEW.status = 'CLOSED' AND (NEW.drawn_minor <> 0 OR NEW.reserved_minor <> 0) THEN
    RAISE EXCEPTION
      'facility % cannot close with % drawn and % reserved', OLD.id, NEW.drawn_minor, NEW.reserved_minor
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.drawn_minor    IS DISTINCT FROM OLD.drawn_minor
  OR NEW.reserved_minor IS DISTINCT FROM OLD.reserved_minor
  OR NEW.limit_minor    IS DISTINCT FROM OLD.limit_minor
  OR NEW.status         IS DISTINCT FROM OLD.status THEN
    NEW.version    := OLD.version + 1;
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER liquidity_facilities_protect
  BEFORE UPDATE ON liquidity_facilities
  FOR EACH ROW EXECUTE FUNCTION protect_facility_row();

-- ------------------------------------------------------ row-level security --

ALTER TABLE liquidity_facilities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE liquidity_facilities   FORCE  ROW LEVEL SECURITY;
ALTER TABLE liquidity_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE liquidity_reservations FORCE  ROW LEVEL SECURITY;
ALTER TABLE drawdowns              ENABLE ROW LEVEL SECURITY;
ALTER TABLE drawdowns              FORCE  ROW LEVEL SECURITY;
ALTER TABLE repayments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE repayments             FORCE  ROW LEVEL SECURITY;
ALTER TABLE ledger_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries         FORCE  ROW LEVEL SECURITY;

CREATE POLICY liquidity_facilities_tenant ON liquidity_facilities
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY liquidity_reservations_tenant ON liquidity_reservations
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY drawdowns_tenant ON drawdowns
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY repayments_tenant ON repayments
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY ledger_entries_tenant ON ledger_entries
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

-- ------------------------------------------------------------------ grants --

-- No DELETE anywhere: a facility, a reservation, a drawdown and a repayment are
-- all records of value that moved or was committed, and none of them is undone
-- by removing the row.
GRANT SELECT, INSERT, UPDATE ON liquidity_facilities, liquidity_reservations, drawdowns, repayments
  TO inrsettle_app;
-- The ledger takes inserts and nothing else. The trigger above refuses UPDATE
-- and DELETE even where they are granted; withholding them too means a mistake
-- fails at the grant rather than at the trigger, one layer earlier.
GRANT SELECT, INSERT ON ledger_entries TO inrsettle_app;
GRANT EXECUTE ON FUNCTION project_facility_position(text) TO inrsettle_app;

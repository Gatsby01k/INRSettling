-- ============================================================================
-- 0005 — Stage 3: quotes, settlements, the transition machine, exceptions
--
-- Scope: DOMAIN.md § 6.4 (quote) and § 6.5 (settlement), STATE_MACHINES.md § 4.
-- No liquidity facility, no payout provider execution, no reconciliation, no
-- receipts, no batches — those belong to the stages that own them. The payout
-- attempt table exists only far enough to carry the durable dispatch identity
-- INV-36 requires; it holds no provider response.
--
-- Enforced here rather than in application code, because TypeScript is not a
-- security boundary:
--   INV-13  a quote is immutable once created
--   INV-14  a quote is consumed by at most one settlement
--   INV-16  the instruction is immutable from AUTHORIZED onward
--   INV-31  tenant isolation by RLS on workspace_id AND environment
--   INV-32  exactly one status event per status-changing transaction
--   INV-38  SETTLED / FAILED / CANCELLED accept no field writes at all
-- ============================================================================

-- The pairing rule counts the status events written *by this transaction*, so
-- events must record which transaction wrote them. `pg_current_xact_id()` is
-- assigned at insert; every event insert is a write, so this forces no extra
-- transaction ids into existence.
ALTER TABLE events ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX events_txid_idx ON events (txid, subject_type, subject_id);

CREATE TYPE quote_status AS ENUM ('ACTIVE', 'LOCKED', 'CONSUMED', 'EXPIRED', 'VOID');
CREATE TYPE quote_direction AS ENUM ('RECIPIENT_FIRST', 'SOURCE_FIRST');

CREATE TYPE settlement_status AS ENUM (
  'DRAFT', 'PREFLIGHTING', 'ACTION_REQUIRED', 'READY', 'QUOTED', 'AUTHORIZED',
  'LIQUIDITY_RESERVING', 'LIQUIDITY_RESERVED', 'DRAWDOWN_REQUESTED', 'DRAWDOWN_CONFIRMED',
  'PAYOUT_SUBMITTED', 'PAYOUT_CONFIRMED', 'RECONCILING', 'EXCEPTION',
  'SETTLED', 'FAILED', 'CANCELLED'
);

CREATE TYPE customer_status AS ENUM ('READY', 'SETTLING', 'SETTLED', 'ACTION_REQUIRED', 'CANCELLED');

-- The closed taxonomy (STATE_MACHINES.md § 7). No OTHER, by construction:
-- adding a value here is a migration, which is the point.
CREATE TYPE settlement_exception_code AS ENUM (
  'LIQUIDITY_UNAVAILABLE', 'FACILITY_SUSPENDED',
  'DRAWDOWN_FAILED', 'DRAWDOWN_STATUS_UNKNOWN',
  'PAYOUT_REJECTED_DESTINATION', 'PAYOUT_REJECTED_COMPLIANCE',
  'PAYOUT_REJECTED_PROVIDER', 'PAYOUT_STATUS_UNKNOWN',
  'RECONCILIATION_MISMATCH', 'FINALITY_EVIDENCE_MISSING'
);

-- ----------------------------------------------------------------- quotes --

-- INV-13: immutable once created. Only the lifecycle columns move, and the
-- trigger below rejects any write to the priced fields.
CREATE TABLE quotes (
  id                       text PRIMARY KEY,
  workspace_id             text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment              environment NOT NULL,
  direction                quote_direction NOT NULL,

  -- INV-01/INV-02: money is (BIGINT minor, TEXT currency). Never NUMERIC.
  recipient_amount_minor    bigint NOT NULL CHECK (recipient_amount_minor >= 0),
  recipient_amount_currency text NOT NULL CHECK (recipient_amount_currency = 'INR'),
  funding_amount_minor      bigint NOT NULL CHECK (funding_amount_minor >= 0),
  funding_amount_currency   text NOT NULL,

  -- NUMERIC(28,10) is the frozen storage for a rate (DOMAIN.md § 3.2). It is a
  -- rate, not money, so the money-column rule does not apply to it.
  fx_rate_scaled           numeric(28,10) NOT NULL CHECK (fx_rate_scaled > 0),
  fx_pair                  text NOT NULL,
  fx_quoted_at             timestamptz NOT NULL,
  fx_source                text NOT NULL,

  fee_components           jsonb NOT NULL DEFAULT '[]'::jsonb,
  rounding_residual        jsonb NOT NULL,
  estimated_delivery       text NOT NULL,
  pricing_version          text NOT NULL,

  status                   quote_status NOT NULL DEFAULT 'ACTIVE',
  expires_at               timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               text NOT NULL,
  locked_at                timestamptz,
  consumed_by_settlement_id text
);

CREATE INDEX quotes_scope_idx ON quotes (workspace_id, environment, created_at DESC);
CREATE INDEX quotes_expiry_idx ON quotes (expires_at) WHERE status IN ('ACTIVE', 'LOCKED');

-- INV-14: at most one settlement per quote. A partial unique index rather than
-- a plain UNIQUE so that the many NULLs of unconsumed quotes cost nothing.
CREATE UNIQUE INDEX quotes_single_consumption
  ON quotes (consumed_by_settlement_id)
  WHERE consumed_by_settlement_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_quote_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.workspace_id              IS DISTINCT FROM OLD.workspace_id
  OR NEW.environment               IS DISTINCT FROM OLD.environment
  OR NEW.direction                 IS DISTINCT FROM OLD.direction
  OR NEW.recipient_amount_minor    IS DISTINCT FROM OLD.recipient_amount_minor
  OR NEW.recipient_amount_currency IS DISTINCT FROM OLD.recipient_amount_currency
  OR NEW.funding_amount_minor      IS DISTINCT FROM OLD.funding_amount_minor
  OR NEW.funding_amount_currency   IS DISTINCT FROM OLD.funding_amount_currency
  OR NEW.fx_rate_scaled            IS DISTINCT FROM OLD.fx_rate_scaled
  OR NEW.fx_pair                   IS DISTINCT FROM OLD.fx_pair
  OR NEW.fee_components            IS DISTINCT FROM OLD.fee_components
  OR NEW.rounding_residual         IS DISTINCT FROM OLD.rounding_residual
  OR NEW.expires_at                IS DISTINCT FROM OLD.expires_at
  OR NEW.created_at                IS DISTINCT FROM OLD.created_at
  OR NEW.pricing_version           IS DISTINCT FROM OLD.pricing_version
  THEN
    RAISE EXCEPTION
      'a quote is immutable once created; re-pricing creates a new quote (INV-13)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A terminal quote does not move again.
  IF OLD.status IN ('CONSUMED', 'EXPIRED', 'VOID')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'quote % is already %, and has no outgoing transition', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Consumption is write-once.
  IF OLD.consumed_by_settlement_id IS NOT NULL
     AND NEW.consumed_by_settlement_id IS DISTINCT FROM OLD.consumed_by_settlement_id THEN
    RAISE EXCEPTION 'quote % is already consumed by % (INV-14)',
      OLD.id, OLD.consumed_by_settlement_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER quotes_immutable
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION reject_quote_mutation();

-- ------------------------------------------------------------ settlements --

CREATE TABLE settlements (
  id                       text PRIMARY KEY,
  workspace_id             text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment              environment NOT NULL,

  beneficiary_id           text NOT NULL REFERENCES beneficiaries(id),
  destination_id           text REFERENCES payout_destinations(id),
  -- Frozen at authorization to the exact version that passed INV-11. What
  -- payout executes against; never destination.current_version_id.
  destination_version_id   text REFERENCES payout_destination_versions(id),

  recipient_amount_minor    bigint NOT NULL CHECK (recipient_amount_minor > 0),
  recipient_amount_currency text NOT NULL CHECK (recipient_amount_currency = 'INR'),
  funding_currency          text NOT NULL,
  purpose_code              text,

  quote_id                 text REFERENCES quotes(id),
  authorized_terms         jsonb,
  authorized_terms_hash    text,

  status                   settlement_status NOT NULL DEFAULT 'DRAFT',
  -- Derived, never independently set (INV-18). Nullable because DRAFT has no
  -- customer status: drafts appear only in the composing surface.
  customer_status          customer_status,
  -- The T22 resume target. Constrained to exactly the states the frozen table
  -- can enter EXCEPTION *from* (T11, T14, T17, T18, T21, T28, T29, T30), so a
  -- resume can never land on a terminal state, on ACTION_REQUIRED (which is
  -- preflight-only, INV-37), or on a pre-execution state. Derived from the
  -- transition table rather than chosen: a domain test asserts this list equals
  -- the set of `from` states of every transition whose `to` is EXCEPTION.
  exception_entered_from   settlement_status
    CHECK (exception_entered_from IS NULL OR exception_entered_from IN (
      'LIQUIDITY_RESERVING', 'LIQUIDITY_RESERVED',
      'DRAWDOWN_REQUESTED', 'PAYOUT_SUBMITTED', 'RECONCILING'
    )),
  open_exception_code      settlement_exception_code,

  external_reference       text,
  idempotency_key          text,
  replaces_settlement_id   text REFERENCES settlements(id),

  authorized_at            timestamptz,
  authorized_by            text,
  cancellation_requested_at timestamptz,
  cancellation_requested_by text,
  -- Stamped by the dispatch transaction (INV-36); never cleared.
  point_of_no_return_at    timestamptz,
  settled_at               timestamptz,

  -- Stage 4/5/6 pointers. Declared because the settlement carries them; no
  -- table exists for most of them yet, so no foreign key is claimed.
  reservation_id           text,
  drawdown_id              text,
  payout_attempt_id        text,
  receipt_id               text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               text NOT NULL,
  -- Optimistic concurrency. Bumped by the transition trigger, not by callers.
  version                  integer NOT NULL DEFAULT 1
);

CREATE INDEX settlements_scope_idx ON settlements (workspace_id, environment, created_at DESC);
CREATE INDEX settlements_status_idx ON settlements (workspace_id, environment, status);
CREATE INDEX settlements_beneficiary_idx ON settlements (beneficiary_id);
-- The reverse of replaces_settlement_id is *derived* from this index, never
-- stored on the terminal original (INV-38).
CREATE INDEX settlements_replaces_idx ON settlements (replaces_settlement_id)
  WHERE replaces_settlement_id IS NOT NULL;
CREATE UNIQUE INDEX settlements_idempotency
  ON settlements (workspace_id, environment, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX settlements_external_reference
  ON settlements (workspace_id, external_reference)
  WHERE external_reference IS NOT NULL;
-- The other half of INV-14, from the settlement side.
CREATE UNIQUE INDEX settlements_quote_once
  ON settlements (quote_id) WHERE quote_id IS NOT NULL;

-- ------------------------------------------------- payout attempt (intent) --

-- INV-36(c): once the dispatch transaction commits, a durable PayoutAttempt
-- with a stable provider idempotency key exists, so a payout may exist at the
-- provider whatever the local call reported.
--
-- Stage 3 creates the *intent* and nothing else. There are no provider
-- response columns here on purpose: Stage 5 owns the adapter, and inventing
-- its fields now would be guessing at an interface nobody has agreed.
CREATE TYPE payout_attempt_status AS ENUM (
  'SUBMITTED', 'ACCEPTED', 'CREDITED', 'REJECTED', 'RETURNED', 'UNKNOWN'
);

CREATE TABLE payout_attempts (
  id                   text PRIMARY KEY,
  workspace_id         text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment          environment NOT NULL,
  settlement_id        text NOT NULL REFERENCES settlements(id),
  destination_version_id text NOT NULL REFERENCES payout_destination_versions(id),
  -- INV-24: a settlement may have several attempts over its life. The number is
  -- explicit and monotonic per settlement; it is the only thing that advances a
  -- payout identity.
  attempt_number       integer NOT NULL CHECK (attempt_number >= 1),
  status               payout_attempt_status NOT NULL DEFAULT 'SUBMITTED',
  -- INV-25: derived from settlement_id + attempt_number and nothing else.
  --
  -- Deriving it from the authorized-terms hash instead would be wrong twice
  -- over: the hash is constant for the life of a settlement, so two legitimate
  -- attempts would present the same key and a provider honouring idempotency
  -- would return the first attempt's result for the second — a payout that
  -- looks sent and never was. And a *change* to the terms would mint a new key,
  -- making an instruction edit a way to conjure a second real payout.
  idempotency_key      text NOT NULL,
  provider_reference   text,
  utr                  text,
  dispatched_at        timestamptz NOT NULL DEFAULT now(),
  dispatched_by        text NOT NULL,
  resolved_at          timestamptz,
  UNIQUE (settlement_id, attempt_number)
);

-- INV-24, as a database fact rather than a convention: historical terminal
-- attempts are permitted, two simultaneous non-terminal attempts are not.
-- UNKNOWN counts as non-terminal on purpose — it means "we do not know whether
-- money moved", and letting a second attempt start there is how a settlement
-- pays twice.
CREATE UNIQUE INDEX payout_attempts_one_in_flight
  ON payout_attempts (settlement_id)
  WHERE status NOT IN ('CREDITED', 'REJECTED', 'RETURNED');

-- The key is globally unique, so a collision across settlements is impossible
-- and a resubmission is recognisable as the same submission.
CREATE UNIQUE INDEX payout_attempts_idempotency_key ON payout_attempts (idempotency_key);
CREATE INDEX payout_attempts_scope_idx ON payout_attempts (workspace_id, environment);

-- The attempt's own identity is immutable; only its status and the provider's
-- answers may be written after dispatch.
CREATE OR REPLACE FUNCTION protect_payout_attempt() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.settlement_id   IS DISTINCT FROM OLD.settlement_id
  OR NEW.attempt_number  IS DISTINCT FROM OLD.attempt_number
  OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  OR NEW.destination_version_id IS DISTINCT FROM OLD.destination_version_id
  OR NEW.dispatched_at   IS DISTINCT FROM OLD.dispatched_at
  THEN
    RAISE EXCEPTION
      'payout attempt % identity is immutable (INV-25)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('CREDITED', 'REJECTED', 'RETURNED')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'CREDITED' AND NEW.status = 'RETURNED') THEN
    RAISE EXCEPTION
      'payout attempt % is terminal (%) and cannot move to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER payout_attempts_protect
  BEFORE UPDATE ON payout_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_payout_attempt();

-- -------------------------------------------------- settlement exceptions --

CREATE TABLE settlement_exceptions (
  id                   text PRIMARY KEY,
  workspace_id         text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment          environment NOT NULL,
  settlement_id        text NOT NULL REFERENCES settlements(id),
  code                 settlement_exception_code NOT NULL,
  entered_from         settlement_status NOT NULL,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  -- Set only by the provider layer for an unmapped provider input.
  provider_raw_code    text,
  provider_raw_message text,
  provider_event_id    text,
  classification       text CHECK (classification IS NULL OR classification = 'unmapped'),
  resolved_at          timestamptz,
  resolved_by          text,
  -- Mandatory on resolution (STATE_MACHINES.md § 7).
  resolution_reason    text,
  CONSTRAINT resolution_is_attributed CHECK (
    resolved_at IS NULL
    OR (resolved_by IS NOT NULL AND resolution_reason IS NOT NULL AND length(resolution_reason) > 0)
  )
);

CREATE UNIQUE INDEX settlement_exceptions_one_open
  ON settlement_exceptions (settlement_id) WHERE resolved_at IS NULL;
CREATE INDEX settlement_exceptions_scope_idx ON settlement_exceptions (workspace_id, environment);

-- ============================================================================
-- INV-32 — the status/event pairing rule
--
-- "Every transaction that updates settlements.status writes exactly one event
--  whose type is a settlement status event and whose settlement_id matches the
--  updated row, and may write any number of companion events. A transaction
--  that does not update status writes no status event."
--
-- Enforced as a DEFERRABLE CONSTRAINT TRIGGER so it fires at COMMIT: the count
-- cannot be known mid-transaction, and checking early would forbid the ordinary
-- pattern of updating the row and then writing its event.
-- ============================================================================

CREATE TABLE settlement_status_events (
  event_type text PRIMARY KEY
);

INSERT INTO settlement_status_events (event_type) VALUES
  ('settlement.created'),
  ('settlement.preflight_started'),
  ('settlement.ready'),
  ('settlement.action_required'),
  ('settlement.quoted'),
  ('settlement.authorized'),
  ('settlement.liquidity_reservation_started'),
  ('settlement.liquidity_reserved'),
  ('settlement.drawdown_requested'),
  ('settlement.drawdown_confirmed'),
  ('settlement.payout_submitted'),
  ('settlement.payout_confirmed'),
  ('settlement.reconciliation_started'),
  ('settlement.settled'),
  ('settlement.exception_opened'),
  ('settlement.exception_resolved'),
  ('settlement.failed'),
  ('settlement.cancelled');

CREATE OR REPLACE FUNCTION assert_status_event_pairing() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  status_events integer;
  settlement    record;
BEGIN
  SELECT count(*) INTO status_events
  FROM events e
  JOIN settlement_status_events se ON se.event_type = e.type
  WHERE e.subject_type = 'settlement'
    AND e.subject_id = NEW.id
    AND e.txid = pg_current_xact_id();

  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF status_events <> 1 THEN
      RAISE EXCEPTION
        'settlement % changed status but this transaction wrote % status events, not exactly 1 (INV-32)',
        NEW.id, status_events
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF status_events <> 0 THEN
      RAISE EXCEPTION
        'settlement % did not change status but this transaction wrote % status events (INV-32)',
        NEW.id, status_events
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER settlements_status_event_pairing
  AFTER INSERT OR UPDATE ON settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_status_event_pairing();

-- ============================================================================
-- INV-38 — terminal settlements accept no field writes at all
-- INV-16 — the instruction is immutable from AUTHORIZED onward
-- ============================================================================

CREATE OR REPLACE FUNCTION protect_settlement_row() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- INV-38: not a status change, not a flag, not a convenience pointer.
  IF OLD.status IN ('SETTLED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION
      'settlement % is terminal (%) and accepts no field writes (INV-38)', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- INV-16: from AUTHORIZED onward the instruction has no code path that
  -- updates it. A change of intent is a cancellation plus a new settlement.
  IF OLD.authorized_at IS NOT NULL THEN
    IF NEW.beneficiary_id            IS DISTINCT FROM OLD.beneficiary_id
    OR NEW.destination_id            IS DISTINCT FROM OLD.destination_id
    OR NEW.destination_version_id    IS DISTINCT FROM OLD.destination_version_id
    OR NEW.recipient_amount_minor    IS DISTINCT FROM OLD.recipient_amount_minor
    OR NEW.recipient_amount_currency IS DISTINCT FROM OLD.recipient_amount_currency
    OR NEW.purpose_code              IS DISTINCT FROM OLD.purpose_code
    OR NEW.funding_currency          IS DISTINCT FROM OLD.funding_currency
    OR NEW.quote_id                  IS DISTINCT FROM OLD.quote_id
    OR NEW.authorized_terms          IS DISTINCT FROM OLD.authorized_terms
    OR NEW.authorized_terms_hash     IS DISTINCT FROM OLD.authorized_terms_hash
    OR NEW.authorized_at             IS DISTINCT FROM OLD.authorized_at
    OR NEW.authorized_by             IS DISTINCT FROM OLD.authorized_by
    THEN
      RAISE EXCEPTION
        'settlement % is authorized; its instruction is immutable (INV-16)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- INV-36: the point of no return is never cleared and never moved.
  IF OLD.point_of_no_return_at IS NOT NULL
     AND NEW.point_of_no_return_at IS DISTINCT FROM OLD.point_of_no_return_at THEN
    RAISE EXCEPTION 'point_of_no_return_at is never cleared or moved (INV-36)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ---------------------------------------------- T22 resume integrity --
  --
  -- `exception_entered_from` is the destination of T22, so it is the one field
  -- that could turn a dynamic resume into a state-machine bypass. It is
  -- therefore never caller-supplied: the database derives what it must equal
  -- and rejects anything else.

  -- (a) Entering EXCEPTION records where it came from, and that value is the
  --     row's own previous status. Not a hint, not a parameter.
  IF NEW.status = 'EXCEPTION' AND OLD.status IS DISTINCT FROM 'EXCEPTION' THEN
    IF NEW.exception_entered_from IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        'exception_entered_from must be the status the settlement came from (%), got %',
        OLD.status, NEW.exception_entered_from
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- (b) While in EXCEPTION the recorded origin is frozen. Editing it would be
  --     editing T22's destination.
  IF OLD.status = 'EXCEPTION'
     AND NEW.exception_entered_from IS DISTINCT FROM OLD.exception_entered_from THEN
    RAISE EXCEPTION 'exception_entered_from is frozen while the exception is open'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- (c) Leaving EXCEPTION goes to the recorded origin (T22) or to a terminal
  --     resolution (T23 fail, T24 cancel). There is no fourth option, and this
  --     is what stops `UPDATE settlements SET status = 'SETTLED'` from an open
  --     exception even if every other guard were somehow satisfied.
  IF OLD.status = 'EXCEPTION' AND NEW.status IS DISTINCT FROM 'EXCEPTION' THEN
    IF NEW.status NOT IN ('FAILED', 'CANCELLED')
       AND NEW.status IS DISTINCT FROM OLD.exception_entered_from THEN
      RAISE EXCEPTION
        'a resumed exception returns to % (T22) or resolves to FAILED/CANCELLED; got %',
        OLD.exception_entered_from, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- (d) The point of no return is one-way for resumes too. An exception opened
  --     after dispatch cannot resume to a state that precedes dispatch —
  --     that would put a settlement whose money may already be moving back into
  --     a phase where it could be cancelled or re-reserved.
  IF OLD.point_of_no_return_at IS NOT NULL
     AND OLD.status = 'EXCEPTION'
     AND NEW.status IS DISTINCT FROM 'EXCEPTION'
     AND NEW.status NOT IN ('FAILED', 'CANCELLED')
     AND NEW.status NOT IN ('PAYOUT_SUBMITTED', 'PAYOUT_CONFIRMED', 'RECONCILING') THEN
    RAISE EXCEPTION
      'a post-point-of-no-return exception cannot resume to the pre-dispatch state % (INV-36)',
      NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Forward-only, set at creation (STATE_MACHINES.md § 7.1).
  IF NEW.replaces_settlement_id IS DISTINCT FROM OLD.replaces_settlement_id THEN
    RAISE EXCEPTION 'replaces_settlement_id is set at creation and never updated'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Optimistic concurrency, and a status change always advances it.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER settlements_protect
  BEFORE UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION protect_settlement_row();

-- ------------------------------------------------------ row-level security --

ALTER TABLE quotes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE settlements            ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements            FORCE  ROW LEVEL SECURITY;
ALTER TABLE payout_attempts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_attempts        FORCE  ROW LEVEL SECURITY;
ALTER TABLE settlement_exceptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_exceptions  FORCE  ROW LEVEL SECURITY;

CREATE POLICY quotes_tenant ON quotes
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY settlements_tenant ON settlements
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY payout_attempts_tenant ON payout_attempts
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY settlement_exceptions_tenant ON settlement_exceptions
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

-- ------------------------------------------------------------------ grants --

-- No DELETE anywhere. A settlement is cancelled or failed, never removed.
GRANT SELECT, INSERT, UPDATE ON quotes, settlements, settlement_exceptions TO inrsettle_app;
-- A payout attempt is a durable record of a dispatch that may exist at a
-- provider. Its *identity* — settlement, attempt number, idempotency key,
-- destination version — is written once and frozen by protect_payout_attempt();
-- its *status* advances along P01-P08 as the rail reports back, so UPDATE is
-- granted and the trigger, not the grant, is what keeps the record honest.
-- DELETE is granted nowhere: an attempt that may exist at a provider is never
-- removed from our side just because we would prefer it had not happened.
GRANT SELECT, INSERT, UPDATE ON payout_attempts TO inrsettle_app;
GRANT SELECT ON settlement_status_events TO inrsettle_app;

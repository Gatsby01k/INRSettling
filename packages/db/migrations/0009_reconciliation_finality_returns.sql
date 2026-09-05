-- ============================================================================
-- 0009 — Stage 6: reconciliation, finality, receipt, and the return aggregate
--
-- Scope: DOMAIN.md §§ 6.8–6.10, STATE_MACHINES.md § 6.4, § 6.6 and § 8.
--
-- The organising idea of this migration is a line that must not be crossed:
-- **a settled settlement is finished, and everything that happens afterwards is
-- a new row somewhere else.** So there is no column added to `settlements` here,
-- nothing writes back to a receipt, and the return aggregate references a
-- settlement it has no permission to touch (INV-38, INV-42, INV-48).
--
-- Enforced here rather than in application code:
--   INV-26  zero tolerance — a MATCHED reconciliation carries a zero delta
--   INV-27  a MISMATCH is resolved only by an attributed decision
--   INV-42  the settlement row and receipt hash are untouched by any return
--   INV-48  financial artifacts are write-once: no UPDATE grant, and a trigger
--   INV-49  cumulative confirmed returns never exceed the delivered amount,
--           held by a CHECK even against a code path that forgets the lock
--   INV-50  one real-world return is one row, on the second dedupe key
-- ============================================================================

CREATE TYPE reconciliation_status AS ENUM ('PENDING', 'MATCHED', 'MISMATCH', 'MANUAL_REVIEW');
CREATE TYPE settlement_return_status AS ENUM
  ('OBSERVED', 'CONFIRMED', 'REPAID', 'REJECTED', 'MANUAL_REVIEW');
CREATE TYPE return_reason_code AS ENUM (
  'BENEFICIARY_ACCOUNT_CLOSED',
  'BENEFICIARY_ACCOUNT_INVALID',
  'BENEFICIARY_NAME_MISMATCH',
  'BENEFICIARY_ACCOUNT_BLOCKED',
  'REFUSED_BY_BENEFICIARY',
  'COMPLIANCE_AT_BENEFICIARY_BANK',
  'RAIL_REVERSAL',
  'RETURN_REASON_UNMAPPED'
);
CREATE TYPE artifact_kind AS ENUM ('settlement_receipt', 'return_notice', 'receipt_composite');

-- ============================================================================
-- Reconciliation — R01–R07
-- ============================================================================

CREATE TABLE reconciliations (
  id                text PRIMARY KEY,
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment       environment NOT NULL,
  settlement_id     text NOT NULL REFERENCES settlements(id),
  status            reconciliation_status NOT NULL DEFAULT 'PENDING',

  expected_minor    bigint NOT NULL CHECK (expected_minor > 0),
  -- Nullable, and null is a real answer rather than a missing one: the provider
  -- credited and stated no figure. INV-26 treats that as a mismatch, because
  -- MATCHED means "we checked", not "we had no reason to doubt".
  observed_minor    bigint,
  -- Signed: observed minus expected. Negative is short, positive is over. An
  -- absolute delta would lose the first thing an operator needs to know.
  delta_minor       bigint NOT NULL DEFAULT 0,
  currency          text NOT NULL,

  source            text CHECK (source IS NULL OR source IN ('trusted_provider_event', 'authoritative_status_pull')),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  evaluated_at      timestamptz,
  -- The SLA this reconciliation is judged against, stored at opening for the
  -- same reason a payout attempt stores its own: an attempt should be judged
  -- against the terms it actually went out under.
  sla_seconds       integer NOT NULL CHECK (sla_seconds > 0),
  resolved_at       timestamptz,
  resolved_by       text,
  resolution_note   text,
  -- R06 asks the resolver to assert whether value moved incorrectly, because
  -- that is a fact only a human has (INV-27). Null until a resolution happens.
  compensation_required boolean,

  -- INV-26, at the database. A MATCHED row carrying a non-zero delta is the one
  -- case where trusting the status label would settle a mismatch, and F5 checks
  -- both halves for exactly that reason. This makes the bad row unwritable.
  CONSTRAINT reconciliation_matched_is_exact CHECK (
    status <> 'MATCHED' OR (observed_minor IS NOT NULL AND delta_minor = 0)
  ),
  -- INV-27. A resolution with no name and no reason is not a resolution.
  CONSTRAINT reconciliation_resolution_is_attributed CHECK (
    resolved_at IS NULL
    OR (resolved_by IS NOT NULL AND resolution_note IS NOT NULL AND length(resolution_note) > 0)
  )
);

-- One reconciliation per settlement. R01 is opened by T19 and there is no
-- transition that opens a second: a settlement is reconciled once, and a
-- disagreement about the result is resolved on the row rather than by starting
-- again with a fresh one nobody has to explain.
CREATE UNIQUE INDEX reconciliations_settlement_key ON reconciliations (settlement_id);
CREATE INDEX reconciliations_scope_idx ON reconciliations (workspace_id, environment, status);
-- The R04 poller's query: still pending, and past its own SLA.
CREATE INDEX reconciliations_overdue_idx ON reconciliations (opened_at) WHERE status = 'PENDING';

-- ============================================================================
-- INV-49 — the delivered-amount cap, carried on the payout attempt
-- ============================================================================
--
-- > "A transactionally maintained `returned_total_minor` column on the payout
-- > attempt carries a database CHECK constraint against `delivered_amount_minor`,
-- > so the invariant holds even against a code path that forgets the lock."
--
-- `credited_minor` (migration 0008) is the delivered amount: what the rail says
-- actually reached the beneficiary. The CHECK below is the same inequality the
-- domain's `checkReturnCap` states, written in SQL, so the two cannot drift.
--
-- Note the NULL arm. A credit whose amount the provider never stated has no cap
-- to check against, so any non-zero return total against it is refused outright.
-- That is fail-closed and deliberate: a cap against an unknown is not a cap.

ALTER TABLE payout_attempts
  ADD COLUMN returned_total_minor bigint NOT NULL DEFAULT 0
    CHECK (returned_total_minor >= 0),
  ADD CONSTRAINT payout_returns_never_exceed_delivered CHECK (
    returned_total_minor = 0
    OR (credited_minor IS NOT NULL AND returned_total_minor <= credited_minor)
  );

COMMENT ON COLUMN payout_attempts.returned_total_minor IS
  'Sum of CONFIRMED and REPAID returns against this attempt, maintained transactionally under the attempt row lock. INV-49.';

-- ============================================================================
-- SettlementReturn — N01–N07
-- ============================================================================

CREATE TABLE settlement_returns (
  id                text PRIMARY KEY,
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment       environment NOT NULL,
  -- References a SETTLED settlement and never modifies it. There is no trigger
  -- here writing back, and none is wanted: § 8.5 keeps the settlement SETTLED
  -- *because it was*, and the return is surfaced as a linked object.
  settlement_id     text NOT NULL REFERENCES settlements(id),
  payout_attempt_id text NOT NULL REFERENCES payout_attempts(id),
  status            settlement_return_status NOT NULL DEFAULT 'OBSERVED',

  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  amount_currency   text NOT NULL,
  reason_code       return_reason_code NOT NULL,
  reason_message    text NOT NULL,
  -- The provider's own words, kept unmapped beside the mapped code (INV-43), so
  -- a mapping added next month can be applied to a return opened today.
  provider_raw_reason text,

  -- INV-39: opened only by a trusted event or an authoritative pull. The CHECK
  -- is the invariant: there is no third value, so no operator assertion and no
  -- customer claim can be recorded as the thing that opened a return.
  opened_by_source  text NOT NULL
    CHECK (opened_by_source IN ('trusted_provider_event', 'authoritative_status_pull')),
  provider_event_id text,
  -- INV-50's key. NOT NULL on purpose: a return the provider will not identify
  -- cannot be deduplicated, and accepting one would let a status pull mint a
  -- duplicate of a return a webhook already opened.
  provider_return_reference text NOT NULL,

  observed_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  repaid_at         timestamptz,
  -- INV-41: confirming *requests* a repayment; it posts no ledger entry.
  repayment_id      text REFERENCES repayments(id),
  -- § 8.6 triage, recorded as evidence rather than recomputed later. D-04 is
  -- open on the duration, so the window this return was judged against is
  -- stored — a return judged under one window should not be re-read under
  -- another once a partner supplies a real number.
  window_seconds_at_open integer,
  arrival_elapsed_seconds integer,
  arrived_within_window   boolean,

  resolved_by       text,
  resolution_note   text,

  -- N06/N07 are attributed decisions. Same shape as the exception and
  -- reconciliation resolutions, for the same reason.
  CONSTRAINT settlement_return_resolution_is_attributed CHECK (
    resolved_by IS NULL
    OR (resolution_note IS NOT NULL AND length(resolution_note) > 0)
  ),
  CONSTRAINT settlement_return_confirmed_is_timed CHECK (
    status NOT IN ('CONFIRMED', 'REPAID') OR confirmed_at IS NOT NULL
  ),
  -- INV-41: REPAID is reachable only after a repayment was requested.
  CONSTRAINT settlement_return_repaid_has_repayment CHECK (
    status <> 'REPAID' OR (repayment_id IS NOT NULL AND repaid_at IS NOT NULL)
  )
);

-- INV-50, the second key. `INV-33` already makes a redelivered *event* a no-op;
-- this covers one real-world return reaching us through two channels, which
-- arrive with different event ids or with none at all.
CREATE UNIQUE INDEX settlement_returns_dedupe_key
  ON settlement_returns (payout_attempt_id, provider_return_reference);
CREATE INDEX settlement_returns_settlement_idx ON settlement_returns (settlement_id, observed_at DESC);
CREATE INDEX settlement_returns_scope_idx ON settlement_returns (workspace_id, environment, status);
-- The N04 return watcher's query.
CREATE INDEX settlement_returns_open_idx ON settlement_returns (observed_at) WHERE status = 'OBSERVED';

/**
 * INV-50: "A second sighting updates nothing and creates nothing; it is
 * recorded against the existing return as an additional observation."
 *
 * So a sighting is a row here rather than a counter on the return. Keeping each
 * one means a provider that reports a return four different ways leaves four
 * pieces of evidence, which is what an investigation needs — a counter would say
 * "four" and lose all four.
 */
CREATE TABLE return_observations (
  id                text PRIMARY KEY,
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment       environment NOT NULL,
  return_id         text NOT NULL REFERENCES settlement_returns(id),
  source            text NOT NULL
    CHECK (source IN ('trusted_provider_event', 'authoritative_status_pull')),
  provider_event_id text,
  -- The amount *this channel* reported, with its own currency rather than the
  -- return's. A sighting records what a provider said, and a channel reporting a
  -- different currency from the return it is about is precisely the kind of
  -- disagreement evidence exists to preserve — folding it into the return's
  -- currency would erase the finding while looking tidier.
  observed_amount_minor    bigint,
  observed_amount_currency text,
  CONSTRAINT observation_amount_carries_a_currency CHECK (
    observed_amount_minor IS NULL OR observed_amount_currency IS NOT NULL
  ),
  observed_at       timestamptz NOT NULL DEFAULT now(),
  -- True for the sighting that opened the return, false for every later one.
  opened_the_return boolean NOT NULL DEFAULT false,
  payload           jsonb
);

CREATE INDEX return_observations_return_idx ON return_observations (return_id, observed_at);
CREATE INDEX return_observations_scope_idx ON return_observations (workspace_id, environment);

-- An observation is evidence. Evidence is not edited.
CREATE OR REPLACE FUNCTION return_observations_are_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'return observations are append-only evidence (INV-50)'
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE TRIGGER return_observations_immutable
  BEFORE UPDATE OR DELETE ON return_observations
  FOR EACH ROW EXECUTE FUNCTION return_observations_are_append_only();

-- ============================================================================
-- Financial artifacts — INV-29, INV-48
-- ============================================================================
--
-- One table for all three kinds, because they are the same thing: an immutable
-- document, its canonical bytes, the hash of those bytes, and the key its PDF
-- was written to once. Three tables would be three places to forget the trigger.

CREATE TABLE financial_artifacts (
  id                text PRIMARY KEY,
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment       environment NOT NULL,
  kind              artifact_kind NOT NULL,
  settlement_id     text NOT NULL REFERENCES settlements(id),
  -- Set on a return notice; null on a receipt and a composite.
  return_id         text REFERENCES settlement_returns(id),
  -- A notice and a composite name the receipt they were composed with. They do
  -- not modify it, and carrying its hash is what makes that checkable.
  receipt_id        text,
  source_content_hash text,

  -- The exact bytes the hash is over, and that the PDF renders. Stored so a
  -- verifier can re-derive the hash without re-running the builder — an
  -- artifact store nobody can verify is one whose corruption is found by a
  -- customer.
  canonical_bytes   text NOT NULL,
  content_hash      text NOT NULL CHECK (content_hash LIKE 'sha256:%'),
  pdf_object_key    text NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One receipt per settlement, and one notice per return. Both by unique index
-- rather than by convention, because "issue it again" is what a retried job
-- does and the second issuance is the one that would break INV-48.
CREATE UNIQUE INDEX financial_artifacts_one_receipt
  ON financial_artifacts (settlement_id) WHERE kind = 'settlement_receipt';
CREATE UNIQUE INDEX financial_artifacts_one_notice_per_return
  ON financial_artifacts (return_id) WHERE kind = 'return_notice';
-- Two different artifacts must never claim one object key.
CREATE UNIQUE INDEX financial_artifacts_object_key ON financial_artifacts (pdf_object_key);
CREATE INDEX financial_artifacts_settlement_idx ON financial_artifacts (settlement_id, kind, created_at);
CREATE INDEX financial_artifacts_scope_idx ON financial_artifacts (workspace_id, environment);

/**
 * INV-48 — write-once, and it means it.
 *
 * > "A SettlementReceipt, once created, is never re-serialised, never
 * > re-rendered and never re-hashed."
 *
 * No column is updatable and no row is deletable. There is no "except for
 * metadata" clause, because the first such clause is how a write-once record
 * stops being one: the trigger that protects it has to be weakened to allow the
 * harmless field, and then it protects nothing.
 *
 * The application role is additionally granted no UPDATE and no DELETE, so a
 * mistake fails at the grant — one layer earlier than here, and long before the
 * object-storage policy that is the third and outermost layer.
 */
CREATE OR REPLACE FUNCTION financial_artifacts_are_write_once() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'financial artifact % is write-once: its bytes, hash and object key never change (INV-48)',
    COALESCE(OLD.id, NEW.id)
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE TRIGGER financial_artifacts_immutable
  BEFORE UPDATE OR DELETE ON financial_artifacts
  FOR EACH ROW EXECUTE FUNCTION financial_artifacts_are_write_once();

-- ============================================================================
-- Finality evaluations
-- ============================================================================
--
-- § 8.1: "Every evaluation persists which conditions passed and which did not,
-- so any question about why a settlement is or is not final has a recorded
-- answer."
--
-- Note that failed evaluations are stored too, and that is the point. A table
-- holding only successes answers "why is this settled" and not "why is this
-- still not settled", and the second question is the one operations actually
-- asks at 3am.

CREATE TABLE finality_evaluations (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment   environment NOT NULL,
  settlement_id text NOT NULL REFERENCES settlements(id),
  final         boolean NOT NULL,
  -- Every condition and drift check, each with the sentence the evaluator gave
  -- for it — the passing ones as well as the failing ones. A verdict that
  -- explains only its failures cannot answer "why is this settled".
  conditions    jsonb NOT NULL,
  missing       text[] NOT NULL,
  evaluated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX finality_evaluations_settlement_idx
  ON finality_evaluations (settlement_id, evaluated_at DESC);
CREATE INDEX finality_evaluations_scope_idx ON finality_evaluations (workspace_id, environment);

CREATE OR REPLACE FUNCTION finality_evaluations_are_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'a finality evaluation is a record of what was decided and when; it is append-only'
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE TRIGGER finality_evaluations_immutable
  BEFORE UPDATE OR DELETE ON finality_evaluations
  FOR EACH ROW EXECUTE FUNCTION finality_evaluations_are_append_only();

-- ============================================================================
-- Row-level security
-- ============================================================================

ALTER TABLE reconciliations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliations       FORCE  ROW LEVEL SECURITY;
ALTER TABLE settlement_returns    ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_returns    FORCE  ROW LEVEL SECURITY;
ALTER TABLE return_observations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_observations   FORCE  ROW LEVEL SECURITY;
ALTER TABLE financial_artifacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_artifacts   FORCE  ROW LEVEL SECURITY;
ALTER TABLE finality_evaluations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE finality_evaluations  FORCE  ROW LEVEL SECURITY;

CREATE POLICY reconciliations_tenant ON reconciliations
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY settlement_returns_tenant ON settlement_returns
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY return_observations_tenant ON return_observations
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY financial_artifacts_tenant ON financial_artifacts
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY finality_evaluations_tenant ON finality_evaluations
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

-- ============================================================================
-- Grants
-- ============================================================================

-- Reconciliation and returns move through their machines, so they take UPDATE.
-- Neither takes DELETE: a reconciliation that happened and a return that was
-- reported are both facts, and neither is undone by removing the row.
GRANT SELECT, INSERT, UPDATE ON reconciliations, settlement_returns TO inrsettle_app;

-- Evidence and artifacts take INSERT and nothing else. The triggers above refuse
-- UPDATE and DELETE regardless; withholding the grants too means a mistake fails
-- one layer earlier, and it means the *shape* of the permission matches the
-- shape of the invariant.
GRANT SELECT, INSERT ON return_observations, financial_artifacts, finality_evaluations
  TO inrsettle_app;

-- ============================================================================
-- Correcting a Stage 4 index that Stage 6 makes too strong
-- ============================================================================
--
-- Stage 4 created `repayments_one_live_per_settlement` on `(settlement_id)`,
-- with sound reasoning for what it could see at the time:
--
--   > "A settlement's funding is drawn once, so it is repaid once. Two live
--   > repayments against one settlement is the shape a double restoration
--   > takes."
--
-- That holds for the case Stage 4 had — a cancellation after a confirmed
-- drawdown, of which there is at most one. It does **not** hold for returns.
-- `STATE_MACHINES.md § 8.4` clause 6 is explicit: *"Partial returns are
-- supported, and multiple returns against one settlement are separate rows"*,
-- and `INV-41` makes each confirmation request its own `Repayment`. Three
-- partial returns against one settlement legitimately produce three live
-- repayments, for three different fractions of one drawdown.
--
-- So the key gains the cause. One live repayment per settlement **per return**,
-- and — via the empty string — still at most one live repayment for a
-- settlement with no return behind it, which is the cancellation case Stage 4
-- was protecting. Nothing Stage 4 refused is now permitted.
--
-- What stops N partial repayments from over-restoring is not this index and
-- never was: it is `INV-49`'s cap on cumulative confirmed returns, enforced
-- under the payout attempt's row lock and re-checked by a database CHECK, plus
-- the pro-rata arithmetic that can never exceed the drawdown.

DROP INDEX repayments_one_live_per_settlement;

CREATE UNIQUE INDEX repayments_one_live_per_settlement_cause
  ON repayments (settlement_id, COALESCE(return_id, ''))
  WHERE settlement_id IS NOT NULL AND status <> 'FAILED';

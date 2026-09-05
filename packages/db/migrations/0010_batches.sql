-- ============================================================================
-- 0010 — Stage 7: batches
--
-- Scope: DOMAIN.md § 6.11, STATE_MACHINES.md § 6.8, PRODUCT.md § 10.
--
-- One idea, and it is INV-30:
--
--   > "A batch is a container, not a transaction. An invalid or blocked row
--   > never blocks a valid row, and the batch has no all-or-nothing semantics."
--
-- So the schema below deliberately lacks the things a transaction would have.
-- There is no foreign key from `settlements` to `batches` enforcing membership
-- in one direction only; there is no cascade that would remove settlements with
-- their batch; and there is no constraint that could make one bad row
-- unwritable alongside good ones. A batch **points at** settlements that exist
-- perfectly well without it.
--
-- Enforced here rather than in application code:
--   INV-30  a row's failure is recorded on the row, never on its siblings
--   INV-02  the aggregate total is minor units plus a currency
-- ============================================================================

CREATE TYPE batch_status AS ENUM (
  'DRAFT', 'VALIDATING', 'READY', 'EXECUTING', 'COMPLETED', 'PARTIALLY_COMPLETED'
);
CREATE TYPE batch_source AS ENUM ('CSV', 'API');
CREATE TYPE batch_row_outcome AS ENUM (
  'INVALID', 'ACCEPTED', 'ACTION_REQUIRED', 'SETTLED', 'FAILED', 'CANCELLED'
);

CREATE TABLE batches (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment    environment NOT NULL,
  name           text NOT NULL CHECK (length(trim(name)) > 0),
  source         batch_source NOT NULL,
  status         batch_status NOT NULL DEFAULT 'DRAFT',

  -- Derived from the rows on every refresh, never incremented in place. A
  -- counter maintained independently of the thing it counts is a counter that
  -- eventually disagrees with it, and this one is on a screen a customer reads.
  row_count             integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  valid_count           integer NOT NULL DEFAULT 0 CHECK (valid_count >= 0),
  action_required_count integer NOT NULL DEFAULT 0 CHECK (action_required_count >= 0),
  settled_count         integer NOT NULL DEFAULT 0 CHECK (settled_count >= 0),
  failed_count          integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  total_minor           bigint  NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  total_currency        text    NOT NULL DEFAULT 'INR',

  -- Idempotency for import. The Stage 7 exit criterion is "the same file twice
  -- does not double-create", and the honest key for that is the file's own
  -- content: a customer who re-uploads after a timeout has the same bytes, and
  -- a customer who genuinely means to pay the same people again has a different
  -- file (a new external reference, a new date) or supplies their own key.
  --
  -- Nullable because an API-created batch has no file. Unique per workspace and
  -- environment rather than globally: two workspaces uploading identical files
  -- are doing two unrelated things.
  import_fingerprint text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  validated_at   timestamptz,
  completed_at   timestamptz,

  CONSTRAINT batch_counts_do_not_exceed_rows CHECK (valid_count <= row_count)
);

CREATE UNIQUE INDEX batches_import_fingerprint_key
  ON batches (workspace_id, environment, import_fingerprint)
  WHERE import_fingerprint IS NOT NULL;
CREATE INDEX batches_scope_idx ON batches (workspace_id, environment, created_at DESC);

/**
 * One row of the file, and what became of it.
 *
 * A row that failed validation has no settlement and keeps its errors; a row
 * that passed has a settlement and no errors. Both live in this table, side by
 * side, which is what INV-30 looks like in a schema: the forty invalid rows of a
 * five-hundred-row import are *recorded*, not discarded, and the four hundred
 * and sixty valid ones are unaffected by their presence.
 */
CREATE TABLE batch_rows (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment   environment NOT NULL,
  batch_id      text NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  -- 1-based, counting the header as line 1 — the number the spreadsheet shows,
  -- because that is the number the person fixing the file will scroll to.
  line_number   integer NOT NULL CHECK (line_number > 0),

  outcome       batch_row_outcome NOT NULL,
  -- Set exactly when the row became a settlement. No cascade: deleting a batch
  -- must never delete settlements, and a settlement outlives its container.
  settlement_id text REFERENCES settlements(id),

  -- What the file said, kept verbatim. A row that failed can be shown back to
  -- the customer as they wrote it, and a row that succeeded can be checked
  -- against what was created from it.
  raw           jsonb NOT NULL,
  -- Per-row, naming the column and the fix. Empty for a valid row.
  errors        jsonb NOT NULL DEFAULT '[]'::jsonb,

  amount_minor    bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  amount_currency text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- The two halves of INV-30, as a constraint: an invalid row produced no
  -- settlement and must say why; anything else produced one.
  CONSTRAINT batch_row_invalid_has_errors_and_no_settlement CHECK (
    (outcome = 'INVALID' AND settlement_id IS NULL AND jsonb_array_length(errors) > 0)
    OR (outcome <> 'INVALID' AND settlement_id IS NOT NULL)
  ),
  CONSTRAINT batch_row_amount_carries_a_currency CHECK (
    amount_minor IS NULL OR amount_currency IS NOT NULL
  )
);

CREATE UNIQUE INDEX batch_rows_line_key ON batch_rows (batch_id, line_number);
-- A settlement belongs to at most one batch. The reverse — a batch with many
-- settlements — is the whole point, so only this direction is constrained.
CREATE UNIQUE INDEX batch_rows_settlement_key
  ON batch_rows (settlement_id) WHERE settlement_id IS NOT NULL;
CREATE INDEX batch_rows_batch_idx ON batch_rows (batch_id, line_number);
CREATE INDEX batch_rows_scope_idx ON batch_rows (workspace_id, environment);
-- The batch screen's two questions: what needs attention, and what is running.
CREATE INDEX batch_rows_attention_idx
  ON batch_rows (batch_id) WHERE outcome IN ('INVALID', 'ACTION_REQUIRED');

-- ------------------------------------------------------ row-level security --

ALTER TABLE batches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches    FORCE  ROW LEVEL SECURITY;
ALTER TABLE batch_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_rows FORCE  ROW LEVEL SECURITY;

CREATE POLICY batches_tenant ON batches
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

CREATE POLICY batch_rows_tenant ON batch_rows
  USING (workspace_id = current_workspace_id() AND environment = current_environment())
  WITH CHECK (workspace_id = current_workspace_id() AND environment = current_environment());

-- ------------------------------------------------------------------ grants --

-- A batch's aggregates are recomputed, so it takes UPDATE; a row's outcome
-- follows its settlement, so it does too. Neither takes DELETE: a batch that was
-- imported is a thing that happened, and the forty rows somebody could not fix
-- are the record of why.
GRANT SELECT, INSERT, UPDATE ON batches, batch_rows TO inrsettle_app;

-- ============================================================================
-- 0008 — what the rail actually credited
--
-- One column. `payout_attempts.amount_minor` is what we *instructed*; this is
-- what the rail says *arrived*. They are two different facts, and a rail is
-- perfectly capable of disagreeing with us — simulator scenario `…0001` is
-- exactly that case, and `INV-26` exists because it happens.
--
-- Recording the difference is Stage 5's: it is a rail-level fact about a payout
-- attempt, which is Stage 5's aggregate. *Comparing* it to what was expected,
-- and deciding what a delta means, is reconciliation — Stage 6. This migration
-- deliberately stops at the recording.
--
-- A separate migration rather than an edit to 0007, because 0007 has been
-- reviewed. Rewriting a reviewed migration makes the review a statement about a
-- file that no longer exists.
--
-- Deliberately NOT added here: a `returned_minor` on the attempt. The amounts a
-- rail sends back arrive as provider events, which `INV-33` already stores
-- verbatim, and the aggregate that totals them is the Stage 6 `SettlementReturn`
-- with `INV-49`'s cap over it. A running total on the attempt as well would be a
-- second place for one fact to live, and the two would eventually disagree.
-- ============================================================================

ALTER TABLE payout_attempts
  ADD COLUMN credited_minor bigint
    CHECK (credited_minor IS NULL OR credited_minor > 0);

-- NULL is a real answer and is kept distinct from "the full amount".
--
-- Many providers credit exactly what they were instructed and report no figure
-- at all. Defaulting NULL to `amount_minor` would be us asserting a credit
-- amount the rail never stated — the precise mistake that makes a shortfall
-- unrepresentable. So three cases survive to reconciliation rather than two:
-- the rail said nothing, the rail agreed, the rail differed.
COMMENT ON COLUMN payout_attempts.credited_minor IS
  'What the rail reports actually reached the beneficiary, in the attempt''s amount_currency. NULL means the provider stated no figure — never assume it equals amount_minor (INV-26).';

-- An amount can only exist where a credit did. RETURNED is reachable only from
-- CREDITED (P08), so it keeps the figure it was credited with.
ALTER TABLE payout_attempts
  ADD CONSTRAINT payout_credited_amount_needs_a_credit CHECK (
    credited_minor IS NULL OR status IN ('CREDITED', 'RETURNED')
  );

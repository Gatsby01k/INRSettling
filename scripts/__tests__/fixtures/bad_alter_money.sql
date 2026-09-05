-- A money column that arrives by ALTER TABLE, on a table with no currency.
--
-- The shape a growing schema actually produces, and the one a per-file check
-- never sees: the CREATE TABLE is clean, and the violation is added later.
CREATE TABLE altered_example (
  id text PRIMARY KEY
);

ALTER TABLE altered_example
  ADD COLUMN settled_minor bigint,
  -- A real type declared inside a CHECK expression must not be read as a type.
  ADD COLUMN is_real boolean CHECK (is_real IS NOT NULL);

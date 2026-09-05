-- The other half, in a *later* migration: a second amount on a table whose one
-- currency column was declared in the file before. Correct, and only visible as
-- correct to a check that reads the whole schema rather than one file.
ALTER TABLE grown_example
  ADD COLUMN credited_minor bigint CHECK (credited_minor IS NULL OR credited_minor > 0);

-- Half of a cross-file pair: the table, with the currency its amounts are in.
CREATE TABLE grown_example (
  id text PRIMARY KEY,
  amount_minor BIGINT NOT NULL,
  amount_currency text NOT NULL
);

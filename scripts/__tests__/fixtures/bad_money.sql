CREATE TABLE bad_example (
  id text PRIMARY KEY,
  recipient_amount NUMERIC(20, 2) NOT NULL,
  fee_total DOUBLE PRECISION,
  funding_minor BIGINT NOT NULL
);

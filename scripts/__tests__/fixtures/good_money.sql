CREATE TABLE good_example (
  id text PRIMARY KEY,
  recipient_amount_minor BIGINT NOT NULL,
  recipient_amount_currency text NOT NULL,
  funding_minor BIGINT NOT NULL,
  funding_currency text NOT NULL
);

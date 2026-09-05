-- ============================================================================
-- 0013 — register the `webhook.deliver` job class
--
-- `ARCHITECTURE.md § 7` names it among the frozen job classes, and § 6 draws
-- the path it completes:
--
--   > transition ──┬─> settlements.status        (same transaction)
--   >              ├─> events                    (append-only)
--   >              └─> outbox                    (pending deliveries)
--   >                         │
--   >                    worker picks up
--
-- The outbox has existed since Stage 1 and nothing has ever read it. This is
-- the job that does, and it is worker-owned for the same reason the payout call
-- is: an HTTP request to a customer's server is an unbounded external call, and
-- the transaction that produced the event must not be holding a row lock while
-- it happens.
--
-- Delivery fans out inside the job rather than at enqueue time. One event may
-- have several endpoints, and an endpoint that is down must not hold back one
-- that is up, so each (event, endpoint) pair carries its own attempt schedule.
-- ============================================================================

INSERT INTO job_tasks (task_name, description) VALUES (
  'webhook.deliver',
  'Deliver one customer-visible event to one webhook endpoint, signed per SECURITY.md § 4.1. Idempotent: the delivery row is unique per (endpoint, event) and every attempt is appended, never overwritten.'
);

-- A correction to 0002, applied here because this is the migration the queue
-- role runs and `enqueue_job` is its function to alter.
--
-- `SET search_path = pg_catalog` leaves `pg_temp` searched *first*, and
-- TEMPORARY on a database is granted to PUBLIC by default. The body is fully
-- qualified, so nothing is currently reachable through it, but a SECURITY
-- DEFINER function should name `pg_temp` explicitly and last rather than rely on
-- its body never changing.
ALTER FUNCTION enqueue_job(text, jsonb, timestamptz, integer, text)
  SET search_path = pg_catalog, pg_temp;

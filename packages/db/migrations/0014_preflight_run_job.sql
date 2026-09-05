-- ============================================================================
-- 0014 — register the `preflight.run` job class
--
-- `ARCHITECTURE.md § 7` names it first in the frozen job-class list, and § 3
-- says why it has to exist:
--
--   > All state progression is asynchronous and lives in `worker`. **A request
--   > never drives a settlement through more than one transition**; it records
--   > intent and enqueues.
--
-- Stage 8 is the first stage with a request that would otherwise break that
-- rule. `POST /v1/settlements` creates the settlement (`T01`) and would like to
-- hand back a preflighted one — but preflight is `T02` followed by `T03` or
-- `T04`, so doing it inline would put three transitions in one transaction.
--
-- That is not merely against the architecture; it is impossible. The `INV-32`
-- pairing trigger counts status events at commit and refuses a transaction that
-- wrote more than one. The database says the same thing § 3 says, and it says it
-- first.
--
-- So the request commits `T01` and enqueues this. The customer learns the
-- outcome from `settlement.ready` or `settlement.action_required` — which is
-- what those events are for, and why `§ 10.2` lists them.
-- ============================================================================

INSERT INTO job_tasks (task_name, description) VALUES (
  'preflight.run',
  'Run preflight for one settlement (T02 → T03/T04) and attach its quote if one was named at creation. One transition per transaction (INV-32). Idempotent: a settlement past preflight is left alone.'
);

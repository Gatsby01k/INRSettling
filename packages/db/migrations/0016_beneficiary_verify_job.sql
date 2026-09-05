-- ============================================================================
-- 0016 — register the `beneficiary.verify` job class
--
-- This closes `D-19`, and it required a revision to `ARCHITECTURE.md § 7`.
--
-- The contradiction the Stage 8 review found: `API_CONTRACT.md § 8` has
-- `POST /v1/beneficiaries/{id}/verify`; performing it means handing the provider
-- a plaintext account number, which means decrypting a payout destination; and
-- `SECURITY.md § 8` grants that capability to `worker` alone. So the endpoint
-- can only ever record intent — but § 7's job-class list named nothing for the
-- worker side to be enqueued onto, so the intent had nowhere to go.
--
-- Two of the three documents were right and the list was incomplete. § 7 is
-- amended to name this class, and the amendment is recorded in
-- `decisions/0014-beneficiary-verification-job.md`.
--
-- Why the split matters beyond the missing name: `ARCHITECTURE.md § 5` says
-- adapters are *"called from jobs, never from inside a database transaction"*,
-- and the Stage 2 verification path called the provider while holding one. A
-- penny drop that takes four seconds held a transaction open for four seconds,
-- and a provider that hung held it until the statement timeout. The job splits
-- it into three: a transaction that records the request, an unbounded call that
-- holds nothing, and a transaction that records the answer.
-- ============================================================================

INSERT INTO job_tasks (task_name, description) VALUES (
  'beneficiary.verify',
  'Run one destination verification against the provider and apply its outcome (INV-11). The provider call happens outside every transaction (ARCHITECTURE.md § 5). Idempotent: a verification already resolved is left alone.'
);

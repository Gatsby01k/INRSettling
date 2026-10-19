# Sandbox operations

Scope: the local/partner sandbox described in `SANDBOX_RUNTIME.md`. No command
in this runbook authorizes real money movement.

**Startup:** `pnpm sandbox:migrate`, `pnpm sandbox:provision`, then API and worker.
An applied migration checksum mismatch is a deployment failure; restore the
original migration and add a forward migration. Do not edit migration history.

**Health:** `/healthz` confirms the API process, `/readyz` confirms the DB.
`http_request` logs provide status, request ID and duration without request
bodies or credentials. `worker_task_signal` provides task/job correlation;
`sandbox_sweep_failed` requires investigation. Graphile's free-form error dump
is suppressed because database exceptions may contain sensitive data.

**Worker restart:** stop with SIGTERM and let active work drain. Start the
worker with the same database and encryption keys. Pending jobs survive, and
the periodic sweeper requeues nonterminal execution for the configured workspace.
The local sweeper is scoped to `INRSETTLE_WORKSPACE_ID`; run a worker per sandbox
workspace when evaluating multiple workspaces. Tenant-scoped jobs remain subject
to RLS and refuse live payloads.

**Payout uncertainty:** inspect settlement and provider records by their IDs.
An existing provider operation is recovered through status lookup. Never
invent a second payment key because a response was lost. The persisted sandbox
counterparty can authoritatively establish absence; a real adapter must prove
its own lookup and deduplication guarantees before using this recovery path.

**Missing receipt PDF:** the immutable receipt record may exist while its PDF
job is queued or retrying. Check the Chromium installation and artifact-directory
permissions. Restart with the same artifact volume and allow the job to retry.
PDF publication uses an atomic link after the complete file is synced; interrupted
temporary files cannot be mistaken for finished artifacts. Do not overwrite a
published receipt. A missing record is a different issue from pending rendering.

**Webhook failures:** check the public HTTPS receiver, TLS/DNS and signature
verification. Redirects and private addresses are refused intentionally. An
HTTP failure must remain a recorded attempt and use the existing delivery retry
schedule. Store signing secrets securely; endpoint data in logs is not a second
secret store.

**Insufficient liquidity or reconciliation mismatch:** read the recorded
exception and expected/observed amounts. Neither condition permits an operator
to force the settlement into a successful state. This runtime does not provide
an authenticated human operations console; use the existing application/ops
interfaces only after supplying a real human authentication implementation.

**Data preservation:** retain the PostgreSQL volume, `.env.sandbox` field keys
and artifact directory together. Docker `down` preserves the named DB volume;
`down -v` deletes it and is not a normal restart command. Use a dedicated
sandbox backup/restore destination. A production point-in-time recovery drill
and its evidence are still required by Stage 12 and are not claimed here.

**Incident containment:** stop worker execution to prevent new submissions,
keep the database and provider records, correlate by settlement/request/job ID,
and investigate uncertainty before resuming. Do not change settled records,
remove idempotency claims, or delete counterparty operations to make retries run.

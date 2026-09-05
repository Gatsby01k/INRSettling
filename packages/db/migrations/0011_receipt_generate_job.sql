-- ============================================================================
-- 0011 — register the `receipt.generate` job class
--
-- `ARCHITECTURE.md § 7` names it among the frozen job classes:
--
--   > "Job classes: preflight.run, quote.expire, liquidity.reserve,
--   > liquidity.drawdown, payout.dispatch (the outbound call, enqueued by the
--   > dispatch transaction), payout.poll, reconcile.run, finality.evaluate,
--   > **receipt.generate**, webhook.deliver, batch.ingest, plus the sweepers."
--
-- Rendering a receipt is worker-owned work, and this row is what makes the
-- application able to ask for it: `enqueue_job` refuses any task not in this
-- table, so registering a class is a migration rather than a string somebody
-- typed at a call site.
--
-- Why the receipt is rendered by a worker at all, rather than by whoever asked:
--
--   `T20` must persist the receipt *record* inside its own transaction — the
--   companion set promises `receipt.available`, and an event announcing an
--   artifact that does not exist is worse than no event. But the record is not
--   the PDF. Printing it means launching headless Chromium, and doing that while
--   holding the settlement's row lock is the mistake `INV-36(b)` names for
--   provider calls. So the transaction enqueues, commits, and the worker prints.
--
-- The same argument forbids the *read* path from printing. A customer opening a
-- receipt whose PDF has not been generated yet must not become the process that
-- launches a browser: that would put an unbounded external process on a request
-- path, and it would mean the slowest way to discover a broken renderer is a
-- customer waiting. A read may re-enqueue; it may not render.
-- ============================================================================

INSERT INTO job_tasks (task_name, description) VALUES (
  'receipt.generate',
  'Render a financial artifact''s shared template through headless Chromium and write its PDF once (INV-29, INV-48). Idempotent: the object store is checked first and putIfAbsent decides.'
);

-- ============================================================================
-- 0002 — the enqueue bridge
--
-- ORDERING: this migration runs AFTER Graphile Worker's own migrations, and it
-- must be applied as `inrsettle_worker`, which owns the queue schema. Applying
-- it as any other role produces a bridge with the wrong definer rights.
--
-- Why a bridge exists at all: application transactions must be able to enqueue
-- a job atomically with the state change that justifies it (ARCHITECTURE.md
-- § 7). That is the *only* thing they need from the queue. So inrsettle_app is
-- given exactly one capability — this function — and no privilege whatsoever on
-- the graphile_worker schema: no USAGE, no SELECT, no INSERT, no EXECUTE on
-- add_job, and no ownership or DDL authority over any queue object.
-- ============================================================================

-- Vetted task registry. A task must be registered before anything can enqueue
-- it, so a compromised application principal cannot invent work for the worker
-- to run. Stage 1 registers nothing: there are no financial job classes yet.
CREATE TABLE job_tasks (
  task_name     text PRIMARY KEY,
  description   text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE job_tasks FROM PUBLIC;

-- The one capability the application gets.
--
-- SECURITY DEFINER, owned by inrsettle_worker, with a pinned search_path and
-- fully-qualified references so the definer's rights cannot be redirected by a
-- caller-controlled search_path.
CREATE FUNCTION enqueue_job(
  p_task         text,
  p_payload      jsonb       DEFAULT '{}'::jsonb,
  p_run_at       timestamptz DEFAULT NULL,
  p_max_attempts integer     DEFAULT NULL,
  p_job_key      text        DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  j record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.job_tasks WHERE task_name = p_task) THEN
    RAISE EXCEPTION 'task % is not a registered job task', p_task
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO j FROM graphile_worker.add_job(
    p_task,
    payload      => p_payload::json,
    run_at       => p_run_at,
    max_attempts => p_max_attempts,
    job_key      => p_job_key
  );
  RETURN j.id;
END
$fn$;

REVOKE ALL ON FUNCTION enqueue_job(text, jsonb, timestamptz, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_job(text, jsonb, timestamptz, integer, text) TO inrsettle_app;

-- Belt and braces: strip anything Graphile Worker's migrations may have granted
-- broadly, and make the application's lack of access explicit rather than
-- incidental.
REVOKE ALL ON SCHEMA graphile_worker                    FROM PUBLIC, inrsettle_app;
REVOKE ALL ON ALL TABLES IN SCHEMA graphile_worker      FROM PUBLIC, inrsettle_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA graphile_worker   FROM PUBLIC, inrsettle_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA graphile_worker   FROM PUBLIC, inrsettle_app;

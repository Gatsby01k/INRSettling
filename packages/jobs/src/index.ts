/**
 * Job enqueueing.
 *
 * Graphile Worker on the same Postgres (ARCHITECTURE.md § 7), reached through a
 * narrow bridge rather than directly.
 *
 * The application role holds **no** privilege on the `graphile_worker` schema —
 * no USAGE, no table access, no EXECUTE on `add_job`, no ownership, no DDL. It
 * holds exactly one capability: EXECUTE on `public.enqueue_job`, a SECURITY
 * DEFINER function owned by the queue role that accepts only tasks registered
 * in `job_tasks`. See migration 0002.
 *
 * The property that matters is unchanged: a job is inserted by the same
 * transaction as the state change that asked for it, so a job cannot exist
 * without the change and a rolled-back change leaves no job behind.
 *
 * Stage 1 registers no job classes. Real ones arrive with the stages that need
 * them, each added to `job_tasks` by a migration.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'

export type JobName = string

/**
 * Enqueue inside the caller's transaction. Takes `tx`, never a pool, so there
 * is no way to enqueue outside the transaction that justifies the job.
 *
 * Throws if the task is not registered — an unregistered task is a bug or an
 * attempt to invent work, and neither should reach the queue.
 */
// `runAt` crosses as an ISO string rather than a Date. The driver has no type
// hint for a bare parameter inside a function call, and a Date arriving with no
// declared type is not something it can serialise — the failure is a Node type
// error a long way from here.
export async function enqueue(
  tx: Db,
  name: JobName,
  payload: Record<string, unknown> = {},
  opts: { runAt?: Date; maxAttempts?: number; jobKey?: string } = {},
): Promise<void> {
  await tx.execute(sql`
    SELECT public.enqueue_job(
      ${name},
      ${JSON.stringify(payload)}::jsonb,
      ${opts.runAt ? opts.runAt.toISOString() : null}::timestamptz,
      ${opts.maxAttempts ?? null}::integer,
      ${opts.jobKey ?? null}::text
    )`)
}

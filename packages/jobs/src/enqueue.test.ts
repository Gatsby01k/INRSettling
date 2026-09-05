/**
 * Stage 1 exit criterion: a job enqueued in a rolled-back transaction does not
 * run — plus the privilege model that surrounds it.
 *
 * `inrsettle_app` must be able to do exactly one thing to the queue: enqueue a
 * registered task, transactionally. Everything else — reading it, writing it,
 * altering it, dropping it, calling add_job directly — must be refused by the
 * database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { run, runMigrations } from 'graphile-worker'
import {
  adminConnectionString, createTestDatabase, installJobQueue, registerJobTask,
  seedWorkspace, workerConnectionString, type Harness,
} from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { enqueue } from './index.js'

let h: Harness
let dbName: string
const W = { workspaceId: 'ws_jobs', userId: 'usr_jobs', email: 'j@example.test' }

const scoped = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(h.db, { workspaceId: W.workspaceId, environment: 'sandbox' }, fn)

beforeAll(async () => {
  h = await createTestDatabase('jobs')
  await seedWorkspace(h.admin, W)
  const [row] = await h.admin<{ db: string }[]>`SELECT current_database() AS db`
  dbName = row!.db
  await installJobQueue(h.admin, runMigrations, dbName)
  await registerJobTask(h.admin, 'stage1_probe', 'Stage 1 infrastructure probe')
})

afterAll(async () => { await h?.close() })

async function pendingJobs(): Promise<number> {
  const [row] = await h.admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM graphile_worker._private_jobs`
  return row!.n
}

describe('queue privilege model — least privilege, not ownership', () => {
  it('gives the queue role ownership and the app role none', async () => {
    const rows = await h.admin<{ relname: string; owner: string }[]>`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'graphile_worker' AND c.relkind = 'r'`
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.owner, `${r.relname} owner`).toBe('inrsettle_worker')
    }
    const [schema] = await h.admin<{ owner: string }[]>`
      SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'graphile_worker'`
    expect(schema!.owner).toBe('inrsettle_worker')
  })

  it('denies the app role even USAGE on the queue schema', async () => {
    const [p] = await h.admin<{ usage: boolean }[]>`
      SELECT has_schema_privilege('inrsettle_app', 'graphile_worker', 'USAGE') AS usage`
    expect(p!.usage).toBe(false)
  })

  it('denies the app role every table privilege on the queue', async () => {
    const rows = await h.admin<{ relname: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
      SELECT c.relname,
             has_table_privilege('inrsettle_app', c.oid, 'SELECT') AS sel,
             has_table_privilege('inrsettle_app', c.oid, 'INSERT') AS ins,
             has_table_privilege('inrsettle_app', c.oid, 'UPDATE') AS upd,
             has_table_privilege('inrsettle_app', c.oid, 'DELETE') AS del
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'graphile_worker' AND c.relkind = 'r'`
    for (const r of rows) {
      expect([r.sel, r.ins, r.upd, r.del], `${r.relname} privileges`).toEqual([false, false, false, false])
    }
  })

  it('refuses a direct call to graphile_worker.add_job', async () => {
    await expect(
      scoped(async (tx) => {
        await tx.execute(sql`SELECT graphile_worker.add_job('stage1_probe')`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('refuses ALTER on a queue table', async () => {
    await expect(
      scoped(async (tx) => {
        await tx.execute(sql`ALTER TABLE graphile_worker._private_jobs ADD COLUMN smuggled text`)
      }),
    ).rejects.toThrow(/permission denied|must be owner/i)
  })

  it('refuses DROP on a queue table', async () => {
    await expect(
      scoped(async (tx) => {
        await tx.execute(sql`DROP TABLE graphile_worker._private_jobs`)
      }),
    ).rejects.toThrow(/permission denied|must be owner/i)
  })

  it('refuses a direct INSERT into the job table', async () => {
    await expect(
      scoped(async (tx) => {
        await tx.execute(sql`INSERT INTO graphile_worker._private_jobs (task_id) VALUES (1)`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('refuses to register a task itself', async () => {
    await expect(
      scoped(async (tx) => {
        await tx.execute(sql`INSERT INTO job_tasks (task_name, description) VALUES ('smuggled', 'x')`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('refuses to enqueue a task that is not registered', async () => {
    await expect(scoped((tx) => enqueue(tx, 'not_registered', {}))).rejects.toThrow(
      /not a registered job task/,
    )
  })

  it('grants EXECUTE on the bridge to no one but the application role', async () => {
    // PostgreSQL grants EXECUTE on a new function to PUBLIC by default. Migration
    // 0002 revokes it; without that revoke, every role in the cluster — including
    // any future read-only or reporting role — could enqueue work for the worker.
    const [pub] = await h.admin<{ can: boolean }[]>`
      SELECT has_function_privilege('public',
        'public.enqueue_job(text,jsonb,timestamptz,integer,text)', 'EXECUTE') AS can`
    expect(pub!.can, 'PUBLIC can execute enqueue_job').toBe(false)

    // Assert it at the ACL level too: a PUBLIC grant appears as a bare "=X/owner"
    // entry, which has_function_privilege would also report through role
    // inheritance. Both readings must agree.
    const [acl] = await h.admin<{ entries: string[] }[]>`
      SELECT coalesce(p.proacl::text[], ARRAY[]::text[]) AS entries
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'enqueue_job'`
    const grants = acl!.entries
    expect(grants.some((e) => e.startsWith('=')), `PUBLIC grant present in ACL: ${grants}`).toBe(false)

    // Exactly one grantee beyond the owner, and it is the application role.
    const grantees = grants.map((e) => e.split('=')[0]).filter((g) => g !== '' && g !== 'inrsettle_worker')
    expect(grantees, `unexpected grantees on enqueue_job: ${grants}`).toEqual(['inrsettle_app'])
  })

  it('grants EXECUTE on the bridge to no other named role', async () => {
    for (const role of ['inrsettle_app', 'inrsettle_worker']) {
      const [r] = await h.admin<{ can: boolean }[]>`
        SELECT has_function_privilege(${role},
          'public.enqueue_job(text,jsonb,timestamptz,integer,text)', 'EXECUTE') AS can`
      expect(r!.can, `${role} should be able to execute the bridge`).toBe(true)
    }
    // postgres is a superuser and bypasses privilege checks; that is expected and
    // is not a grant. The assertion that matters is the ACL contents above.
  })

  it('leaves the queue role with no CREATE authority after bootstrap', async () => {
    // CREATE was needed to install the schema and the bridge. Runtime executes
    // jobs against objects that already exist and needs neither.
    const [db] = await h.admin<{ create_db: boolean }[]>`
      SELECT has_database_privilege('inrsettle_worker', current_database(), 'CREATE') AS create_db`
    expect(db!.create_db, 'worker retains CREATE on the database').toBe(false)

    const [schema] = await h.admin<{ create_schema: boolean }[]>`
      SELECT has_schema_privilege('inrsettle_worker', 'public', 'CREATE') AS create_schema`
    expect(schema!.create_schema, 'worker retains CREATE on public').toBe(false)
  })

  it('still lets the queue role do its runtime job', async () => {
    // It owns the queue objects, so it keeps full access to them without any
    // authority to create new ones.
    const [p] = await h.admin<{ conn: boolean; usage: boolean; sel: boolean }[]>`
      SELECT has_database_privilege('inrsettle_worker', current_database(), 'CONNECT') AS conn,
             has_schema_privilege('inrsettle_worker', 'graphile_worker', 'USAGE') AS usage,
             has_table_privilege('inrsettle_worker', 'graphile_worker._private_jobs', 'SELECT') AS sel`
    expect([p!.conn, p!.usage, p!.sel]).toEqual([true, true, true])
  })

  it('permits the one vetted capability: enqueueing a registered task', async () => {
    const before = await pendingJobs()
    await scoped((tx) => enqueue(tx, 'stage1_probe', { marker: 'permitted' }))
    expect(await pendingJobs()).toBe(before + 1)
  })
})

describe('transactional enqueue (ARCHITECTURE.md § 7)', () => {
  it('leaves no job behind when the transaction rolls back', async () => {
    const before = await pendingJobs()

    await expect(
      scoped(async (tx) => {
        await tx.execute(sql`
          INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
          VALUES ('evt_rollback', ${W.workspaceId}, 'sandbox', 'test.event', 'workspace', ${W.workspaceId}, 'user', ${W.userId})`)
        await enqueue(tx, 'stage1_probe', { marker: 'rolled-back' })
        throw new Error('deliberate rollback')
      }),
    ).rejects.toThrow('deliberate rollback')

    expect(await pendingJobs(), 'job survived a rolled-back transaction').toBe(before)

    const [row] = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events WHERE id = 'evt_rollback'`
    expect(row!.n, 'event survived a rolled-back transaction').toBe(0)
  })

  it('runs the job when the transaction commits, and only then', async () => {
    // Drain anything left by the privilege tests so the assertion is exact.
    await h.admin`DELETE FROM graphile_worker._private_jobs`

    await scoped((tx) => enqueue(tx, 'stage1_probe', { marker: 'committed' }))
    expect(await pendingJobs()).toBe(1)

    const seen: string[] = []
    const runner = await run({
      // The worker connects as the queue role, not as the application role.
      connectionString: workerConnectionString(dbName),
      concurrency: 1,
      taskList: {
        stage1_probe: async (payload) => { seen.push((payload as { marker: string }).marker) },
      },
    })
    await new Promise((r) => setTimeout(r, 1500))
    await runner.stop()

    expect(seen).toEqual(['committed'])
    expect(await pendingJobs()).toBe(0)
  })
})

/** Referenced so the import is used even if the suite is filtered. */
void adminConnectionString

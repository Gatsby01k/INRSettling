/**
 * Integration harness.
 *
 * Every integration test runs against a real Postgres with the real migration
 * applied and connects as `inrsettle_app` — the runtime role, without
 * BYPASSRLS. Testing isolation as a superuser would prove nothing.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import postgres from 'postgres'
import { createClient, type Db } from '@inrsettle/db'
import { loadPayoutMappings, loadReferenceData } from '@inrsettle/app-services'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '..', '..', 'db', 'migrations')
/**
 * The two migrations that cannot run here.
 *
 * `0002` installs the Graphile Worker bridge and `0003` revokes the bootstrap
 * privilege it needed; both require the worker's own migrations to have run
 * first, which `withJobQueue()` below does for the tests that need a queue.
 */
const WORKER_MIGRATIONS = new Set(['0002_job_queue_bridge.sql', '0003_revoke_bootstrap.sql'])

/**
 * A migration that registers a job class, and therefore belongs to the queue.
 *
 * `job_tasks` is created and owned by the queue role in `0002`, so a migration
 * that inserts into it cannot run in a database without a queue — and must run
 * *as* that role. Recognised by a filename convention rather than listed,
 * because a list that must be edited in lockstep with a directory eventually is
 * not; that lesson cost a whole stage's tests once already, immediately below.
 */
const isJobRegistration = (file: string): boolean => file.endsWith('_job.sql')

/**
 * Applied to every test database, in filename order, as the database owner.
 *
 * **Discovered, not listed.** This was a hardcoded array, and adding migration
 * `0006` did not add it here — so every Stage 4 test failed with "relation
 * liquidity_facilities does not exist" against a schema that was perfectly
 * correct. A list that must be edited in lockstep with a directory will
 * eventually not be, and the failure it produces points at the wrong thing.
 */
function baseMigrations(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !WORKER_MIGRATIONS.has(f) && !isJobRegistration(f))
    .sort()
}
const REFERENCE_DIR = join(here, '..', '..', '..', 'reference', 'preflight')
const PAYOUT_MAPPING_DIR = join(here, '..', '..', '..', 'reference', 'payout-mappings')

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/postgres'

function adminUrlFor(db: string): string {
  const u = new URL(ADMIN_URL)
  u.pathname = `/${db}`
  return u.toString()
}

export interface Harness {
  db: Db
  /** Superuser handle — provisioning only, never used to assert isolation. */
  admin: postgres.Sql
  close: () => Promise<void>
}

export async function createTestDatabase(name: string): Promise<Harness> {
  const dbName = `inrsettle_test_${name}_${process.pid}`
  const root = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  await root.unsafe(`DROP DATABASE IF EXISTS ${dbName}`)
  await root.unsafe(`CREATE DATABASE ${dbName}`)
  await root.end({ timeout: 5 })

  const admin = postgres(adminUrlFor(dbName), { max: 2, onnotice: () => {} })
  for (const file of baseMigrations()) {
    await admin.unsafe(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  // Reference data is part of a working database, not test scaffolding: the
  // same loader runs here and in deployment, from the same files.
  await loadReferenceData(admin, REFERENCE_DIR)
  await loadPayoutMappings(admin, PAYOUT_MAPPING_DIR)

  // Give the runtime role a way to log in. In production this is a separate
  // credential from the secret manager; the role's lack of BYPASSRLS is what
  // matters and is set by the migration.
  await admin.unsafe(`ALTER ROLE inrsettle_app LOGIN`)
  await admin.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO inrsettle_app`)

  // The named cross-tenant read role (migration 0017), when the database has
  // it. Deployment gives it its own credential; the harness gives it a login
  // for the same reason it gives one to the application role. What matters —
  // NOBYPASSRLS, SELECT-only, and no membership either way with the app role —
  // is set by the migration and asserted by the isolation gate.
  const hasOps = await admin<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrsettle_ops') AS ok`
  if (hasOps[0]?.ok === true) {
    await admin.unsafe(`ALTER ROLE inrsettle_ops LOGIN`)
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO inrsettle_ops`)
  }

  const appUrl = (() => {
    const u = new URL(adminUrlFor(dbName))
    u.username = 'inrsettle_app'
    return u.toString()
  })()
  const { db, close } = createClient(appUrl, { max: 4 })

  return {
    db,
    admin,
    /**
     * Close the pools **and drop the database**.
     *
     * Creation already does `DROP DATABASE IF EXISTS`, which makes a *re-run*
     * clean — but only for the same process id. Every suite in every previous
     * run left its database behind, and by Stage 8 that was 512 of them and
     * five gigabytes, at which point the cluster stopped accepting connections
     * mid-suite and twenty-two files failed with `ECONNREFUSED`. The symptom
     * pointed at the tests; the cause was every test that had ever run.
     *
     * `WITH (FORCE)` because a suite that failed may have left a connection
     * open, and a cleanup that can be blocked by the failure it is cleaning up
     * after is not a cleanup. Set `KEEP_TEST_DATABASES=1` to keep one for
     * inspection.
     */
    close: async () => {
      await close()
      await admin.end({ timeout: 5 })
      if (process.env['KEEP_TEST_DATABASES'] === '1') return
      const root = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
      try {
        await root.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      } catch {
        // A database left behind is untidy; a test suite that fails in its
        // teardown is misleading. Untidy wins.
      } finally {
        await root.end({ timeout: 5 })
      }
    },
  }
}

/** Provisioning goes through the admin handle: creating a tenant is not a tenant-scoped act. */
export async function seedWorkspace(
  admin: postgres.Sql,
  args: {
    workspaceId: string
    userId: string
    email: string
    /** A set, not one value: SECURITY.md § 3.2 grants admin + approver together. */
    roles?: readonly string[]
    /** Seed a verified second factor; sessions are impossible without one. */
    verifiedMfa?: 'totp' | 'webauthn' | null
  },
): Promise<void> {
  const roles = args.roles ?? ['approver']
  await admin`INSERT INTO workspaces (id, name) VALUES (${args.workspaceId}, ${args.workspaceId})`
  await admin`
    INSERT INTO users (id, email) VALUES (${args.userId}, ${args.email})
    ON CONFLICT (id) DO NOTHING`

  const mfa = args.verifiedMfa === undefined ? 'totp' : args.verifiedMfa
  if (mfa) {
    await admin`
      INSERT INTO user_mfa_methods (id, user_id, method, verified_at)
      VALUES (${`mfa_${args.userId}`}, ${args.userId}, ${mfa}::mfa_method, now())
      ON CONFLICT (id) DO NOTHING`
  }

  for (const env of ['sandbox', 'live']) {
    const membershipId = `mem_${args.workspaceId}_${args.userId}_${env}`
    await admin`
      INSERT INTO memberships (id, workspace_id, environment, user_id)
      VALUES (${membershipId}, ${args.workspaceId}, ${env}::environment, ${args.userId})`
    for (const role of roles) {
      await admin`
        INSERT INTO membership_roles (membership_id, workspace_id, environment, role)
        VALUES (${membershipId}, ${args.workspaceId}, ${env}::environment, ${role}::workspace_role)`
    }
  }
}

/** Add a second user to an existing workspace. */
export async function seedUser(
  admin: postgres.Sql,
  args: {
    workspaceId: string
    userId: string
    email: string
    roles: readonly string[]
    environments?: readonly string[]
    verifiedMfa?: 'totp' | 'webauthn' | null
  },
): Promise<void> {
  await admin`
    INSERT INTO users (id, email) VALUES (${args.userId}, ${args.email})
    ON CONFLICT (id) DO NOTHING`
  const mfa = args.verifiedMfa === undefined ? 'totp' : args.verifiedMfa
  if (mfa) {
    await admin`
      INSERT INTO user_mfa_methods (id, user_id, method, verified_at)
      VALUES (${`mfa_${args.userId}`}, ${args.userId}, ${mfa}::mfa_method, now())
      ON CONFLICT (id) DO NOTHING`
  }
  for (const env of args.environments ?? ['sandbox', 'live']) {
    const membershipId = `mem_${args.workspaceId}_${args.userId}_${env}`
    await admin`
      INSERT INTO memberships (id, workspace_id, environment, user_id)
      VALUES (${membershipId}, ${args.workspaceId}, ${env}::environment, ${args.userId})
      ON CONFLICT (id) DO NOTHING`
    for (const role of args.roles) {
      await admin`
        INSERT INTO membership_roles (membership_id, workspace_id, environment, role)
        VALUES (${membershipId}, ${args.workspaceId}, ${env}::environment, ${role}::workspace_role)
        ON CONFLICT DO NOTHING`
    }
  }
}


/**
 * Install the job queue under least privilege.
 *
 * Graphile Worker's migrations run as `inrsettle_worker`, which therefore owns
 * every queue object. Migration 0002 then creates the enqueue bridge, also as
 * `inrsettle_worker`, so the SECURITY DEFINER function carries the queue role's
 * rights rather than the application's.
 *
 * `inrsettle_app` ends up with EXECUTE on `public.enqueue_job` and nothing else
 * — no ownership, no DDL, no direct access to the queue at all. This is the
 * real deployment sequence, not a test convenience; it belongs in the ops
 * runbook before Stage 8.
 */
export async function installJobQueue(
  admin: postgres.Sql,
  runMigrations: (opts: { connectionString: string }) => Promise<void>,
  dbName: string,
): Promise<void> {
  const workerUrl = (() => {
    const u = new URL(adminUrlFor(dbName))
    u.username = 'inrsettle_worker'
    return u.toString()
  })()

  await admin.unsafe(`ALTER ROLE inrsettle_worker LOGIN`)
  // Bootstrap privilege, granted for the migration step and revoked after it.
  await admin.unsafe(`GRANT CONNECT, CREATE ON DATABASE ${dbName} TO inrsettle_worker`)

  // Queue schema created and owned by the queue role.
  await runMigrations({ connectionString: workerUrl })

  // Bridge applied as the queue role, so the definer rights are its own.
  const worker = postgres(workerUrl, { max: 1, onnotice: () => {} })
  try {
    await worker.unsafe(
      readFileSync(join(here, '..', '..', 'db', 'migrations', '0002_job_queue_bridge.sql'), 'utf8'),
    )
    // …then every job-class registration, in filename order. These insert into
    // `job_tasks`, which the bridge above created and this role owns.
    for (const file of readdirSync(MIGRATIONS_DIR).filter(isJobRegistration).sort()) {
      await worker.unsafe(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
  } finally {
    await worker.end({ timeout: 5 })
  }

  // 0003 drops bootstrap privilege, and must be applied by the role that
  // granted it — the worker cannot revoke a grant it did not make.
  await admin.unsafe(
    readFileSync(join(here, '..', '..', 'db', 'migrations', '0003_revoke_bootstrap.sql'), 'utf8'),
  )
  await admin.unsafe(`REVOKE CREATE ON DATABASE ${dbName} FROM inrsettle_worker`)
}

/** Register a task so `enqueue_job` will accept it. Migrations do this in production. */
export async function registerJobTask(
  admin: postgres.Sql,
  taskName: string,
  description = 'test task',
): Promise<void> {
  await admin`
    INSERT INTO job_tasks (task_name, description) VALUES (${taskName}, ${description})
    ON CONFLICT (task_name) DO NOTHING`
}

/** A connection string for the named cross-tenant read role — what `ops` uses. */
export function opsConnectionString(dbName: string): string {
  const u = new URL(adminUrlFor(dbName))
  u.username = 'inrsettle_ops'
  return u.toString()
}

/** A pool connected as the queue role — what the worker process uses. */
export function workerConnectionString(dbName: string): string {
  const u = new URL(adminUrlFor(dbName))
  u.username = 'inrsettle_worker'
  return u.toString()
}

/** The admin connection string for a harness database, for tools that need their own. */
export function adminConnectionString(dbName: string): string {
  return adminUrlFor(dbName)
}

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { runMigrations } from 'graphile-worker'
import { loadPayoutMappings, loadReferenceData } from '@inrsettle/app-services'
import { databaseUrl, sandboxOnly } from './config.js'

const root = new URL('../../../', import.meta.url)
const migrations = new URL('packages/db/migrations/', root)

/** A dedicated sandbox database; never imports the destructive test harness. */
export async function migrateSandbox(env: NodeJS.ProcessEnv): Promise<void> {
  sandboxOnly(env)
  const admin = postgres(databaseUrl(env, 'INRSETTLE_ADMIN_DATABASE_URL'), { max: 2, onnotice: () => {} })
  const workerUrl = databaseUrl(env, 'INRSETTLE_WORKER_DATABASE_URL', 'inrsettle_worker')
  const connection = await admin.reserve()
  try {
    await connection`SELECT pg_advisory_lock(718204912)`
    await connection`CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`
    const apply = async (name: string) => {
      const source = await readFile(new URL(name, migrations), 'utf8')
      const hash = createHash('sha256').update(source).digest('hex')
      const seen = await connection`SELECT sha256 FROM runtime_schema_migrations WHERE name = ${name}`
      if (seen.length) {
        if (seen[0]!['sha256'] !== hash) throw new Error(`Applied migration ${name} has changed; create a forward migration`)
        return
      }
      await connection.unsafe('BEGIN')
      try {
        await connection.unsafe(source)
        await connection`INSERT INTO runtime_schema_migrations(name, sha256) VALUES (${name}, ${hash})`
        await connection.unsafe('COMMIT')
      } catch (error) { await connection.unsafe('ROLLBACK'); throw error }
    }
    const names = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()
    for (const name of names) {
      if (name.startsWith('0002_') || name.startsWith('0003_') || name.endsWith('_job.sql')) continue
      await apply(name)
    }
    const databaseRows = await connection<{ name: string }[]>`SELECT current_database() AS name`
    const dbName = databaseRows[0]!.name
    for (const [role, urlName] of [
      ['inrsettle_app', 'INRSETTLE_DATABASE_URL'],
      ['inrsettle_worker', 'INRSETTLE_WORKER_DATABASE_URL'],
      ['inrsettle_simulator', 'INRSETTLE_SIMULATOR_DATABASE_URL'],
    ]) {
      const url = new URL(databaseUrl(env, urlName!, role!))
      const adminParsed = new URL(databaseUrl(env, 'INRSETTLE_ADMIN_DATABASE_URL'))
      if (url.host !== adminParsed.host || url.pathname !== adminParsed.pathname) throw new Error('All sandbox URLs must refer to the same database')
      if (role === 'inrsettle_simulator') await connection.unsafe('DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = \'inrsettle_simulator\') THEN CREATE ROLE inrsettle_simulator NOLOGIN NOBYPASSRLS; END IF; END $$')
      const commands = await connection<{ command: string }[]>`SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', ${role!}::text, ${decodeURIComponent(url.password)}::text) AS command`
      await connection.unsafe(commands[0]!.command)
      const grants = await connection<{ command: string }[]>`SELECT format('GRANT CONNECT ON DATABASE %I TO %I', ${dbName!}::text, ${role!}::text) AS command`
      await connection.unsafe(grants[0]!.command)
    }
    const grant = await connection<{ command: string }[]>`SELECT format('GRANT CREATE ON DATABASE %I TO inrsettle_worker', ${dbName!}::text) AS command`
    await connection.unsafe(grant[0]!.command)
    try {
      await runMigrations({ connectionString: workerUrl })
      const worker = postgres(workerUrl, { max: 1, onnotice: () => {} })
      try {
        // The bridge and task registrations are journalled atomically by the
        // queue owner, avoiding a partially installed bridge after a crash.
        await connection`GRANT SELECT, INSERT ON runtime_schema_migrations TO inrsettle_worker`
        for (const name of names.filter(n => n.startsWith('0002_') || n.endsWith('_job.sql'))) {
          const source = await readFile(new URL(name, migrations), 'utf8')
          const hash = createHash('sha256').update(source).digest('hex')
          const seen = await connection`SELECT sha256 FROM runtime_schema_migrations WHERE name = ${name}`
          if (seen.length) {
            if (seen[0]!['sha256'] !== hash) throw new Error(`Applied migration ${name} has changed`)
          } else await worker.begin(async tx => {
            await tx.unsafe(source)
            await tx`INSERT INTO runtime_schema_migrations(name, sha256) VALUES (${name}, ${hash})`
          })
        }
      } finally { await worker.end({ timeout: 5 }) }
    } finally {
      await connection`REVOKE ALL ON runtime_schema_migrations FROM inrsettle_worker`
      const revoke = await connection<{ command: string }[]>`SELECT format('REVOKE CREATE ON DATABASE %I FROM inrsettle_worker', ${dbName!}::text) AS command`
      await connection.unsafe(revoke[0]!.command)
    }
    for (const name of names.filter(n => n.startsWith('0003_'))) await apply(name)
    await connection.unsafe(`CREATE SCHEMA IF NOT EXISTS sandbox_provider;
      REVOKE ALL ON SCHEMA sandbox_provider FROM PUBLIC;
      GRANT USAGE ON SCHEMA sandbox_provider TO inrsettle_simulator;
      CREATE TABLE IF NOT EXISTS sandbox_provider.operations (
        workspace_id text NOT NULL, environment text NOT NULL CHECK(environment = 'sandbox'),
        operation_key text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL,
        amount_minor bigint NOT NULL, amount_currency text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id, environment, operation_key));
      GRANT SELECT, INSERT ON sandbox_provider.operations TO inrsettle_simulator;`)
    await loadReferenceData(admin, fileURLToPath(new URL('reference/preflight/', root)))
    await loadPayoutMappings(admin, fileURLToPath(new URL('reference/payout-mappings/', root)))
  } finally {
    await connection`SELECT pg_advisory_unlock(718204912)`
    connection.release()
    await admin.end({ timeout: 5 })
  }
}

#!/usr/bin/env node
/**
 * A role is created before anything names it.
 *
 * This gate exists because of a real defect, and the shape of that defect is
 * why a *test* could not have caught it: migration `0017` created a policy
 * `TO inrsettle_ops` twenty lines before it created the role. Every test passed.
 *
 * Roles in Postgres are **cluster-global** while migrations are per-database. The
 * first test database to apply `0017` failed — and left the role behind, because
 * the `CREATE ROLE` had already run in an earlier statement of a later section.
 * Every database created after that found the role already there and applied
 * cleanly. So the suite went green, on a cluster that had been poisoned into
 * hiding the bug, and would have failed exactly once: on the first deployment to
 * a fresh cluster.
 *
 * The lesson generalises past this one file. Anything cluster-global — roles,
 * tablespaces — can be left behind by a partial run and mask an ordering error
 * for every run after it. So this is a **static** check over the migration text,
 * which cannot be fooled by state:
 *
 *   for every migration, in filename order, a role named in a GRANT, a POLICY,
 *   an ALTER … OWNER TO or a REVOKE must already have been created — earlier in
 *   the same file, or in an earlier migration.
 *
 * Static rather than executed, so it runs in a second with no database at all,
 * and so it is honest about ordering rather than about whatever the local
 * cluster happens to contain.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.argv[2] ?? process.cwd()
const MIGRATIONS = join(ROOT, 'packages', 'db', 'migrations')

/** Roles Postgres ships with. Never created by a migration, always available. */
const BUILT_IN = new Set([
  'postgres', 'public', 'current_user', 'session_user', 'pg_monitor',
  'pg_read_all_data', 'pg_write_all_data', 'pg_signal_backend',
  'pg_read_all_settings', 'pg_read_all_stats', 'pg_stat_scan_tables',
  'pg_database_owner', 'pg_checkpoint', 'pg_use_reserved_connections',
  'pg_create_subscription',
])

const stripComments = (sql) =>
  sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * Where each statement mentioning a role starts, so "before" can be decided by
 * character offset within the file rather than by hope.
 */
function referencesInOrder(sql) {
  const found = []

  // `CREATE ROLE x`, including inside a DO block.
  for (const m of sql.matchAll(/\bCREATE\s+(?:ROLE|USER)\s+([a-z_][a-z0-9_$]*)/gi)) {
    found.push({ at: m.index, kind: 'create', role: m[1].toLowerCase() })
  }

  // `… TO role[, role]` — GRANT, REVOKE (FROM), CREATE POLICY … TO.
  for (const m of sql.matchAll(/\bGRANT\b[\s\S]{0,4000}?\bTO\s+([a-z_][a-z0-9_$,\s]*?)(?:;|\bWITH\b)/gi)) {
    for (const role of m[1].split(',')) {
      found.push({ at: m.index, kind: 'use', role: role.trim().toLowerCase() })
    }
  }
  for (const m of sql.matchAll(/\bREVOKE\b[\s\S]{0,4000}?\bFROM\s+([a-z_][a-z0-9_$,\s]*?);/gi)) {
    for (const role of m[1].split(',')) {
      found.push({ at: m.index, kind: 'use', role: role.trim().toLowerCase() })
    }
  }
  for (const m of sql.matchAll(/\bCREATE\s+POLICY\b[\s\S]{0,2000}?\bTO\s+([a-z_][a-z0-9_$,\s]*?)\s+USING/gi)) {
    for (const role of m[1].split(',')) {
      found.push({ at: m.index, kind: 'use', role: role.trim().toLowerCase() })
    }
  }
  for (const m of sql.matchAll(/\bOWNER\s+TO\s+([a-z_][a-z0-9_$]*)/gi)) {
    found.push({ at: m.index, kind: 'use', role: m[1].toLowerCase() })
  }
  // `ALTER ROLE x …` also needs x to exist.
  for (const m of sql.matchAll(/\bALTER\s+ROLE\s+([a-z_][a-z0-9_$]*)/gi)) {
    found.push({ at: m.index, kind: 'use', role: m[1].toLowerCase() })
  }

  return found.sort((a, b) => a.at - b.at)
}

/** Rough 1-indexed line number for an offset, so the message points somewhere. */
const lineAt = (sql, offset) => sql.slice(0, offset).split('\n').length

const problems = []

if (!existsSync(MIGRATIONS)) {
  console.log('Migration-order check skipped: no migrations directory.')
  process.exit(0)
}

// Filename order is application order, which is the property the whole
// migration system rests on.
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()

/** Roles created by migrations applied before the one being checked. */
const createdEarlier = new Set()

for (const file of files) {
  const raw = readFileSync(join(MIGRATIONS, file), 'utf8')
  const sql = stripComments(raw)
  const createdHere = new Set()

  for (const ref of referencesInOrder(sql)) {
    if (ref.kind === 'create') {
      createdHere.add(ref.role)
      continue
    }
    if (BUILT_IN.has(ref.role) || ref.role === '') continue
    if (createdEarlier.has(ref.role) || createdHere.has(ref.role)) continue

    problems.push(
      `${relative(ROOT, join(MIGRATIONS, file))}:${lineAt(sql, ref.at)}: ` +
      `references role "${ref.role}" before it is created. ` +
      'Roles are cluster-global and migrations are per-database, so a cluster ' +
      'that already has the role from another database will apply this cleanly ' +
      'and hide the defect until the first deployment to a fresh one.',
    )
  }

  for (const role of createdHere) createdEarlier.add(role)
}

if (problems.length > 0) {
  console.error('Migration-order check failed:\n')
  for (const problem of problems) console.error(`  ${problem}\n`)
  console.error(
    'Create the role before the first GRANT, POLICY, REVOKE or OWNER TO that names it.',
  )
  process.exit(1)
}

console.log(
  `Migration order clean: ${files.length} migrations, every role created before it is used.`,
)

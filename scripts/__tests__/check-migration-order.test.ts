/**
 * The migration-order gate, proved against the defect that motivated it.
 *
 * The first test below is the real one: it reconstructs the exact shape of
 * migration `0017`'s original ordering — a policy `TO inrsettle_ops` before the
 * `CREATE ROLE` — and asserts the gate rejects it. That defect passed every
 * test in the suite, because roles are cluster-global: the first database to
 * apply it failed *after* creating the role, and every database created
 * afterwards found the role already there and applied cleanly.
 *
 * A gate that has never rejected anything is indistinguishable from one that
 * cannot, and the near-misses matter as much: a check that flagged a legitimate
 * `DO $$ … CREATE ROLE … $$` block, or `TO public`, would be switched off within
 * a week and then the real ordering bug ships.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'check-migration-order.mjs')

/** Write migrations under a throwaway root, in the order given. */
function runOn(migrations: Readonly<Record<string, string>>): { ok: boolean; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'migorder-'))
  const dir = join(root, 'packages', 'db', 'migrations')
  mkdirSync(dir, { recursive: true })
  for (const [name, sql] of Object.entries(migrations)) {
    writeFileSync(join(dir, name), sql)
  }
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const CREATE_OPS = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrsettle_ops') THEN
    CREATE ROLE inrsettle_ops NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
`

describe('the defect this gate exists for', () => {
  it('rejects a policy that names a role created later in the same file', () => {
    // Migration 0017's original ordering, reconstructed.
    const { ok, out } = runOn({
      '0017_ops.sql': [
        'CREATE TABLE operator_actions (id text PRIMARY KEY);',
        'ALTER TABLE operator_actions ENABLE ROW LEVEL SECURITY;',
        "CREATE POLICY operator_actions_ops ON operator_actions",
        '  AS PERMISSIVE FOR SELECT TO inrsettle_ops USING (true);',
        CREATE_OPS,
        'GRANT SELECT ON operator_actions TO inrsettle_ops;',
      ].join('\n'),
    })
    expect(ok, 'the gate must reject the original ordering').toBe(false)
    expect(out).toMatch(/references role "inrsettle_ops" before it is created/)
    expect(out).toMatch(/cluster-global/)
  })

  it('rejects a grant that names a role created only in a later migration', () => {
    // The same class, spread across files: filename order is application order.
    const { ok, out } = runOn({
      '0001_first.sql': 'GRANT SELECT ON t TO inrsettle_ops;',
      '0002_second.sql': CREATE_OPS,
    })
    expect(ok).toBe(false)
    expect(out).toMatch(/0001_first\.sql/)
  })

  it('rejects a REVOKE from a role that does not exist yet', () => {
    const { ok } = runOn({ '0001_a.sql': 'REVOKE EXECUTE ON FUNCTION f() FROM inrsettle_ops;' })
    expect(ok).toBe(false)
  })

  it('rejects an ALTER … OWNER TO a role that does not exist yet', () => {
    const { ok } = runOn({ '0001_a.sql': 'ALTER FUNCTION f() OWNER TO inrsettle_resolver;' })
    expect(ok).toBe(false)
  })

  it('rejects ALTER ROLE before CREATE ROLE', () => {
    const { ok } = runOn({ '0001_a.sql': 'ALTER ROLE inrsettle_ops LOGIN;' })
    expect(ok).toBe(false)
  })
})

describe('what the gate must not reject', () => {
  it('accepts the corrected ordering', () => {
    const { ok, out } = runOn({
      '0017_ops.sql': [
        CREATE_OPS,
        'GRANT USAGE ON SCHEMA public TO inrsettle_ops;',
        'CREATE TABLE operator_actions (id text PRIMARY KEY);',
        'CREATE POLICY operator_actions_ops ON operator_actions',
        '  AS PERMISSIVE FOR SELECT TO inrsettle_ops USING (true);',
      ].join('\n'),
    })
    expect(ok, out).toBe(true)
  })

  it('accepts a role created in an earlier migration', () => {
    const { ok } = runOn({
      '0001_first.sql': CREATE_OPS,
      '0002_second.sql': 'GRANT SELECT ON t TO inrsettle_ops;',
    })
    expect(ok).toBe(true)
  })

  it('accepts the built-in roles, which no migration creates', () => {
    const { ok } = runOn({
      '0001_a.sql': [
        'GRANT SELECT ON t TO public;',
        'REVOKE ALL ON FUNCTION f() FROM public;',
        'GRANT SELECT ON t TO postgres;',
      ].join('\n'),
    })
    expect(ok).toBe(true)
  })

  it('does not read a comment naming a role as a reference to it', () => {
    // Migration 0017 discusses `GRANT inrsettle_ops TO inrsettle_app` in prose,
    // to say it must never exist. A gate that failed on the file explaining
    // itself would be switched off the same afternoon.
    const { ok } = runOn({
      '0001_a.sql': [
        '-- GRANT SELECT ON t TO inrsettle_ops would be wrong here.',
        '/* and so would GRANT SELECT ON t TO inrsettle_ops */',
        CREATE_OPS,
      ].join('\n'),
    })
    expect(ok).toBe(true)
  })

  it('accepts a grant to several roles at once, once all exist', () => {
    const { ok } = runOn({
      '0001_a.sql': [
        'CREATE ROLE inrsettle_app NOLOGIN;',
        'CREATE ROLE inrsettle_worker NOLOGIN;',
        'GRANT SELECT, INSERT ON t TO inrsettle_app, inrsettle_worker;',
      ].join('\n'),
    })
    expect(ok).toBe(true)
  })

  it('accepts a column-list grant, whose parentheses are not a role', () => {
    const { ok } = runOn({
      '0001_a.sql': [
        'CREATE ROLE inrsettle_ops NOLOGIN;',
        'GRANT SELECT (id, workspace_id, environment) ON t TO inrsettle_ops;',
      ].join('\n'),
    })
    expect(ok).toBe(true)
  })

  it('says nothing when there are no migrations at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'migorder-empty-'))
    const out = execFileSync('node', [SCRIPT, root], { encoding: 'utf8' })
    expect(out).toMatch(/skipped/)
  })
})

/**
 * The Internal Operations boundary gate, proved to actually fail.
 *
 * A build gate that has never rejected anything is indistinguishable from one
 * that cannot. These give it the four violations it exists for, and — more
 * importantly — the near-misses, because the near-misses decide whether anyone
 * leaves it switched on. A gate that flags migration `0017`'s own warning about
 * the grant it forbids gets disabled within a week, and then the real grant
 * ships.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'check-ops-boundaries.mjs')

interface Tree {
  readonly migration?: string
  readonly opsService?: string
  readonly opsApp?: string
}

function runOn(tree: Tree): { ok: boolean; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'opsbound-'))
  if (tree.migration !== undefined) {
    const dir = join(root, 'packages', 'db', 'migrations')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '9999_test.sql'), tree.migration)
  }
  if (tree.opsService !== undefined) {
    const dir = join(root, 'packages', 'app', 'src', 'ops')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'thing.service.ts'), tree.opsService)
  }
  if (tree.opsApp !== undefined) {
    const dir = join(root, 'apps', 'ops', 'src', 'handlers')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), tree.opsApp)
  }
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('what the gate must reject', () => {
  it('rejects a write privilege granted to the ops role', () => {
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ALL']) {
      const { ok, out } = runOn({
        migration: `GRANT ${privilege} ON settlements TO inrsettle_ops;\n`,
      })
      expect(ok, privilege).toBe(false)
      expect(out).toMatch(new RegExp(`granted ${privilege}`))
    }
  })

  it('rejects a write hidden beside a legitimate SELECT', () => {
    const { ok, out } = runOn({
      migration: 'GRANT SELECT, UPDATE ON settlements TO inrsettle_ops;\n',
    })
    expect(ok).toBe(false)
    expect(out).toMatch(/granted UPDATE/)
  })

  it('rejects a role membership in either direction', () => {
    for (const grant of [
      'GRANT inrsettle_ops TO inrsettle_app;',
      'GRANT inrsettle_app TO inrsettle_ops;',
    ]) {
      const { ok, out } = runOn({ migration: `${grant}\n` })
      expect(ok, grant).toBe(false)
      expect(out).toMatch(/member of/)
    }
  })

  it('rejects an ops service that writes without recording who and why', () => {
    const { ok, out } = runOn({
      opsService: [
        "import { schema } from '@inrsettle/db'",
        'export async function quietlyFix(tx) {',
        '  await tx.update(schema.settlements).set({ status: 1 })',
        '}',
      ].join('\n'),
    })
    expect(ok).toBe(false)
    expect(out).toMatch(/writes without calling writeOperatorRecord/)
  })

  it('rejects an ops handler reaching a settlement service directly', () => {
    const { ok, out } = runOn({
      opsApp: "import { applyTransition } from '../../../packages/app/src/settlement.service.js'\n",
    })
    expect(ok).toBe(false)
    expect(out).toMatch(/imports settlement\.service directly/)
  })
})

describe('what the gate must not reject', () => {
  it('accepts SELECT, which is the only grant the ops role may hold', () => {
    const { ok } = runOn({
      migration: [
        'GRANT SELECT ON settlements TO inrsettle_ops;',
        'GRANT SELECT (id, workspace_id, account_number_last4)',
        '  ON payout_destination_versions TO inrsettle_ops;',
        'GRANT USAGE ON SCHEMA public TO inrsettle_ops;',
      ].join('\n'),
    })
    expect(ok).toBe(true)
  })

  it('accepts a column list that happens to name a column called "update"', () => {
    // Column lists are not privileges. A gate that read one as a grant would
    // fail on a schema nobody can change.
    const { ok } = runOn({
      migration: 'GRANT SELECT (id, updated_at, deleted_at) ON settlements TO inrsettle_ops;\n',
    })
    expect(ok).toBe(true)
  })

  it('accepts writes granted to the application role, which is the whole design', () => {
    const { ok } = runOn({
      migration: 'GRANT SELECT, INSERT, UPDATE ON settlements TO inrsettle_app;\n',
    })
    expect(ok).toBe(true)
  })

  it('does not read a comment warning against the grant as the grant itself', () => {
    // Migration 0017 says, in prose, that `GRANT inrsettle_ops TO inrsettle_app`
    // must never exist. A gate that failed on the file documenting why it exists
    // would be switched off the same afternoon.
    const { ok } = runOn({
      migration: [
        '-- NOTE: GRANT inrsettle_ops TO inrsettle_app would hand the application',
        '-- every cross-tenant policy with no SET ROLE required. It must never exist.',
        'GRANT SELECT ON settlements TO inrsettle_ops;',
      ].join('\n'),
    })
    expect(ok).toBe(true)
  })

  it('accepts an ops service that writes and records', () => {
    const { ok } = runOn({
      opsService: [
        "import { writeOperatorRecord } from './access.service.js'",
        'export async function properly(tx, scope, ctx) {',
        '  await tx.update(schema.settlements).set({ x: 1 })',
        "  await writeOperatorRecord(tx, scope, ctx, 'write')",
        '}',
      ].join('\n'),
    })
    expect(ok).toBe(true)
  })

  it('accepts an ops service that only reads', () => {
    const { ok } = runOn({
      opsService: 'export async function look(conn) { return conn.select() }\n',
    })
    expect(ok).toBe(true)
  })

  it('accepts an ops handler importing the ops services', () => {
    const { ok } = runOn({
      opsApp: "import { resolveExceptionAsOperator } from '@inrsettle/app-services'\n",
    })
    expect(ok).toBe(true)
  })
})

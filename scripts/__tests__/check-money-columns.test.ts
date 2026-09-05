import { execFileSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'check-money-columns.mjs')
const FIXTURES = join(process.cwd(), 'scripts', '__tests__', 'fixtures')

function runIn(dir: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function stage(...fixtures: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'moneycheck-'))
  mkdirSync(join(dir, 'migrations'))
  fixtures.forEach((fixture, i) =>
    copyFileSync(join(FIXTURES, fixture), join(dir, 'migrations', `000${i + 1}.sql`)),
  )
  return dir
}

describe('INV-02 — the money-column CI check', () => {
  it('fails a migration that declares an amount as NUMERIC or DOUBLE PRECISION', () => {
    const { ok, out } = runIn(stage('bad_money.sql'))
    expect(ok).toBe(false)
    expect(out).toMatch(/recipient_amount is NUMERIC/)
    expect(out).toMatch(/fee_total is DOUBLE/)
  })

  it('fails a *_minor column with no currency column beside it', () => {
    const { out } = runIn(stage('bad_money.sql'))
    expect(out).toMatch(/funding_minor has no funding_currency beside it/)
  })

  it('passes a correctly paired money table', () => {
    const { ok } = runIn(stage('good_money.sql'))
    expect(ok).toBe(true)
  })

  it('catches a money column added by ALTER TABLE, not only one declared inline', () => {
    // The blind spot a per-file, CREATE-TABLE-only check has: the table is
    // clean when it is created and the violation arrives in a later migration,
    // which is how every schema that grows actually acquires its columns.
    const { ok, out } = runIn(stage('bad_alter_money.sql'))
    expect(ok).toBe(false)
    expect(out).toMatch(/altered_example\.settled_minor/)
    expect(out).toMatch(/declares no currency column at all/)
    // And a `real` inside a CHECK expression is not a column type.
    expect(out).not.toMatch(/is_real/)
  })

  it('pairs an added amount with a currency declared in an earlier migration', () => {
    // The same blind spot in reverse, and the more dangerous half: a check that
    // reported this as unpaired would be teaching people to add a second
    // currency column for one fact.
    const { ok, out } = runIn(stage('good_alter_money_create.sql', 'good_alter_money_alter.sql'))
    expect(ok, out).toBe(true)
  })

  it('passes the real Stage 1 migration', () => {
    const { ok, out } = runIn(process.cwd())
    expect(ok, out).toBe(true)
  })
})

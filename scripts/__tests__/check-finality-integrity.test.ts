/**
 * The finality-integrity gate, tested against fixtures.
 *
 * A gate that has never been seen to fail is a gate nobody knows works. These
 * stage the exact shapes it exists to catch — the ones `STATE_MACHINES.md § 8.2`
 * lists and the one `§ 8.6` renamed away — and check that it catches them, and
 * that it does not catch the places where the frozen documents are being quoted.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'check-finality-integrity.mjs')

function runOn(source: string, filename = 'src/thing.ts'): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'finalitycheck-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, filename), source)
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('§ 8.2 — no override path exists in any surface', () => {
  it('catches a "mark as paid" control', () => {
    const { ok, out } = runOn('export function markAsPaid(id: string) { return id }\n')
    expect(ok).toBe(false)
    expect(out).toMatch(/"mark as paid" control/)
  })

  it('catches a force-settle', () => {
    const { ok, out } = runOn('const forceSettle = true\n')
    expect(ok).toBe(false)
    expect(out).toMatch(/force-settle path/)
  })

  it('catches a way to skip the finality conditions', () => {
    const { ok, out } = runOn('evaluateFinality(evidence, { skipConditions: ["F5"] })\n')
    expect(ok).toBe(false)
    expect(out).toMatch(/skip finality conditions/)
  })

  it('catches a status override', () => {
    const { ok, out } = runOn('const statusOverride = "SETTLED"\n')
    expect(ok).toBe(false)
    expect(out).toMatch(/status override/)
  })

  it('catches raw SQL that writes the status column directly', () => {
    const { ok, out } = runOn(
      "await db.execute(sql`UPDATE settlements SET status = 'SETTLED' WHERE id = 1`)\n",
    )
    expect(ok).toBe(false)
    expect(out).toMatch(/the machine owns the status column/)
  })

  it('lets a file that attempts the write on purpose prove the refusal', () => {
    // The enforcement tests must be able to try the forbidden thing. The marker
    // is file-level, scoped to this one rule, and visible to a reviewer.
    const { ok } = runOn(
      '// GATE-EXEMPT-RAW-SETTLE: proves the database refuses it\n' +
        "await admin`UPDATE settlements SET status = 'SETTLED'`\n",
    )
    expect(ok).toBe(true)
  })
})

describe('§ 8.6 — SETTLED is unqualified', () => {
  it('catches a finality hold window returning under a new name', () => {
    const { ok, out } = runOn('const finalityHoldSeconds = 86400 // settled after this\n')
    expect(ok).toBe(false)
    expect(out).toMatch(/duration or hold attached to finality/)
  })

  it('catches a countdown on a settled settlement', () => {
    const { ok, out } = runOn('const label = `Settled - countdown ${n}s`\n')
    expect(ok).toBe(false)
    expect(out).toMatch(/duration or hold attached to finality/)
  })

  it('catches copy calling a settled settlement provisional', () => {
    const { ok } = runOn('const copy = "Settled (provisional)"\n')
    expect(ok).toBe(false)
  })

  it('leaves the return observation window alone, where it belongs', () => {
    // The window may be named anywhere it belongs — it is triage on the return
    // machine. What is forbidden is attaching it to finality.
    const { ok, out } = runOn(
      'export function triage(windowSeconds: number | null) { return windowSeconds }\n',
    )
    expect(ok, out).toBe(true)
  })

  it('a marker with a span exempts a block quotation', () => {
    const { ok, out } = runOn(
      '/**\n' +
        ' * (GATE-EXEMPT+2: the next two lines quote the frozen document.)\n' +
        " * > \"'Finality hold window' implies SETTLED is provisional until the window\n" +
        ' * > elapses. There is not."\n' +
        ' */\n',
    )
    expect(ok, out).toBe(true)
  })

  it('the span does not reach further than it says', () => {
    const { ok } = runOn(
      '// GATE-EXEMPT+1\n' +
        'const a = "Settled — provisional"\n' +
        'const b = "Settled — provisional"\n',
    )
    expect(ok).toBe(false)
  })
})

describe('the real tree', () => {
  it('passes', () => {
    let out = ''
    try {
      out = execFileSync('node', [SCRIPT], { cwd: process.cwd(), encoding: 'utf8' })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      throw new Error(`${err.stdout ?? ''}${err.stderr ?? ''}`)
    }
    expect(out).toMatch(/passed/)
  })
})

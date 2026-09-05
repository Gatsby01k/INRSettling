/**
 * Stage 2 exit criterion: "a test fails any rule that does not have all four
 * fields". This is that test — it runs the real CI gate against fixture trees
 * whose rule sets are deliberately broken, so the gate is proved to bite rather
 * than assumed to.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Assembled from parts so this file does not itself contain the contiguous
 * banned phrase — otherwise the gate under test would flag its own test suite,
 * and the only way out would be an opt-out marker that hides the real check.
 */
const BANNED_PHRASE = ['validation', 'failed'].join(' ')

const SCRIPT = join(process.cwd(), 'scripts', 'check-requirement-copy.mjs')
const FIXTURES = join(process.cwd(), 'scripts', '__tests__', 'fixtures', 'rulesets')

function run(root: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('the requirement-copy CI gate', () => {
  it('passes the shipped sandbox rule set', () => {
    expect(run(join(FIXTURES, 'complete')).ok).toBe(true)
  })

  it('fails a rule with no action, no detail, or no title', () => {
    const { ok, out } = run(join(FIXTURES, 'incomplete'))
    expect(ok).toBe(false)
    expect(out).toMatch(/has no named "action"/)
    expect(out).toMatch(/has no sentence of "detail"/)
    expect(out).toMatch(/has no one-line human "title"/)
  })

  it('fails a sandbox fixture that claims a regulatory purpose code', () => {
    // D-06 is open. A simulator must not launder an invented code into
    // something that reads like an AD-bank requirement.
    const { ok, out } = run(join(FIXTURES, 'regulatory'))
    expect(ok).toBe(false)
    expect(out).toMatch(/carries a regulatory_code/)
    expect(out).toMatch(/D-06/)
  })

  it('fails generic error copy anywhere in the tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copycheck-'))
    mkdirSync(join(dir, 'reference', 'preflight'), { recursive: true })
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'reference', 'preflight', 'empty.json'),
      JSON.stringify({
        version: 'test-1',
        source: 'sandbox_fixture',
        description: 'A deliberately minimal fixture used only by the copy-check test suite here.',
        purpose_codes: [],
        rules: [],
      }),
    )
    writeFileSync(join(dir, 'src', 'ui.ts'), `export const message = 'Payment ${BANNED_PHRASE}'\n`)
    const { ok, out } = run(dir)
    expect(ok).toBe(false)
    expect(out).toMatch(/generic error copy/)
    expect(out).toMatch(/src\/ui\.ts:1/)
  })

  it('honours an explicit same-line opt-out marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copycheck-'))
    mkdirSync(join(dir, 'reference', 'preflight'), { recursive: true })
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'reference', 'preflight', 'empty.json'),
      JSON.stringify({
        version: 'test-1',
        source: 'sandbox_fixture',
        description: 'A deliberately minimal fixture used only by the copy-check test suite here.',
        purpose_codes: [],
        rules: [],
      }),
    )
    writeFileSync(
      join(dir, 'src', 'guard.ts'),
      `expect(copy).not.toContain('${BANNED_PHRASE}') // copy-check:allow\n`,
    )
    expect(run(dir).ok).toBe(true)
  })
})

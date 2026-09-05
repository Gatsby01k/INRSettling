/**
 * The gate on the one criterion a machine cannot close.
 *
 * What it guards against is not carelessness. It is the ordinary drift by which
 * "prepared the protocol" becomes "the Alex test is done" in a summary three
 * weeks later, and the criterion designed to catch *"the product becomes another
 * fintech dashboard"* quietly closes without ever having been run.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'check-alex-test.mjs')

const NOT_RUN = `# The Alex test — record

**Result: NOT RUN.**

## Session 1

| Field | Value |
|---|---|
| Date | |
| Confirmed unbriefed | ☐ never seen the product |

## Verdict

**Status: NOT RUN**
`

const PASSED = `# The Alex test — record

## Session 1

| Field | Value |
|---|---|
| Date | 2026-09-14 |
| Confirmed unbriefed | ☑ never seen the product |

## Verdict

**Status: PASS — 3 unbriefed participants, all completed unaided**
`

function runOn(record: string, otherDocs: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alex-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'ALEX_TEST_RECORD.md'), record)
  for (const [name, text] of Object.entries(otherDocs)) {
    writeFileSync(join(root, name), text)
  }
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('while the test has not been run', () => {
  it('passes, and says the criterion is open', () => {
    const { ok, out } = runOn(NOT_RUN)
    expect(ok, out).toBe(true)
    expect(out).toContain('NOT RUN')
    expect(out).toContain('founder/manual')
  })

  it('rejects a stage summary that ticks the box', () => {
    const { ok, out } = runOn(NOT_RUN, {
      'STAGE10_NOTES.md': '- [x] The Alex test, run with a real person, recorded\n',
    })
    expect(ok).toBe(false)
    expect(out).toContain('STAGE10_NOTES.md')
  })

  it('rejects prose that calls it complete', () => {
    for (const claim of [
      'The Alex test passed with an unbriefed operator.\n',
      'Alex test: complete.\n',
      'We verified the Alex test in this stage.\n',
      'All exit criteria met, including the Alex test.\n',
    ]) {
      const { ok, out } = runOn(NOT_RUN, { 'STAGE10_NOTES.md': claim })
      expect(ok, `should have rejected: ${claim}`).toBe(false)
      expect(out).toContain('claims the Alex test is done')
    }
  })

  it('allows the honest forms, which must not be flagged', () => {
    // A gate that flagged every mention would be a gate nobody could write
    // notes around, and it would be switched off within a week.
    for (const honest of [
      'The Alex test is **not** run. The criterion stays open.\n',
      'Alex test: founder/manual, pending a session with an unbriefed person.\n',
      'This criterion is not met until the Alex test is run with a real person.\n',
      'The protocol is prepared; the Alex test has never been run.\n',
    ]) {
      const { ok, out } = runOn(NOT_RUN, { 'STAGE10_NOTES.md': honest })
      expect(ok, `should have allowed: ${honest}\n${out}`).toBe(true)
    }
  })

  it('does not read the protocol or the record as claims about themselves', () => {
    const { ok, out } = runOn(NOT_RUN, {
      'docs/ALEX_TEST_PROTOCOL.md': 'A run counts as a pass only if A1 and A2 both pass.\n',
    })
    expect(ok, out).toBe(true)
  })
})

describe('once it has been run', () => {
  it('accepts a PASS that carries its evidence', () => {
    const { ok, out } = runOn(PASSED)
    expect(ok, out).toBe(true)
    expect(out).toContain('PASS')
  })

  it('stops flagging documents that now say it is done', () => {
    const { ok, out } = runOn(PASSED, {
      'STAGE10_NOTES.md': '- [x] The Alex test, run with a real person, recorded\n',
    })
    expect(ok, out).toBe(true)
  })

  it('refuses a PASS with no participant count', () => {
    const { ok, out } = runOn(PASSED.replace(
      '**Status: PASS — 3 unbriefed participants, all completed unaided**',
      '**Status: PASS**',
    ))
    expect(ok).toBe(false)
    expect(out).toContain('names no number of participants')
  })

  it('refuses a PASS where nobody was confirmed unbriefed', () => {
    // The whole variable. One sentence of context before the session and the
    // result measures recall rather than comprehension.
    const { ok, out } = runOn(PASSED.replace('☑ never seen', '☐ never seen'))
    expect(ok).toBe(false)
    expect(out).toContain('unbriefed')
  })

  it('accepts a FAIL — a recorded failure is a recorded result', () => {
    const { ok, out } = runOn(
      PASSED.replace(
        '**Status: PASS — 3 unbriefed participants, all completed unaided**',
        '**Status: FAIL — nobody found the purpose field without prompting**',
      ),
    )
    expect(ok, out).toBe(true)
    expect(out).toContain('FAIL')
  })
})

describe('the gate cannot be got rid of', () => {
  it('fails when the record is deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'alex-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    let failed = false
    let out = ''
    try {
      execFileSync('node', [SCRIPT, root], { encoding: 'utf8' })
    } catch (e) {
      failed = true
      const err = e as { stdout?: string; stderr?: string }
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    expect(failed).toBe(true)
    expect(out).toContain('does not close the criterion')
  })

  it('fails on a status line it does not recognise', () => {
    const { ok, out } = runOn(NOT_RUN.replace('**Status: NOT RUN**', '**Status: mostly fine**'))
    expect(ok).toBe(false)
    expect(out).toContain('no status line')
  })

  it('reads the verdict, not a stray PASS elsewhere in the document', () => {
    const { ok } = runOn(
      NOT_RUN.replace(
        '## Verdict',
        'A run counts as a PASS only if A1 and A2 both pass.\n\n## Verdict',
      ),
    )
    // Still NOT RUN: the word appearing in the protocol text above the verdict
    // must not flip the gate.
    expect(ok).toBe(true)
  })
})

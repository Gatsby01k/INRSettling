#!/usr/bin/env node
/**
 * The one Stage 10 exit criterion a machine cannot close.
 *
 *   *"An unbriefed payments operator completes a settlement without help — the
 *   Alex test, run with a real person, recorded"*
 *
 * Everything else in Stage 10 is checkable, and Stage 10 checks it. All of it
 * can be true of a product nobody can use. This criterion asks whether a person
 * who has never seen the product knows what to do, and there is exactly one way
 * to find out.
 *
 * The risk this gate guards against is not carelessness — it is the very
 * ordinary drift by which "prepared the protocol" becomes "the Alex test is
 * done" in a summary three weeks later, and the criterion designed to catch
 * *"the product becomes another fintech dashboard"* quietly closes without ever
 * having been run. So:
 *
 *   `ALEX_TEST_RECORD.md` carries a status line. It says NOT RUN until a founder
 *   changes it. While it does, **no document in this repository may claim the
 *   criterion is met** — the gate reads the stage notes and the plan and fails
 *   on any line that marks it complete.
 *
 * The gate cannot be satisfied by editing code. It is satisfied by running the
 * session, which is the point.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const RECORD = join(ROOT, 'docs', 'ALEX_TEST_RECORD.md')

if (!existsSync(RECORD)) {
  console.error(
    'check-alex-test: docs/ALEX_TEST_RECORD.md is missing.\n' +
    '  The Stage 10 exit criterion requires a recorded session with a real person.\n' +
    '  Deleting the record does not close the criterion.',
  )
  process.exit(1)
}

const record = readFileSync(RECORD, 'utf8')

/**
 * The status line, and only the status line.
 *
 * Read from the `## Verdict` section so the "Result: NOT RUN" banner at the top
 * of the file cannot be mistaken for it, and so a note elsewhere in the document
 * that happens to contain the word PASS cannot flip the gate.
 */
const verdictSection = record.slice(record.indexOf('## Verdict'))
const status = verdictSection.match(/^\*\*Status:\s*(NOT RUN|PASS|FAIL)\b(.*)$/m)

if (!status) {
  console.error(
    'check-alex-test: no status line under `## Verdict` in docs/ALEX_TEST_RECORD.md.\n' +
    '  Expected exactly one of:\n' +
    '    **Status: NOT RUN**\n' +
    '    **Status: PASS — <n> unbriefed participants, all completed unaided**\n' +
    '    **Status: FAIL — <one sentence on what stopped them>**',
  )
  process.exit(1)
}

const [, verdict, rest] = status
const run = verdict !== 'NOT RUN'

/* ── A claimed PASS must carry its evidence ─────────────────────────────── */

const problems = []

if (verdict === 'PASS') {
  if (!/\d/.test(rest)) {
    problems.push(
      'the PASS status names no number of participants — "PASS — 3 unbriefed ' +
      'participants, all completed unaided"',
    )
  }
  // A session with no date and no participant is not a recorded session.
  if (!/\|\s*Date\s*\|\s*\d/.test(record) && !/\|\s*Date\s*\|\s*[A-Z]/.test(record)) {
    problems.push('no session in the record has a date filled in')
  }
  if (/Confirmed unbriefed \| ☐/.test(record)) {
    problems.push(
      'a session claims a pass with the "confirmed unbriefed" box unticked — ' +
      'an unbriefed participant is the whole variable',
    )
  }
}

/* ── While it is NOT RUN, nothing may say otherwise ─────────────────────── */

if (!run) {
  const docs = []
  const scan = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.md') && entry !== 'ALEX_TEST_RECORD.md' && entry !== 'ALEX_TEST_PROTOCOL.md') {
        docs.push(join(dir, entry))
      }
    }
  }
  scan(ROOT)
  scan(join(ROOT, 'docs'))

  /**
   * A line that both mentions the test and marks it done.
   *
   * Narrow on purpose. "The Alex test is founder/manual and remains open" must
   * pass; a ticked checkbox or the word "complete" beside it must not. A gate
   * that flagged every mention would be a gate nobody could write notes around,
   * and it would be switched off.
   */
  const CLAIMS = [
    /^\s*[-*]\s*\[x\]\s*.*Alex test/im,
    /Alex test[^.\n]{0,80}\b(passed|complete[d]?|met|satisfied|verified|closed)\b/i,
    /\b(passed|complete[d]?|met|satisfied|verified|closed)\b[^.\n]{0,40}Alex test/i,
  ]

  for (const file of docs) {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      // An explicit "not" anywhere in the sentence is the honest form.
      if (/\bnot\b|\bnever\b|\buntil\b|\bopen\b|\bpending\b|\bfounder\/manual\b/i.test(line)) continue
      if (CLAIMS.some((p) => p.test(line))) {
        problems.push(
          `${file.slice(ROOT.length + 1)} claims the Alex test is done while the record says NOT RUN:\n` +
          `      ${line.trim()}`,
        )
      }
    }
  }
}

/* ── Report ─────────────────────────────────────────────────────────────── */

if (problems.length > 0) {
  console.error('check-alex-test: the record and the claims disagree.\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '\n  The Alex test is closed by running it with an unbriefed person, not by ' +
    'editing a file.',
  )
  process.exit(1)
}

console.log(
  run
    ? `check-alex-test: recorded — ${verdict}${rest.replace(/\*\*$/, '').trimEnd()}`
    : 'check-alex-test: NOT RUN, and nothing in the repository claims otherwise. ' +
      'The Stage 10 criterion stays open (founder/manual).',
)

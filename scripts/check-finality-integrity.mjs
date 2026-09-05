#!/usr/bin/env node
/**
 * Two Stage 6 exit criteria, as a build gate.
 *
 *   "A code search confirms no 'mark as paid', force-settle or status-override
 *    path exists in any surface"
 *
 *   "No finality condition, API field or UI element references a duration,
 *    countdown or hold on a settled settlement — SETTLED is unqualified"
 *
 * Both are stated in `IMPLEMENTATION_PLAN.md § 3` as *code searches*, which is
 * an unusual shape for an exit criterion and a deliberate one. They are not
 * assertions about behaviour that a test could make — they are assertions about
 * **absence**, and absence is not testable by exercising a path. The only way to
 * prove no override exists is to look for one everywhere and find nothing.
 *
 * Running it in CI rather than once, by hand, at the end of Stage 6 is the whole
 * point. A "mark as paid" button is not added by someone who read
 * `STATE_MACHINES.md § 8.2`; it is added eighteen months later by someone
 * clearing a support queue on a Friday, and the value of this file is that it
 * fails their build.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

const SKIP_DIRS = ['node_modules', '.git', 'dist', 'storybook-static', '.turbo', 'coverage']

/* ── 1. No override path ────────────────────────────────────────────────── */

/**
 * Patterns that would *be* an override if they existed.
 *
 * Written against identifiers rather than prose, because prose is where these
 * things get discussed and identifiers are where they get built. `§ 8.2`'s list
 * — a manual "mark as paid" control, a force-settle, an admin backdoor — turns
 * into: any callable, route, flag or column whose name says it can make a
 * settlement final without the evaluator.
 */
const OVERRIDE_PATTERNS = [
  { re: /\bmark(_|\s+)?as(_|\s+)?paid\b/i, what: 'a "mark as paid" control' },
  { re: /\bmarkPaid\b/, what: 'a "mark paid" callable' },
  { re: /\bforce(_|-)?settle/i, what: 'a force-settle path' },
  { re: /\bforceFinal/i, what: 'a force-final path' },
  { re: /\bskipFinality|\bskip_finality/i, what: 'a way to skip finality evaluation' },
  { re: /\bskipConditions\b/, what: 'a way to skip finality conditions' },
  { re: /\boverrideFinality|\bfinality_override/i, what: 'a finality override' },
  { re: /\bstatusOverride|\bstatus_override|\boverrideStatus\b/i, what: 'a status override' },
  { re: /\badminSettle|\bbackdoor/i, what: 'an administrative settle path' },
]

/**
 * Writing `SETTLED` outside the machine.
 *
 * `INV-32` and the transition service already refuse a patch that reaches for
 * the status column, and the deferred trigger refuses a status change with no
 * paired event. This catches the layer below both: raw SQL that sets the column
 * directly, from anywhere in the tree.
 */
const RAW_SETTLE = /\b(?:UPDATE\s+settlements\b[\s\S]{0,200}?\bSET\b[\s\S]{0,200}?\bstatus\s*=)/i

/* ── 2. No duration attached to a settled settlement ────────────────────── */

/**
 * `§ 8.6` renamed the return observation window away from "finality hold
 * window" because *"the name was doing damage"*: it implies `SETTLED` is
 * provisional. This gate keeps the damage from coming back under a new name.
 *
 * The distinction that matters, and it is a real one: the *window* may be named
 * anywhere it belongs — the return machine, its configuration, the triage
 * function. What must never appear is a duration, countdown or hold **attached
 * to finality or to a settled settlement**. So the check is a proximity one: a
 * finality/settled word and a hold/countdown word on the same line.
 */
// Case-insensitive, because customer copy is where § 8.6's damage would show
// up and copy is written in sentence case. A case-sensitive check would pass
// "Settled (provisional)" — the exact string the section exists to prevent.
const FINALITY_WORDS = /\b(finality|settled)\b/i
// No trailing `\b`: these appear as camelCase identifiers as often as prose,
// and `finalityHoldSeconds` — the exact shape the rename was meant to prevent —
// has no word boundary after "Hold". A trailing boundary would catch the
// discussion and miss the code.
const HOLD_WORDS =
  /\b(hold[_ ]?window|finality[_ ]?hold|countdown|provisional|settlement[_ ]?hold|cooling[_ ]?off|not[_ ]?yet[_ ]?final|becomes[_ ]?final[_ ]?(?:in|after))/i

/**
 * Lines that are *about* the prohibition rather than instances of it.
 *
 * Every one of these is a place where the frozen documents' own words are being
 * quoted, or where this gate's rules are being stated. Excluding them by an
 * explicit marker rather than by filename means a file cannot quietly become
 * exempt: the marker has to be written on the line, where a reviewer sees it.
 *
 * `GATE-EXEMPT+n` extends the exemption to the next `n` lines. It exists for
 * one real case: a **block quotation** of a frozen document. You cannot
 * annotate inside a quotation without altering the quotation, and altering a
 * quotation to satisfy a linter is exactly the kind of quiet drift these
 * documents are frozen to prevent. The count is explicit and small, so a
 * reviewer can see how far the exemption reaches.
 */
const EXEMPT_PATH = /check-finality-integrity/

/** Line numbers (0-indexed) this file has exempted, markers and their spans. */
function exemptLines(lines) {
  const exempt = new Set()
  lines.forEach((line, i) => {
    const m = /GATE-EXEMPT(?:\+(\d+))?/.exec(line)
    if (!m) return
    exempt.add(i)
    const span = m[1] === undefined ? 0 : Math.min(Number(m[1]), 10)
    for (let k = 1; k <= span; k += 1) exempt.add(i + k)
  })
  return exempt
}

function files(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files(full, acc)
    else if (/\.(ts|tsx|mts|js|mjs|sql)$/.test(entry)) acc.push(full)
  }
  return acc
}

const problems = []

for (const file of files(ROOT)) {
  const rel = relative(ROOT, file)
  if (EXEMPT_PATH.test(rel)) continue
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const exempt = exemptLines(lines)

  for (const { re, what } of OVERRIDE_PATTERNS) {
    lines.forEach((line, i) => {
      if (exempt.has(i)) return
      if (re.test(line)) {
        problems.push(`${rel}:${i + 1}: ${what} — STATE_MACHINES.md § 8.2 forbids it`)
      }
    })
  }

  // A file whose purpose is to *attempt* the forbidden write, to prove the
  // database refuses it, is exempt from this one rule and no others. The marker
  // is file-level because such a file attempts it many times, and it is scoped
  // to the raw-write rule because nothing exempts a file from § 8.2.
  const attemptsForbiddenWrites = /GATE-EXEMPT-RAW-SETTLE/.test(text)
  if (RAW_SETTLE.test(text) && !attemptsForbiddenWrites) {
    // Narrowed to the actual statement, since the multiline regex above can
    // span a comment. Report the line the UPDATE starts on.
    lines.forEach((line, i) => {
      if (exempt.has(i)) return
      if (/\bUPDATE\s+settlements\b/i.test(line) && !line.trim().startsWith('--')) {
        problems.push(
          `${rel}:${i + 1}: raw UPDATE on settlements — the machine owns the status column ` +
            '(INV-32); use applyTransition',
        )
      }
    })
  }

  lines.forEach((line, i) => {
    if (exempt.has(i)) return
    if (FINALITY_WORDS.test(line) && HOLD_WORDS.test(line)) {
      problems.push(
        `${rel}:${i + 1}: a duration or hold attached to finality — ` +
          'STATE_MACHINES.md § 8.6: SETTLED is unqualified and never provisional',
      )
    }
  })
}

if (problems.length) {
  console.error('Finality-integrity check failed:\n')
  for (const p of problems.sort()) console.error('  ' + p)
  console.error(
    `\n${problems.length} problem(s). See STATE_MACHINES.md § 8.2 and § 8.6.\n` +
      'There is no override, no force-settle and no admin backdoor. If finality cannot be\n' +
      'evaluated, the settlement stays in RECONCILING or EXCEPTION until the evidence exists.',
  )
  process.exit(1)
}
console.log(
  'Finality-integrity check passed: no override path, and no duration attached to a settled settlement.',
)

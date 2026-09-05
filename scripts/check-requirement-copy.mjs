#!/usr/bin/env node
/**
 * Stage 2 exit criteria, checked before anything runs:
 *
 *   1. Every rule in every versioned rule set carries a code, a title, a
 *      detail and a named action. A rule that cannot express all four does not
 *      ship (`PRODUCT.md § 7.1`).
 *   2. The phrase "validation failed" — and its usual companions — appear in no
 *      user-facing string anywhere in the codebase.
 *
 * The second check is a grep on purpose. The first one is enforced by the
 * domain at load time too, but a build-time gate means a bad rule set never
 * reaches a running system, and the person who wrote it finds out in CI rather
 * than from a customer looking at an empty card.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The repository root by default; an explicit root makes the gate testable
// against a fixture tree, so "CI rejects an incomplete rule" is itself proved
// rather than asserted.
const ROOT = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
const problems = []

/* ── 1. Rule sets ──────────────────────────────────────────────────────── */

const RULE_SET_DIR = join(ROOT, 'reference', 'preflight')
const ACTION_TYPES = new Set([
  'verify_beneficiary',
  'edit_beneficiary',
  'add_payout_destination',
  'upload_document',
  'select_purpose',
  'contact_support',
  'set_up_liquidity_facility',
])

function checkRuleSet(file) {
  const path = join(RULE_SET_DIR, file)
  let doc
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    problems.push(`${relative(ROOT, path)}: not valid JSON — ${e.message}`)
    return
  }

  const where = relative(ROOT, path)
  if (typeof doc.version !== 'string') problems.push(`${where}: missing "version"`)
  if (!['sandbox_fixture', 'ad_bank', 'provider'].includes(doc.source)) {
    problems.push(`${where}: "source" must be sandbox_fixture, ad_bank or provider`)
  }
  if (typeof doc.description !== 'string' || doc.description.length < 40) {
    problems.push(`${where}: "description" must say what this rule set is and where it came from`)
  }

  // A sandbox fixture that fills in a regulatory purpose code turns a
  // simulator assumption into something that reads like production truth.
  // D-06 is open; this is the guard that keeps it visibly open.
  for (const p of doc.purpose_codes ?? []) {
    if (doc.source === 'sandbox_fixture' && p.regulatory_code != null) {
      problems.push(
        `${where}: purpose ${p.code} carries a regulatory_code, but this is a sandbox fixture ` +
          '(D-06 is unanswered — a real code may only come from an ad_bank or provider rule set)',
      )
    }
  }

  if (!Array.isArray(doc.rules)) {
    problems.push(`${where}: "rules" must be an array`)
    return
  }

  for (const [i, rule] of doc.rules.entries()) {
    const id = rule?.id ?? `rules[${i}]`
    const at = `${where}: rule ${id}`
    if (typeof rule?.code !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(rule.code)) {
      problems.push(`${at} has no usable "code"`)
    }
    if (typeof rule?.title !== 'string' || rule.title.trim().length < 12) {
      problems.push(`${at} has no one-line human "title"`)
    }
    if (typeof rule?.detail !== 'string' || rule.detail.trim().length < 24) {
      problems.push(`${at} has no sentence of "detail"`)
    }
    if (!rule?.action || !ACTION_TYPES.has(rule.action.type)) {
      problems.push(`${at} has no named "action" the interface can offer`)
    }
    if (rule?.action?.type === 'upload_document' && typeof rule.action.document_type !== 'string') {
      problems.push(`${at} uploads a document but does not say which`)
    }
    if (!rule?.when) problems.push(`${at} has no "when" condition`)
    if (rule?.severity !== 'blocking' && rule?.severity !== 'advisory') {
      problems.push(`${at} has no "severity"`)
    }
  }
}

try {
  for (const file of readdirSync(RULE_SET_DIR)) {
    if (file.endsWith('.json')) checkRuleSet(file)
  }
} catch {
  problems.push('reference/preflight does not exist — versioned rule sets are required')
}

/* ── 2. Generic error copy ─────────────────────────────────────────────── */

const BANNED = [
  'validation failed',
  'payment validation failed',
  'invalid input',
  'an error occurred',
  'something went wrong',
]
const SCAN_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|json|sql|md)$/
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'storybook-static', '.next', 'coverage', '.turbo',
])
/**
 * Two kinds of legitimate mention, handled by rule rather than by a list that
 * would grow every time someone writes a test:
 *
 *   `docs/` is the signed specification. It is where the prohibition is
 *   *written down* ("Something went wrong is not shippable"), and it ships to
 *   nobody. Exempting the directory is not a loophole: no customer-facing
 *   string is ever read from a design document.
 *
 *   Everywhere else, a line may opt out with an explicit `copy-check:allow`
 *   marker. That is for code and tests that name a banned phrase in order to
 *   reject it. The marker has to be on the same line, so it is visible in
 *   review and cannot silently cover a block.
 */
const ALLOW_MARKER = 'copy-check:allow'
const EXEMPT_DIR_PREFIXES = ['docs/']
const SELF_REFERENTIAL = new Set(['scripts/check-requirement-copy.mjs'])

function scan(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      scan(full)
      continue
    }
    if (!SCAN_EXTENSIONS.test(entry)) continue
    const rel = relative(ROOT, full)
    if (SELF_REFERENTIAL.has(rel)) continue
    if (EXEMPT_DIR_PREFIXES.some((p) => rel.startsWith(p))) continue

    const lines = readFileSync(full, 'utf8').split('\n')
    lines.forEach((line, n) => {
      if (line.includes(ALLOW_MARKER)) return
      const lower = line.toLowerCase()
      for (const phrase of BANNED) {
        if (lower.includes(phrase)) {
          problems.push(`${rel}:${n + 1}: generic error copy "${phrase}" — PRODUCT.md § 7.1`)
        }
      }
    })
  }
}

scan(ROOT)

/* ── Report ────────────────────────────────────────────────────────────── */

if (problems.length > 0) {
  console.error('Requirement copy check failed:\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '\nEvery blocking requirement needs a stable code, a one-line title, a sentence of\n' +
      'context and one named action. If a rule cannot express all four, it does not ship.',
  )
  process.exit(1)
}

console.log('requirement copy check passed')

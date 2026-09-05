#!/usr/bin/env node
/**
 * The Stage 9 boundaries, as a build gate.
 *
 * Three assertions of **absence**, which is the shape the Internal Operations
 * rules mostly take and the shape a test cannot make by exercising a path. The
 * only way to prove no ops write path exists is to look for one everywhere and
 * find nothing.
 *
 *   1. `inrsettle_ops` is never granted a write privilege, in any migration.
 *   2. `inrsettle_ops` and `inrsettle_app` are never made members of each other.
 *   3. Every ops service that writes also records who wrote and why.
 *
 * Running it in CI rather than once, by hand, at the end of Stage 9 is the whole
 * point. The grant that undoes this is not added by someone who read
 * `SECURITY.md § 2`; it is added eighteen months later by someone who needs ops
 * to "just update one field", and the value of this file is that it fails their
 * build.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// A root argument, like every other gate, so the self-test can point it at a
// fixture tree instead of at the repository it lives in.
const ROOT = process.argv[2] ?? process.cwd()
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'storybook-static', '.turbo', 'coverage']

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const problems = []
const files = walk(ROOT)

/* ── 1. The ops role never writes ───────────────────────────────────────── */

/*
 * `GRANT SELECT` is the only grant this role may hold. Anything else — INSERT,
 * UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, ALL — hands Internal
 * Operations a second write path: one that skips `withTenant`, and therefore
 * skips every RLS policy, every CHECK, and the triggers that refuse a settled
 * settlement. The whole "no ops action can set SETTLED" property rests on the
 * absence of that grant.
 */
/**
 * Comments stripped first.
 *
 * Migration `0017` warns, in prose, against exactly the grant this gate looks
 * for — and a scanner that read its own warning as a violation would be a gate
 * that fails on the file documenting why it exists.
 */
const withoutComments = (sql) => sql.replace(/--[^\n]*/g, '')

for (const file of files.filter((f) => f.endsWith('.sql'))) {
  const source = withoutComments(readFileSync(file, 'utf8'))
  const statements = source.split(';')
  for (const statement of statements) {
    if (!/\binrsettle_ops\b/i.test(statement)) continue
    if (!/\bGRANT\b/i.test(statement)) continue
    if (!/\bTO\b[^;]*\binrsettle_ops\b/i.test(statement)) continue

    // Anything granted to the ops role must be SELECT and nothing else.
    const privileges = statement.match(/GRANT\s+([\s\S]*?)\s+ON\b/i)
    if (!privileges) continue
    const named = privileges[1]
      .replace(/\([^)]*\)/g, '')        // column lists are not privileges
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p.length > 0)

    for (const privilege of named) {
      if (privilege !== 'SELECT' && privilege !== 'USAGE') {
        problems.push(
          `${relative(ROOT, file)}: inrsettle_ops is granted ${privilege}. ` +
          'The ops role reads across tenants and writes nothing — an operator ' +
          'action is a tenant-scoped write through inrsettle_app, so that every ' +
          'trigger and policy applies to it (SECURITY.md § 2, § 6).',
        )
      }
    }
  }
  /* ── 2. Neither role is a member of the other ─────────────────────────── */

  /*
   * RLS role matching uses `has_privs_of_role`, which follows inheritance. A
   * membership either way hands one role the other's policies with no `SET
   * ROLE` required — the customer-facing application would silently acquire
   * every cross-tenant read policy.
   */
  const membership =
    /GRANT\s+(inrsettle_ops|inrsettle_app)\s+TO\s+(inrsettle_app|inrsettle_ops)\b/gi
  let match
  while ((match = membership.exec(source)) !== null) {
    problems.push(
      `${relative(ROOT, file)}: ${match[0]} makes one runtime role a member of ` +
      'the other. RLS follows inheritance, so this hands over every policy the ' +
      'other role has, with no SET ROLE required.',
    )
  }
}

/* ── 3. Every ops write records who and why ─────────────────────────────── */

/*
 * A write inside `packages/app/src/ops` that does not call `writeOperatorRecord`
 * is an operator action with no attribution — the thing `SECURITY.md § 6`
 * exists to prevent.
 *
 * `access.service.ts` is exempt because it *is* the recorder, and
 * `session.service.ts` because operator identity is not a tenant action: a
 * session row is about a member of staff, not about a customer's settlement.
 */
const RECORDER_EXEMPT = new Set(['access.service.ts', 'session.service.ts'])
const WRITE_CALL = /\b(?:tx|conn)\.(insert|update|delete)\s*\(|applyTransition\s*\(|sql`\s*(?:UPDATE|INSERT|DELETE)\b/i

const opsDir = join(ROOT, 'packages', 'app', 'src', 'ops')
for (const file of walk(opsDir).filter((f) => f.endsWith('.ts'))) {
  const name = file.split('/').pop()
  if (RECORDER_EXEMPT.has(name)) continue
  const source = readFileSync(file, 'utf8')
  if (!WRITE_CALL.test(source)) continue
  if (!/writeOperatorRecord\s*\(|recordOperatorAccess\s*\(/.test(source)) {
    problems.push(
      `${relative(ROOT, file)}: writes without calling writeOperatorRecord. ` +
      'Every operator action carries an attributed, reasoned record ' +
      '(SECURITY.md § 6); a write that skips it is an unattributed one.',
    )
  }
}

/* ── 4. The ops app reaches the database only through the ops services ──── */

/*
 * A handler that imported `settlement.service.ts` directly could apply a
 * transition without the capability check, the reason, or the record. The ops
 * services are the door; this keeps the windows shut.
 */
const FORBIDDEN_IN_HANDLERS = [
  'settlement.service', 'settlement-transition.service', 'liquidity.service',
  'settlement-liquidity.service', 'payout.service', 'finality.service',
  'reconciliation.service', 'beneficiary.service',
]
const handlersDir = join(ROOT, 'apps', 'ops', 'src')
for (const file of walk(handlersDir).filter(
  (f) => f.endsWith('.ts') && !f.includes('__tests__'))) {
  const source = readFileSync(file, 'utf8')
  for (const forbidden of FORBIDDEN_IN_HANDLERS) {
    if (new RegExp(`from\\s+['"][^'"]*${forbidden.replace('.', '\\.')}`).test(source)) {
      problems.push(
        `${relative(ROOT, file)}: imports ${forbidden} directly. The ops app ` +
        'reaches the database through packages/app/src/ops, which is where the ' +
        'capability check, the mandatory reason and the attribution live.',
      )
    }
  }
}

/* ── Report ─────────────────────────────────────────────────────────────── */

if (problems.length > 0) {
  console.error('Internal Operations boundary check failed:\n')
  for (const problem of problems) console.error(`  ${problem}\n`)
  console.error('See SECURITY.md § 2, § 3.2 and § 6.')
  process.exit(1)
}

console.log(
  'Internal Operations boundaries clean: the ops role reads and never writes, ' +
  'neither runtime role inherits the other, and every operator write is attributed.',
)

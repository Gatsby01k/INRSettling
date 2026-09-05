#!/usr/bin/env node
/**
 * Nothing in the tree is shaped like a real credential.
 *
 * This gate exists because a push to an empty repository was rejected by GitHub
 * push protection, and the reason is worth stating precisely: **nothing secret
 * was committed.** The blocked value was a fixture — the letters `a` through `x`
 * — sitting behind INRSettle's own API-key prefix.
 *
 * That prefix is `sk_live_` / `sk_test_` (`SECURITY.md § 5`, `DOMAIN.md`), which
 * is also Stripe's. A secret scanner matches `prefix + N alphanumerics`; it
 * cannot know the alphanumerics are the alphabet, and it should not try to
 * guess. So a fixture that reads as obviously fake to a person can be
 * indistinguishable from a live key to a machine, and the machine is the one
 * standing at the door.
 *
 * The lesson generalises past this one file, which is why it is a gate rather
 * than a one-line fix: any example value carrying a real-looking credential
 * shape is a future blocked push at best, and at worst the thing somebody
 * eventually pastes into a search bar to see whether it is real.
 *
 * Two rules:
 *
 *  1. No tracked file contains a string matching a published provider secret
 *     pattern — including our own prefixes, which collide with Stripe's.
 *  2. No environment or key material file is tracked at all.
 *
 * The fix for a violation is never to weaken the pattern. It is to break the
 * alphanumeric run in the example value — a hyphen is enough — which keeps the
 * prefix readable and makes the value unmistakably not a key.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The patterns GitHub push protection actually enforces, at the lengths it
 * enforces them.
 *
 * Deliberately the published shapes rather than a home-grown entropy heuristic:
 * the question this gate answers is not *"is this secret?"* but *"will the
 * gatekeeper think so?"*, and only the gatekeeper's own rules answer that.
 */
const PATTERNS = [
  ['Stripe live secret key', /\bsk_live_[0-9a-zA-Z]{24,}/],
  ['Stripe live restricted key', /\brk_live_[0-9a-zA-Z]{24,}/],
  ['Stripe test secret key', /\bsk_test_[0-9a-zA-Z]{24,}/],
  ['Stripe webhook signing secret', /\bwhsec_[0-9a-zA-Z]{24,}/],
  ['GitHub personal access token', /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}/],
  ['GitHub fine-grained token', /\bgithub_pat_[0-9A-Za-z_]{60,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}/],
  ['OpenAI API key', /\bsk-[A-Za-z0-9]{32,}/],
  ['Private key block', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
]

/** Files that must never be tracked, whatever they contain. */
const FORBIDDEN_PATHS = [
  [/(^|\/)\.env$/, '.env'],
  [/(^|\/)\.env\.(?!example$)[^/]+$/, 'an environment file'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/, 'key material'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, 'a private SSH key'],
  [/(^|\/)\.npmrc$/, 'an npmrc (may carry a registry token)'],
  [/(^|\/)\.git-credentials$/, 'stored git credentials'],
  [/\.(sqlite3?|db)$/, 'a local database'],
  [/\.(mp4|mov|webm)$/, 'a recording'],
  [/(^|\/)_to_delete\//, 'a local scratch directory'],
]

/**
 * The file list comes from git when git is available, so the gate checks
 * exactly what would be pushed. Without git it walks the tree, which is a
 * superset — a gate that silently checked less would be worse than none.
 */
function trackedFiles() {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    const out = []
    const skip = new Set(['node_modules', '.git', 'dist', 'storybook-static', 'coverage', '_to_delete'])
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (skip.has(entry)) continue
        const p = join(dir, entry)
        if (statSync(p).isDirectory()) walk(p)
        else out.push(relative(ROOT, p))
      }
    }
    walk(ROOT)
    return out
  }
}

const files = trackedFiles()
if (files.length === 0) {
  console.error('check-secrets: found no files to check — refusing to pass vacuously.')
  process.exit(1)
}

const problems = []

for (const file of files) {
  for (const [pattern, what] of FORBIDDEN_PATHS) {
    if (pattern.test(file)) problems.push(`${file} is ${what} and must not be tracked`)
  }
}

for (const file of files) {
  const full = join(ROOT, file)
  if (!existsSync(full)) continue
  let src
  try {
    src = readFileSync(full, 'utf8')
  } catch {
    continue // binary or unreadable; the path rules above already covered it
  }
  // Skip this file's own pattern table, which necessarily contains the shapes.
  if (file.endsWith('scripts/check-secrets.mjs')) continue

  src.split('\n').forEach((line, i) => {
    for (const [name, pattern] of PATTERNS) {
      const match = pattern.exec(line)
      if (match) {
        problems.push(
          `${file}:${i + 1} looks like a ${name}: ${match[0].slice(0, 16)}…\n` +
          '      If this is an example, break the alphanumeric run with a hyphen ' +
          '(sk_live_EXAMPLE-NOT-A-REAL-KEY). If it is real, it does not belong in the repository.',
        )
      }
    }
  })
}

if (problems.length > 0) {
  console.error('check-secrets: something here is shaped like a credential.\n')
  for (const p of [...new Set(problems)].sort()) console.error(`  ${p}`)
  console.error(
    '\n  A scanner matches shape, not meaning. Never weaken the pattern to pass ' +
    'this gate.',
  )
  process.exit(1)
}

console.log(
  `check-secrets: ${files.length} tracked files, nothing shaped like a credential, ` +
  'no environment or key material tracked.',
)

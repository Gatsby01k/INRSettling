#!/usr/bin/env node
/**
 * Fail the build if compiled output is sitting next to the sources.
 *
 * This exists because of a real incident. A `tsc -b` run that violated a
 * project's `rootDir` still emitted, and it wrote `.js` and `.d.ts` files into
 * the `src` directory of a package. Vitest resolves `./foo.js` to a real `foo.js` in
 * preference to `foo.ts`, so every test then ran against a stale compiled copy
 * of the code — silently, and with a passing-looking stack trace pointing at
 * a `.js` file that should never have existed.
 *
 * The failure mode is worse than a broken build: the tests still ran, and they
 * tested the wrong thing. So this is a hard gate rather than a lint warning.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['packages', 'apps']
const BANNED = /\.(js|jsx|mjs|cjs|js\.map|d\.ts|d\.ts\.map)$/
/** Source files that are legitimately JavaScript and are never compiled output. */
const ALLOWED = new Set(['vite.config.js', 'postcss.config.js'])

const offenders = []

function walk(dir, insideSrc) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'storybook-static') {
      continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, insideSrc || entry.name === 'src')
      continue
    }
    if (!insideSrc) continue
    if (ALLOWED.has(entry.name)) continue
    if (BANNED.test(entry.name)) offenders.push(relative(root, full))
  }
}

for (const r of ROOTS) {
  const dir = join(root, r)
  try {
    if (statSync(dir).isDirectory()) walk(dir, false)
  } catch {
    /* the directory may not exist yet */
  }
}

if (offenders.length > 0) {
  console.error('Compiled output found inside a src/ tree. These shadow the TypeScript')
  console.error('sources at test time and make the suite test stale code:\n')
  for (const f of offenders.sort()) console.error(`  ${f}`)
  console.error('\nDelete them and rebuild:')
  console.error("  find packages apps -path '*/src/*' \\( -name '*.js' -o -name '*.d.ts' \\) \\")
  console.error("    -not -path '*/node_modules/*' -delete && pnpm typecheck")
  process.exit(1)
}

console.log('source tree clean: no compiled output under src/')

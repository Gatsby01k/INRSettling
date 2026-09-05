#!/usr/bin/env node
/**
 * Seven animations, and nothing else — `DESIGN_SYSTEM.md § 6`.
 *
 * The section is a closed list and an explicit ban:
 *
 *   *"Explicitly banned: confetti, checkmark explosions, particle systems,
 *   parallax, cinematic sequences, looping ambient motion, anything longer than
 *   400ms, and anything that moves while the user is reading a number."*
 *
 * A closed list nobody checks is a paragraph. This gate makes it a build error:
 *
 *  1. Every `@keyframes` in the stylesheets is one of the seven, or one of the
 *     two explicitly-granted loops.
 *  2. No animation or transition runs longer than 400ms.
 *  3. Every duration comes from a motion token, never a hardcoded value — a
 *     literal `300ms` is a duration that `prefers-reduced-motion` cannot reach,
 *     because the reduction is implemented by zeroing the tokens.
 *  4. Every keyframe animation is disabled or reduced under
 *     `prefers-reduced-motion: reduce`. *"Nothing is left in motion."*
 *  5. Nothing on the banned list appears by name.
 *
 * Rule 3 is the one that does the most work in practice. The reduced-motion
 * behaviour is not written per-rule; it comes from `tokensToCss()` setting every
 * `--motion-*-duration` to `0ms` inside the media query. So an animation that
 * hardcodes its duration keeps running for someone who asked the operating
 * system for no animation, and nothing about the CSS looks wrong.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS = join(ROOT, 'packages/ui/src/components')

/**
 * Comments come out first.
 *
 * These stylesheets explain themselves at length, and the explanations quote
 * § 6 — durations, animation names, the banned list. A gate that scanned the
 * prose would flag the document it is enforcing, which is the fastest way to
 * get a gate switched off. (`check-migration-order.mjs` learned this the same
 * way, on migration 0017's own warning.)
 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '')

const sheet = stripComments(
  ['primitives.css.ts', 'screens.css.ts']
    .map((f) => readFileSync(join(COMPONENTS, f), 'utf8'))
    .join('\n'),
)

/**
 * The catalogue, read out of `motion.ts` rather than copied here.
 *
 * A hand-copied list is a list that drifts, and the drift would be silent in
 * exactly the direction that matters: a gate whose allowlist is longer than the
 * document's.
 */
const motionSrc = readFileSync(join(ROOT, 'packages/ui/src/tokens/motion.ts'), 'utf8')
const catalogue = (motionSrc.match(/PERMITTED_ANIMATIONS[^=]*=\s*\[([\s\S]*?)\n\s*\]/) ?? [, ''])[1]
const permitted = new Set([...catalogue.matchAll(/\bid:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]))
const loops = new Set(
  (motionSrc.match(/PERMITTED_LOOPS[^=]*=\s*\[([^\]]*)\]/) ?? [, ''])[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean),
)
const maxMs = Number((motionSrc.match(/MAX_DURATION_MS\s*=\s*(\d+)/) ?? [, '400'])[1])

if (permitted.size === 0) {
  console.error('check-motion: read no animations out of motion.ts — refusing to pass vacuously.')
  process.exit(1)
}

const problems = []

/* ── 1. Only the permitted keyframes exist ──────────────────────────────── */

for (const m of sheet.matchAll(/@keyframes\s+([a-z0-9_-]+)/gi)) {
  const name = m[1]
  if (!permitted.has(name) && !loops.has(name)) {
    problems.push(
      `@keyframes ${name} is not one of the seven animations DESIGN_SYSTEM.md § 6 permits. ` +
      `Add it to PERMITTED_ANIMATIONS with the document's own words for it, or remove it.`,
    )
  }
}

/* ── 2 & 3. Durations are tokens, and under the cap ─────────────────────── */

for (const m of sheet.matchAll(/(animation|transition)\s*:\s*([^;}]+)/gi)) {
  const [, property, value] = m
  if (value.trim() === 'none') continue

  for (const literal of value.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)(ms|s)\b/g)) {
    const ms = literal[2] === 's' ? Number(literal[1]) * 1000 : Number(literal[1])

    // The shimmer and the spinner are the granted exceptions: § 6 caps the
    // shimmer's *speed* ("no faster than 1.4s") rather than its length, because
    // a skeleton that shimmered once would read as a rendering failure.
    const granted = [...loops].some((l) => value.includes(l))
    if (!granted && ms > maxMs) {
      problems.push(`${property}: ${literal[0]} exceeds the ${maxMs}ms cap in § 6 — "${value.trim()}"`)
    }
    if (!granted) {
      problems.push(
        `${property} hardcodes ${literal[0]} instead of a --motion-*-duration token — ` +
        `prefers-reduced-motion is implemented by zeroing those tokens, so a literal ` +
        `duration keeps animating for someone who asked for no animation: "${value.trim()}"`,
      )
    }
  }
}

/* ── 4. Reduced motion reaches every keyframe animation ─────────────────── */

// The rules inside `@media (prefers-reduced-motion: reduce)` blocks.
const reducedBlocks = []
for (const m of sheet.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/gi)) {
  let depth = 0
  let i = sheet.indexOf('{', m.index)
  const start = i
  for (; i < sheet.length; i++) {
    if (sheet[i] === '{') depth++
    else if (sheet[i] === '}' && --depth === 0) break
  }
  reducedBlocks.push(sheet.slice(start, i))
}
const reduced = reducedBlocks.join('\n')

for (const m of sheet.matchAll(/animation\s*:\s*([a-z][a-z0-9_-]*)\s/gi)) {
  const name = m[1]
  if (name === 'none') continue
  // Either the keyframe name is redefined under reduced motion (opacity-only),
  // or the rule that uses it is turned off there.
  const named = new RegExp(`@keyframes\\s+${name}\\b`).test(reduced)
  const disabled = reduced.includes('animation: none')
  if (!named && !disabled) {
    problems.push(
      `animation \`${name}\` has no prefers-reduced-motion treatment. § 6: ` +
      `"collapses every transition to opacity-only or instant … Nothing is left in motion."`,
    )
  }
}

if (reducedBlocks.length === 0) {
  problems.push('no prefers-reduced-motion block at all — § 6 requires one')
}

/* ── 5. The banned list, by name ────────────────────────────────────────── */

const BANNED = [
  [/confetti/i, 'confetti'],
  [/checkmark[-_]?(explo|burst|pop)/i, 'checkmark explosions'],
  [/particle/i, 'particle systems'],
  [/parallax/i, 'parallax'],
  [/cinematic/i, 'cinematic sequences'],
]
for (const [pattern, why] of BANNED) {
  if (pattern.test(sheet)) problems.push(`${why} is explicitly banned by DESIGN_SYSTEM.md § 6`)
}

// `infinite` outside the two granted loops is looping ambient motion.
for (const m of sheet.matchAll(/animation\s*:\s*([^;}]*\binfinite\b[^;}]*)/gi)) {
  const value = m[1]
  if (![...loops].some((l) => value.includes(l))) {
    problems.push(`looping ambient motion is banned by § 6 — "animation: ${value.trim()}"`)
  }
}

/* ── Report ─────────────────────────────────────────────────────────────── */

if (problems.length > 0) {
  console.error('check-motion: DESIGN_SYSTEM.md § 6 permits seven animations.\n')
  for (const p of [...new Set(problems)].sort()) console.error(`  ${p}`)
  process.exit(1)
}

console.log(
  `check-motion: ${permitted.size} permitted animations, ${loops.size} granted loops, ` +
  'nothing over the cap, and reduced motion reaches all of it.',
)

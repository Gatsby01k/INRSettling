#!/usr/bin/env node
/**
 * Every class a screen names has a rule; every custom property has a value.
 *
 * This gate exists because of two defects Stage 10 found by looking, both of
 * the same shape and both invisible to every test in the suite:
 *
 *  1. `primitives.css.ts` read `var(--status-action-required-fg)` in ten places.
 *     The emitter wrote `--status-action_required-fg`, because `statusColor` is
 *     keyed by the snake_case `StatusTone` union and the kebab function only
 *     handled camelCase. Every error affordance in the product — invalid field
 *     borders, the error toast, the blocking requirement bar, the
 *     action-required status dot, and a destructive button whose white label
 *     sat on a transparent background — rendered with no colour.
 *
 *  2. `--accent-gradient` was exported as a token, referenced by
 *     `.is-progress__step--done`, and never emitted at all. The saffron→teal
 *     fill that `DESIGN_SYSTEM.md § 6` describes as the settlement's primary
 *     visual has never once rendered.
 *
 *  3. Every layout class the composed screens use — `is-page__header`,
 *     `is-form`, `is-facts`, `is-settlement`, `is-endpoint`, `is-destination`
 *     and two dozen more — had no rule anywhere. The primitives were styled;
 *     the pages they sit on were not.
 *
 * None of this fails. CSS drops an unknown custom property and ignores an
 * unknown class, so the page renders, the tests pass, the token contrast suite
 * passes — it was asserting the *values*, which were right the whole time — and
 * a screenshot of the wrong thing looks like a design decision.
 *
 * `DESIGN_SYSTEM.md § 5` is explicit that this is not cosmetic: *"a component
 * that exists in an app but not in packages/ui is a bug"*. A class that exists
 * in an app but in no stylesheet is the same bug wearing different clothes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// An explicit root makes the gate testable against a throwaway tree, which is
// how it is proved to reject the three defects described above rather than
// merely to run.
const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')

/** Source files that may name a class. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'storybook-static') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(entry) && !p.endsWith('.css.ts')) out.push(p)
  }
  return out
}

/** The published stylesheet, as text. Read rather than imported: this is a
 *  Node script with no TypeScript loader, and the sheets are plain templates. */
function stylesheet() {
  return ['primitives.css.ts', 'screens.css.ts']
    .map((f) => readFileSync(join(ROOT, 'packages/ui/src/components', f), 'utf8'))
    .join('\n')
}

const sheet = stylesheet()
const defined = new Set([...sheet.matchAll(/\.(is-[a-z0-9_-]+)/gi)].map((m) => m[1]))

const problems = []

/* ── 1. Class names ─────────────────────────────────────────────────────── */

for (const file of [...sources(join(ROOT, 'packages')), ...sources(join(ROOT, 'apps'))]) {
  const src = readFileSync(file, 'utf8')
  const rel = file.slice(ROOT.length + 1)
  for (const match of src.matchAll(/className=\{?[`'"]([^`'"]*)/g)) {
    for (const cls of match[1].split(/\s+/)) {
      // A class built from an interpolation cannot be resolved statically. The
      // literal prefix still can be, and that is where a typo would live.
      if (cls.includes('${') || cls.includes('{')) continue
      if (!cls.startsWith('is-')) continue
      if (!defined.has(cls)) problems.push(`${rel}: class \`${cls}\` has no rule in any stylesheet`)
    }
  }
}

/* ── 2. Custom properties ───────────────────────────────────────────────── */

// The stylesheets are templates that interpolate `tokensToCss()`, so the
// authoritative list of defined properties lives in the token emitter. Read the
// three shapes it writes rather than executing TypeScript from a .mjs script.
const tokenSrc = readFileSync(join(ROOT, 'packages/ui/src/tokens/to-css.ts'), 'utf8')
const tokensTs = readFileSync(join(ROOT, 'packages/ui/src/tokens/tokens.ts'), 'utf8')

const kebab = (s) => s.replace(/_/g, '-').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const keysOf = (name) => {
  // Multi-line objects end at a line-initial `} as const`; single-line ones
  // (`export const radius = { sm: 4, … } as const`) end on the same line. Both
  // shapes are in tokens.ts, and matching only the first silently returned an
  // empty key list — which would have made this gate pass by knowing nothing.
  const block =
    tokensTs.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\} as const`)) ??
    tokensTs.match(new RegExp(`export const ${name} = \\{([^\\n]*?)\\} as const`))
  if (!block) throw new Error(`check-styles: cannot find token group \`${name}\` in tokens.ts`)
  return [...block[1].matchAll(/(?:^|[{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1])
}

const props = new Set()
for (const k of keysOf('color')) props.add(`--color-${kebab(k)}`)
for (const k of keysOf('statusColor')) {
  props.add(`--status-${kebab(k)}-fg`)
  props.add(`--status-${kebab(k)}-bg`)
}
for (const k of keysOf('type')) {
  for (const part of ['size', 'line', 'weight', 'tracking']) props.add(`--type-${kebab(k)}-${part}`)
}
for (const k of keysOf('radius')) props.add(`--radius-${k}`)
for (const k of keysOf('shadow')) props.add(`--shadow-${k}`)
for (const k of keysOf('motion')) {
  props.add(`--motion-${k}-duration`)
  props.add(`--motion-${k}-easing`)
}
const spaceCount = (tokensTs.match(/export const space = \[([^\]]*)\]/) ?? [, ''])[1]
  .split(',').filter((s) => s.trim()).length
for (let i = 0; i < spaceCount; i++) props.add(`--space-${i}`)
props.add('--font-ui')
props.add('--font-mono')
// Anything the emitter pushes as a literal line, e.g. `--accent-gradient`.
for (const m of tokenSrc.matchAll(/`\s*(--[a-z0-9-]+):/gi)) props.add(m[1])

for (const m of sheet.matchAll(/var\(\s*(--[a-z0-9_-]+)/gi)) {
  if (!props.has(m[1])) {
    problems.push(`packages/ui/src/components: \`var(${m[1]})\` is not a property the tokens emit`)
  }
}

/* ── 3. Two components, one block ───────────────────────────────────────── */

/**
 * A class declared twice with a different structural value.
 *
 * `AmountInput` and `AmountDisplay` both claimed `.is-amount`. The display's
 * block came later in the file, so it won, and the input's wrapper silently
 * lost `position: relative` and became an inline-flex column — which sent its
 * absolutely-positioned ₹ symbol out of the field and stopped the field filling
 * its width, on the first figure typed on the most important screen in the
 * product. The cascade did exactly what it is specified to do; the mistake was
 * two components sharing a name.
 *
 * Structural properties only, and only outside `@media`: a breakpoint
 * redeclaring `display` is the responsive design working, not a collision.
 */
const STRUCTURAL = ['display', 'position', 'flex-direction', 'grid-template-columns']

// Strip media blocks by brace matching — a regex cannot balance braces, and a
// greedy one would eat the rest of the sheet.
function withoutAtRules(css) {
  let out = ''
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith('@media', i) || css.startsWith('@supports', i)) {
      let depth = 0
      let j = css.indexOf('{', i)
      if (j === -1) break
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++
        else if (css[j] === '}' && --depth === 0) break
      }
      i = j
      continue
    }
    out += css[i]
  }
  return out
}

const declarations = new Map()
// The lookbehind keeps this to a bare class selector: `textarea.is-field__control`
// and `.is-a .is-b` are qualified or descendant selectors with different
// specificity, and treating them as the same rule would invent collisions.
// `.is-x:hover {` and `.is-x[aria-invalid] {` are excluded by requiring the
// brace to follow the name directly.
for (const rule of withoutAtRules(sheet).matchAll(/(?<![\w\-.\])])\.(is-[a-z0-9_-]+)\s*\{([^{}]*)\}/gim)) {
  const [, cls, body] = rule
  for (const prop of STRUCTURAL) {
    const found = body.match(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;}]+)`, 'i'))
    if (!found) continue
    const value = found[1].trim()
    const key = `${cls}.${prop}`
    const prior = declarations.get(key)
    if (prior !== undefined && prior !== value) {
      problems.push(
        `\`.${cls}\` declares \`${prop}\` twice with different values ` +
        `(\`${prior}\` then \`${value}\`) — two components are sharing one block name`,
      )
    }
    declarations.set(key, value)
  }
}

/* ── 4. The four breakpoints ────────────────────────────────────────────── */

/**
 * `DESIGN_SYSTEM.md § 8` fixes four breakpoints, and the CSS must use those and
 * no others.
 *
 * A stray `max-width: 900px` is not wrong the way a broken selector is wrong —
 * it works, it just puts the layout change three pixels from where the document
 * says, and nobody notices until two files disagree about where "mobile"
 * starts. Desktop-first, so the rules narrow: `max-width` at one less than each
 * threshold.
 */
const THRESHOLDS = readFileSync(join(ROOT, 'packages/ui/src/components/responsive.ts'), 'utf8')
const declared = [...THRESHOLDS.matchAll(/^\s*(full|compact|stacked):\s*(\d+)/gm)].map((m) =>
  Number(m[2]),
)
if (declared.length !== 3) {
  throw new Error('check-styles: cannot read the three breakpoints from responsive.ts')
}
const allowed = new Set(declared.map((n) => n - 1))

for (const m of sheet.matchAll(/@media[^{]*?max-width:\s*(\d+)px/gi)) {
  const width = Number(m[1])
  if (!allowed.has(width)) {
    problems.push(
      `@media (max-width: ${width}px) is not one of the DESIGN_SYSTEM.md § 8 breakpoints ` +
      `(${[...allowed].sort((a, b) => a - b).join('px, ')}px)`,
    )
  }
}

/* ── Report ─────────────────────────────────────────────────────────────── */

if (problems.length > 0) {
  console.error('check-styles: the stylesheet and the screens disagree.\n')
  for (const p of [...new Set(problems)].sort()) console.error(`  ${p}`)
  console.error(
    '\nCSS ignores an unknown class and drops an unknown custom property, so ' +
    'neither of these fails at runtime. That is why it is checked here.',
  )
  process.exit(1)
}

console.log('check-styles: every class has a rule and every property has a value.')

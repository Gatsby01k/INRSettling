import {
  accentGradient, color, font, motion, radius, shadow, space, statusColor,
  type as typeScale,
} from './tokens.js'

/**
 * `camelCase` **and** `snake_case` become `kebab-case`.
 *
 * The underscore half is not cosmetic. `statusColor` is keyed by the
 * `StatusTone` union, whose members are snake_case (`action_required`), so this
 * function used to emit `--status-action_required-fg` while all ten call sites
 * in `primitives.css.ts` wrote `--status-action-required-fg`. An undefined
 * custom property is not an error in CSS — it silently falls back to the
 * property's initial value — so every error affordance in the system rendered
 * with no colour: invalid field borders, the error toast, the blocking
 * requirement bar, the action-required status dot, and a destructive button
 * whose white label sat on a transparent background.
 *
 * The token *values* were correct the whole time, which is why the token tests
 * passed. `checkCustomProperties` below is the assertion that would have caught
 * it, and now does.
 */
const kebab = (s: string) =>
  s.replace(/_/g, '-').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** Emit the same values as CSS custom properties. One source, two consumers. */
export function tokensToCss(): string {
  const lines: string[] = [
    '/* Generated from packages/ui/src/tokens/tokens.ts — do not edit by hand. */',
    ':root {',
    "  font-feature-settings: 'tnum' 1, 'ss01' 1; /* tabular numerals, always */",
  ]
  for (const [k, v] of Object.entries(color)) lines.push(`  --color-${kebab(k)}: ${v};`)
  // The saffron→teal rail fill (§ 6). Exported as a token since Stage 1 and
  // referenced by `.is-progress__step--done`, but never emitted — so the one
  // visual the settlement progression is built around never rendered.
  lines.push(`  --accent-gradient: ${accentGradient};`)
  for (const [k, v] of Object.entries(statusColor)) {
    lines.push(`  --status-${kebab(k)}-fg: ${v.fg};`)
    lines.push(`  --status-${kebab(k)}-bg: ${v.bg};`)
  }
  lines.push(`  --font-ui: ${font.ui};`, `  --font-mono: ${font.mono};`)
  for (const [k, v] of Object.entries(typeScale)) {
    lines.push(`  --type-${kebab(k)}-size: ${v.size}px;`)
    lines.push(`  --type-${kebab(k)}-line: ${v.line}px;`)
    lines.push(`  --type-${kebab(k)}-weight: ${v.weight};`)
    lines.push(`  --type-${kebab(k)}-tracking: ${v.tracking};`)
  }
  space.forEach((v, i) => lines.push(`  --space-${i}: ${v}px;`))
  for (const [k, v] of Object.entries(radius)) lines.push(`  --radius-${k}: ${v}px;`)
  for (const [k, v] of Object.entries(shadow)) lines.push(`  --shadow-${k}: ${v};`)
  for (const [k, v] of Object.entries(motion)) {
    lines.push(`  --motion-${k}-duration: ${v.duration}ms;`)
    lines.push(`  --motion-${k}-easing: ${v.easing};`)
  }
  lines.push('}', '', '@media (prefers-reduced-motion: reduce) {', '  :root {')
  for (const k of Object.keys(motion)) lines.push(`    --motion-${k}-duration: 0ms;`)
  lines.push('  }', '}')
  return lines.join('\n') + '\n'
}

/**
 * Every `var(--x)` a stylesheet reads must be a `--x` this file writes.
 *
 * CSS has no error for reading an undefined custom property: the declaration is
 * simply dropped and the property keeps its initial value. A white background,
 * a black border, no gradient. Nothing logs, nothing throws, and a screenshot
 * of the wrong thing looks like a design decision. Two of these had been live
 * since Stage 1 and Stage 3 and were found by writing this function.
 *
 * Returns the names used but never defined; empty means the sheet is sound.
 */
export function undefinedCustomProperties(stylesheet: string): string[] {
  const defined = new Set(
    [...tokensToCss().matchAll(/(?:^|[{;])\s*(--[a-z0-9_-]+)\s*:/gim)].map((m) => m[1]!),
  )
  const used = new Set(
    [...stylesheet.matchAll(/var\(\s*(--[a-z0-9_-]+)/gi)].map((m) => m[1]!),
  )
  // A `var(--x, fallback)` is still a bug if `--x` is meant to be a token: the
  // fallback hides the typo. But locally-declared properties are legitimate, so
  // anything the sheet itself declares counts as defined.
  const local = new Set(
    [...stylesheet.matchAll(/(?:^|[{;])\s*(--[a-z0-9_-]+)\s*:/gim)].map((m) => m[1]!),
  )
  return [...used].filter((name) => !defined.has(name) && !local.has(name)).sort()
}

/**
 * The style gate, proved against the three defects that motivated it.
 *
 * Each of them shipped and passed every test in the suite, because CSS has no
 * error for any of them: an unknown class does nothing, an undefined custom
 * property is dropped, and the page renders looking like a decision somebody
 * made. A gate that has never rejected anything is indistinguishable from one
 * that cannot, so the rejections are asserted directly — and so are the
 * near-misses, because a check that flagged a legitimate interpolated class
 * name would be switched off within a week, and then the real one ships.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'check-styles.mjs')

/** The smallest tokens.ts the gate can read. */
const TOKENS = `
export const color = {
  bgBase: '#FBFBF9',
  inkMuted: '#6B7B90',
} as const
export const accentGradient = 'linear-gradient(90deg, #E8871E 0%, #0E8A6E 100%)'
export const statusColor = {
  ready: { fg: '#33465F', bg: '#F1F3F6' },
  action_required: { fg: '#B42318', bg: '#FEF3F2' },
} as const
export const type = {
  body: { size: 14, line: 20, weight: 400, tracking: '0' },
} as const
export const space = [2, 4, 6] as const
export const radius = { sm: 4, pill: 999 } as const
export const shadow = { sm: '0 1px 2px rgba(0,0,0,.04)' } as const
export const motion = {
  standard: { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
} as const
`

/** The emitter, reduced to the lines the gate parses out of it. */
const TO_CSS = `
export function tokensToCss(): string {
  const lines: string[] = []
  lines.push(\`  --accent-gradient: \${accentGradient};\`)
  return lines.join('\\n')
}
`

/** The § 8 breakpoints, as the gate reads them. */
const RESPONSIVE = `
export const BREAKPOINTS = {
  full: 1280,
  compact: 1024,
  stacked: 768,
} as const
`

interface Tree {
  primitives?: string
  screens?: string
  sources?: Record<string, string>
}

function runOn(tree: Tree): { ok: boolean; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'styles-'))
  const components = join(root, 'packages', 'ui', 'src', 'components')
  const tokens = join(root, 'packages', 'ui', 'src', 'tokens')
  mkdirSync(components, { recursive: true })
  mkdirSync(tokens, { recursive: true })
  mkdirSync(join(root, 'apps'), { recursive: true })

  writeFileSync(join(tokens, 'tokens.ts'), TOKENS)
  writeFileSync(join(tokens, 'to-css.ts'), TO_CSS)
  writeFileSync(join(components, 'responsive.ts'), RESPONSIVE)
  writeFileSync(join(components, 'primitives.css.ts'), tree.primitives ?? 'export const c = `\n`')
  writeFileSync(join(components, 'screens.css.ts'), tree.screens ?? 'export const s = `\n`')
  for (const [name, src] of Object.entries(tree.sources ?? {})) {
    writeFileSync(join(components, name), src)
  }

  try {
    return { ok: true, out: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('defect 1 — the property the emitter never wrote under that name', () => {
  it('rejects var(--status-action-required-fg) when the emitter writes snake_case', () => {
    // Exactly what shipped: `statusColor` is keyed by the snake_case StatusTone
    // union, the kebab function handled only camelCase, and ten call sites read
    // a property that did not exist. Every error affordance rendered colourless.
    const { ok, out } = runOn({
      primitives: 'export const c = `.is-x { color: var(--status-action-required-fg); }`',
    })
    // The gate under test emits the kebab-cased name, so this now *passes* —
    // which is the fix. What must fail is a genuinely absent property.
    expect(ok, out).toBe(true)

    const bad = runOn({
      primitives: 'export const c = `.is-x { color: var(--status-action_required-fg); }`',
    })
    expect(bad.ok).toBe(false)
    expect(bad.out).toContain('--status-action_required-fg')
  })

  it('rejects any property the tokens do not emit', () => {
    const { ok, out } = runOn({
      primitives: 'export const c = `.is-x { color: var(--color-not-a-token); }`',
    })
    expect(ok).toBe(false)
    expect(out).toContain('--color-not-a-token')
  })
})

describe('defect 2 — the token that was exported but never emitted', () => {
  it('accepts --accent-gradient once the emitter pushes it', () => {
    const { ok, out } = runOn({
      primitives: 'export const c = `.is-x { border-image: var(--accent-gradient) 1; }`',
    })
    expect(ok, out).toBe(true)
  })

  it('rejects it when the emitter does not', () => {
    const root = mkdtempSync(join(tmpdir(), 'styles-'))
    const components = join(root, 'packages', 'ui', 'src', 'components')
    const tokens = join(root, 'packages', 'ui', 'src', 'tokens')
    mkdirSync(components, { recursive: true })
    mkdirSync(tokens, { recursive: true })
    mkdirSync(join(root, 'apps'), { recursive: true })
    writeFileSync(join(tokens, 'tokens.ts'), TOKENS)
    writeFileSync(join(components, 'responsive.ts'), RESPONSIVE)
    // An emitter that pushes nothing extra — the Stage 1 state.
    writeFileSync(join(tokens, 'to-css.ts'), 'export function tokensToCss(): string { return "" }')
    writeFileSync(
      join(components, 'primitives.css.ts'),
      'export const c = `.is-x { border-image: var(--accent-gradient) 1; }`',
    )
    writeFileSync(join(components, 'screens.css.ts'), 'export const s = `\n`')

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
    expect(out).toContain('--accent-gradient')
  })
})

describe('defect 3 — the class every screen used and no stylesheet defined', () => {
  it('rejects a class with no rule anywhere', () => {
    const { ok, out } = runOn({
      sources: { 'x.tsx': 'export const X = () => <div className="is-page__header" />' },
    })
    expect(ok).toBe(false)
    expect(out).toContain('is-page__header')
  })

  it('accepts it once a rule exists, in either stylesheet', () => {
    expect(
      runOn({
        primitives: 'export const c = `.is-page__header { display: flex; }`',
        sources: { 'x.tsx': 'export const X = () => <div className="is-page__header" />' },
      }).ok,
    ).toBe(true)

    expect(
      runOn({
        screens: 'export const s = `.is-page__header { display: flex; }`',
        sources: { 'x.tsx': 'export const X = () => <div className="is-page__header" />' },
      }).ok,
    ).toBe(true)
  })

  it('checks every class in a multi-class attribute, not just the first', () => {
    const { ok, out } = runOn({
      primitives: 'export const c = `.is-field { display: grid; }`',
      sources: { 'x.tsx': 'export const X = () => <div className="is-field is-picker" />' },
    })
    expect(ok).toBe(false)
    expect(out).toContain('is-picker')
  })
})

describe('near-misses it must not flag', () => {
  it('skips a class built from an interpolation', () => {
    // `is-btn--${variant}` cannot be resolved statically, and flagging it would
    // get the whole gate switched off.
    const { ok, out } = runOn({
      sources: {
        'x.tsx': 'export const X = (v: string) => <div className={`is-btn--${v}`} />',
      },
    })
    expect(ok, out).toBe(true)
  })

  it('ignores class names that are not ours', () => {
    const { ok, out } = runOn({
      sources: { 'x.tsx': 'export const X = () => <div className="sb-unstyled prose" />' },
    })
    expect(ok, out).toBe(true)
  })

  it('does not read the stylesheets as sources of class usage', () => {
    // A `.css.ts` file names every class it defines. Treating those as usages
    // would be circular and would pass unconditionally.
    const { ok, out } = runOn({
      primitives: 'export const c = `.is-defined { color: red; }`',
    })
    expect(ok, out).toBe(true)
  })
})

describe('the parser itself', () => {
  it('refuses to run rather than pass vacuously on an unreadable token file', () => {
    const root = mkdtempSync(join(tmpdir(), 'styles-'))
    const components = join(root, 'packages', 'ui', 'src', 'components')
    const tokens = join(root, 'packages', 'ui', 'src', 'tokens')
    mkdirSync(components, { recursive: true })
    mkdirSync(tokens, { recursive: true })
    mkdirSync(join(root, 'apps'), { recursive: true })
    // No `radius` group at all. A gate that shrugged and carried on would then
    // be checking against an empty property set and passing everything.
    writeFileSync(join(tokens, 'tokens.ts'), 'export const color = {\n  ink: "#000",\n} as const')
    writeFileSync(join(components, 'responsive.ts'), RESPONSIVE)
    writeFileSync(join(tokens, 'to-css.ts'), 'export function tokensToCss() { return "" }')
    writeFileSync(join(components, 'primitives.css.ts'), 'export const c = `\n`')
    writeFileSync(join(components, 'screens.css.ts'), 'export const s = `\n`')

    let failed = false
    try {
      execFileSync('node', [SCRIPT, root], { encoding: 'utf8', stdio: 'pipe' })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})

describe('defect 4 — two components sharing one block name', () => {
  it('rejects a class whose structural property is declared twice with different values', () => {
    // What shipped: `.is-amount` for the amount *input* (relative, row) and
    // `.is-amount` for the amount *display* (static, inline-flex column), in
    // that order. The cascade did what it is specified to do; the mistake was
    // two components claiming one name, and nothing said so.
    const { ok, out } = runOn({
      primitives:
        'export const c = `' +
        '.is-amount { position: relative; display: flex; }' +
        '.is-amount { display: inline-flex; flex-direction: column; }`',
    })
    expect(ok).toBe(false)
    expect(out).toContain('sharing one block name')
    expect(out).toContain('is-amount')
  })

  it('allows a breakpoint to redeclare it — that is responsive design working', () => {
    const { ok, out } = runOn({
      screens:
        'export const s = `' +
        '.is-grid { display: grid; grid-template-columns: repeat(4, 1fr); }' +
        '@media (max-width: 767px) { .is-grid { grid-template-columns: 1fr; } }`',
    })
    expect(ok, out).toBe(true)
  })

  it('allows the same declaration twice — repetition is not a collision', () => {
    const { ok, out } = runOn({
      primitives: 'export const c = `.is-x { display: flex; }\n.is-x { display: flex; gap: 4px; }`',
    })
    expect(ok, out).toBe(true)
  })

  it('ignores non-structural properties, which layer legitimately', () => {
    const { ok, out } = runOn({
      primitives: 'export const c = `.is-x { color: red; }\n.is-x { color: blue; }`',
    })
    expect(ok, out).toBe(true)
  })
})

describe('the § 8 breakpoints', () => {
  it('accepts the three the document fixes', () => {
    const { ok, out } = runOn({
      screens:
        'export const s = `' +
        '@media (max-width: 1279px) { .is-x { display: grid; } }' +
        '@media (max-width: 1023px) { .is-x { display: block; } }' +
        '@media (max-width: 767px) { .is-x { display: flex; } }`',
      sources: { 'x.tsx': 'export const X = () => <div className="is-x" />' },
    })
    expect(ok, out).toBe(true)
  })

  it('rejects an invented one', () => {
    // A stray `max-width: 900px` is not wrong the way a broken selector is
    // wrong — it works, it just puts the layout change 124px from where
    // DESIGN_SYSTEM.md § 8 says, and nobody notices until two files disagree
    // about where "mobile" starts.
    const { ok, out } = runOn({
      screens: 'export const s = `@media (max-width: 900px) { .is-x { display: block; } }`',
      sources: { 'x.tsx': 'export const X = () => <div className="is-x" />' },
    })
    expect(ok).toBe(false)
    expect(out).toContain('900px')
    expect(out).toContain('§ 8')
  })

  it('reads the thresholds from responsive.ts rather than carrying its own copy', () => {
    // Change the source of truth and the gate follows it. A hand-copied triple
    // would let the two disagree, which is the drift the gate exists to stop.
    const { ok, out } = runOn(
      {
        screens: 'export const s = `@media (max-width: 899px) { .is-x { display: block; } }`',
        sources: { 'x.tsx': 'export const X = () => <div className="is-x" />' },
      },
    )
    expect(ok).toBe(false)
    expect(out).toContain('899px')
  })
})

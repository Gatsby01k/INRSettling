/**
 * The motion gate, proved against every clause of `DESIGN_SYSTEM.md § 6` it
 * enforces — and against the near-misses that would get it switched off.
 *
 * § 6 is unusual among the frozen documents in being mostly a list of things
 * not to do, and a prohibition is the hardest kind of rule to keep: nothing
 * fails when it is broken, the build stays green, and the product acquires a
 * bounce. So the assertions below are mostly rejections.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'check-motion.mjs')

/** The catalogue, reduced to what the gate parses out of it. */
const MOTION = `
export const PERMITTED_ANIMATIONS = [
  { id: 'is-amount-morph', token: 'amount', reduced: 'instant' },
  { id: 'is-event-enter', token: 'standard', reduced: 'opacity' },
  { id: 'is-shimmer', token: 'standard', reduced: 'instant' },
] as const
export const MAX_DURATION_MS = 400
export const PERMITTED_LOOPS: readonly string[] = ['is-shimmer', 'is-spin']
`

const REDUCED = `
@media (prefers-reduced-motion: reduce) {
  .is-x { animation: none; }
}`

function runOn(css: string, motion = MOTION): { ok: boolean; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'motion-'))
  const components = join(root, 'packages', 'ui', 'src', 'components')
  const tokens = join(root, 'packages', 'ui', 'src', 'tokens')
  mkdirSync(components, { recursive: true })
  mkdirSync(tokens, { recursive: true })
  writeFileSync(join(components, 'primitives.css.ts'), `export const c = \`${css}\``)
  writeFileSync(join(components, 'screens.css.ts'), 'export const s = `\n`')
  writeFileSync(join(tokens, 'motion.ts'), motion)
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('the closed list of seven', () => {
  it('accepts an animation that is on it', () => {
    const { ok, out } = runOn(`
      .is-x { animation: is-event-enter var(--motion-standard-duration) ease; }
      @keyframes is-event-enter { from { opacity: 0; } to { opacity: 1; } }
      ${REDUCED}`)
    expect(ok, out).toBe(true)
  })

  it('rejects an eighth animation, however innocent', () => {
    const { ok, out } = runOn(`
      .is-x { animation: is-gentle-glow var(--motion-standard-duration) ease; }
      @keyframes is-gentle-glow { from { opacity: 0.5; } to { opacity: 1; } }
      ${REDUCED}`)
    expect(ok).toBe(false)
    expect(out).toContain('is-gentle-glow')
    expect(out).toContain('seven animations')
  })
})

describe('the 400ms cap', () => {
  it('rejects anything longer, in ms or s', () => {
    expect(runOn(`.is-x { transition: opacity 600ms ease; } ${REDUCED}`).out).toContain('cap')
    expect(runOn(`.is-x { transition: opacity 1.2s ease; } ${REDUCED}`).out).toContain('cap')
  })

  it('exempts the two granted loops, whose length is the point', () => {
    // § 6 caps the shimmer's *speed* — "no faster than 1.4s" — rather than its
    // duration, because a skeleton that shimmered once would read as a
    // rendering failure rather than a wait.
    const { ok, out } = runOn(`
      .is-skeleton { animation: is-shimmer 1.4s ease-in-out infinite; }
      @keyframes is-shimmer { from { opacity: 0.6; } to { opacity: 1; } }
      ${REDUCED}`)
    expect(ok, out).toBe(true)
  })
})

describe('durations come from tokens', () => {
  it('rejects a hardcoded duration even when it is under the cap', () => {
    // This is the clause that does the most work. Reduced motion is implemented
    // by zeroing `--motion-*-duration` inside the media query, so a literal
    // 300ms keeps animating for someone who asked the OS for no animation, and
    // nothing about the rule looks wrong.
    const { ok, out } = runOn(`
      .is-x { animation: is-event-enter 300ms ease; }
      @keyframes is-event-enter { from { opacity: 0; } to { opacity: 1; } }
      ${REDUCED}`)
    expect(ok).toBe(false)
    expect(out).toContain('hardcodes 300ms')
    expect(out).toContain('prefers-reduced-motion')
  })

  it('accepts a token', () => {
    const { ok, out } = runOn(`
      .is-x { transition: background-color var(--motion-micro-duration) var(--motion-micro-easing); }
      ${REDUCED}`)
    expect(ok, out).toBe(true)
  })
})

describe('reduced motion reaches everything', () => {
  it('rejects an animation with no reduced-motion treatment', () => {
    const { ok, out } = runOn(`
      .is-x { animation: is-event-enter var(--motion-standard-duration) ease; }
      @keyframes is-event-enter { from { opacity: 0; } to { opacity: 1; } }`)
    expect(ok).toBe(false)
    expect(out).toMatch(/prefers-reduced-motion/)
  })

  it('accepts a keyframe redefined to opacity-only under the media query', () => {
    const { ok, out } = runOn(`
      .is-x { animation: is-event-enter var(--motion-standard-duration) ease; }
      @keyframes is-event-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        @keyframes is-event-enter { from { opacity: 0; } to { opacity: 1; } }
      }`)
    expect(ok, out).toBe(true)
  })
})

describe('the banned list', () => {
  it.each([
    ['confetti', '@keyframes is-confetti { to { opacity: 1; } }'],
    ['particle systems', '.is-x { background: url(particles.svg); }'],
    ['parallax', '.is-parallax-layer { transform: translateZ(0); }'],
    // A class name, not a comment: the gate strips comments before scanning,
    // and a comment that mentions the banned list is the document being quoted.
    ['cinematic sequences', '.is-cinematic-intro { opacity: 1; }'],
  ])('rejects %s', (why, css) => {
    const { ok, out } = runOn(`${css} ${REDUCED}`)
    expect(ok).toBe(false)
    expect(out).toContain(why)
  })

  it('rejects looping ambient motion outside the two granted loops', () => {
    const { ok, out } = runOn(`
      .is-x { animation: is-event-enter var(--motion-standard-duration) ease infinite; }
      @keyframes is-event-enter { from { opacity: 0; } to { opacity: 1; } }
      ${REDUCED}`)
    expect(ok).toBe(false)
    expect(out).toContain('looping ambient motion')
  })
})

describe('the gate itself', () => {
  it('reads the catalogue rather than carrying its own copy', () => {
    // A hand-copied allowlist drifts, and it drifts in the dangerous direction:
    // longer than the document's.
    const { ok, out } = runOn(
      `.is-x { animation: is-event-enter var(--motion-standard-duration) ease; }
       @keyframes is-event-enter { from { opacity: 0; } to { opacity: 1; } }
       ${REDUCED}`,
      `export const PERMITTED_ANIMATIONS = [
         { id: 'is-amount-morph', token: 'amount', reduced: 'instant' },
       ] as const
       export const MAX_DURATION_MS = 400
       export const PERMITTED_LOOPS: readonly string[] = []`,
    )
    expect(ok).toBe(false)
    expect(out).toContain('is-event-enter')
  })

  it('refuses to pass when it read no catalogue at all', () => {
    const { ok, out } = runOn(
      `.is-x { animation: whatever 10s infinite; } ${REDUCED}`,
      'export const MAX_DURATION_MS = 400',
    )
    expect(ok).toBe(false)
    expect(out).toContain('refusing to pass vacuously')
  })

  it('does not flag the document it quotes', () => {
    // These stylesheets explain themselves at length, quoting § 6 — durations,
    // animation names, the banned list. `check-migration-order.mjs` learned
    // this the same way, on migration 0017's own warning.
    const { ok, out } = runOn(`
      /* § 6: new rows slide 4px and fade in over 180ms. No bounce, no confetti. */
      .is-x { animation: is-event-enter var(--motion-standard-duration) ease; }
      @keyframes is-event-enter { from { opacity: 0; } to { opacity: 1; } }
      ${REDUCED}`)
    expect(ok, out).toBe(true)
  })
})

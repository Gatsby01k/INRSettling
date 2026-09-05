import { describe, expect, it } from 'vitest'
import { motion, statusColor, tokensToCss } from '../index.js'
import { undefinedCustomProperties } from './to-css.js'
import { primitivesCss } from '../components/primitives.css.js'

/** Relative luminance and contrast ratio, WCAG 2.x. */
function contrast(hexA: string, hexB: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!
  }
  const [a, b] = [lum(hexA), lum(hexB)].sort((x, y) => y - x)
  return (a! + 0.05) / (b! + 0.05)
}

describe('design tokens', () => {
  it('meets AA contrast for every status pair (DESIGN_SYSTEM.md § 7)', () => {
    for (const [name, pair] of Object.entries(statusColor)) {
      expect(contrast(pair.fg, pair.bg), `${name} ${pair.fg} on ${pair.bg}`)
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps every animation at or under 400ms', () => {
    for (const [name, m] of Object.entries(motion)) {
      expect(m.duration, name).toBeLessThanOrEqual(400)
    }
  })

  it('emits CSS that turns motion off under prefers-reduced-motion', () => {
    const css = tokensToCss()
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('--motion-amount-duration: 0ms;')
    expect(css).toContain("font-feature-settings: 'tnum' 1")
  })

  it('records the two deliberate deviations from DESIGN_SYSTEM.md § 2.4', () => {
    // Reverting either of these to the value in the frozen baseline drops the
    // pair below AA. If the baseline is amended, amend this test with it.
    expect(statusColor.settling.fg).toBe('#9C5808')
    expect(statusColor.cancelled.fg).toBe('#5F6E82')
    expect(contrast('#B36A0C', statusColor.settling.bg)).toBeLessThan(4.5)
    expect(contrast('#6B7B90', statusColor.cancelled.bg)).toBeLessThan(4.5)
  })

  it('exports one colour pair per customer-facing status, and only five', () => {
    expect(Object.keys(statusColor).sort()).toEqual(
      ['action_required', 'cancelled', 'ready', 'settled', 'settling'],
    )
  })
})

/**
 * The gate for a class of defect the token tests could not see.
 *
 * Every assertion above is about token *values*, and the values were always
 * right. What was wrong was the bridge: `primitives.css.ts` read
 * `--status-action-required-fg` and `--accent-gradient`, and the emitter wrote
 * `--status-action_required-fg` and nothing at all. CSS drops an undefined
 * custom property silently, so the whole error palette and the settlement
 * progression's saffron→teal fill rendered as the browser default with nothing
 * to indicate it.
 */
describe('the stylesheet and the tokens agree on names', () => {
  it('defines every custom property the component stylesheet reads', () => {
    const missing = undefinedCustomProperties(primitivesCss)
    expect(
      missing,
      `primitives.css.ts reads custom properties the tokens never define:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('emits the snake_case status keys in kebab-case, as CSS is written', () => {
    const css = tokensToCss()
    expect(css).toContain('--status-action-required-fg:')
    expect(css).toContain('--status-action-required-bg:')
    expect(css).not.toContain('--status-action_required')
  })

  it('emits the accent gradient the progression rail is drawn with', () => {
    expect(tokensToCss()).toMatch(/--accent-gradient: linear-gradient\(/)
  })

  it('catches a reference to a property that does not exist', () => {
    // The gate itself, proven against a sheet that is wrong on purpose.
    expect(undefinedCustomProperties('.x { color: var(--color-not-a-token); }'))
      .toEqual(['--color-not-a-token'])
    // …and not fooled by a property the sheet declares for itself.
    expect(undefinedCustomProperties('.x { --local: red; color: var(--local); }'))
      .toEqual([])
  })
})

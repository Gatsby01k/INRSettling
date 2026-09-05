/**
 * Motion, as behaviour rather than as CSS — `DESIGN_SYSTEM.md § 6`.
 *
 * `check-motion.mjs` proves the stylesheet obeys the catalogue. What it cannot
 * see is *when* a class lands, and that is where § 6's subtlest rule lives:
 * *"anything that moves while the user is reading a number"* is banned. Every
 * animation here fires on a **state change** and never on mount — otherwise
 * opening a settled settlement a week later would replay the settlement, which
 * is both motion during reading and a lie about when it happened.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { money } from '@inrsettle/money'
import { AmountDisplay, SettlementProgress } from './settlement.js'
import { StatusIndicator } from './beneficiary.js'
import { MetricTile } from './overview.js'
import { MAX_DURATION_MS, PERMITTED_ANIMATIONS, PERMITTED_LOOPS } from '../tokens/motion.js'
import { motion } from '../tokens/tokens.js'

afterEach(cleanup)

describe('§ 6 — the catalogue is seven, closed', () => {
  it('has exactly the seven animations the section lists', () => {
    expect(PERMITTED_ANIMATIONS).toHaveLength(7)
  })

  it('gives every one of them the document’s own words', () => {
    for (const a of PERMITTED_ANIMATIONS) {
      expect(a.description.length, a.id).toBeGreaterThan(40)
      expect(a.id).toMatch(/^is-[a-z-]+$/)
    }
  })

  it('gives every one a reduced-motion outcome, and never "unchanged"', () => {
    // "prefers-reduced-motion: reduce collapses every transition to
    // opacity-only or instant … Nothing is left in motion."
    for (const a of PERMITTED_ANIMATIONS) {
      expect(['opacity', 'instant'], a.id).toContain(a.reduced)
    }
  })

  it('uses only tokens that exist, all within the cap', () => {
    for (const a of PERMITTED_ANIMATIONS) {
      expect(motion[a.token], a.id).toBeDefined()
      expect(motion[a.token].duration, a.id).toBeLessThanOrEqual(MAX_DURATION_MS)
    }
  })

  it('grants exactly two loops, and says why in the file', () => {
    // A skeleton that shimmered once would read as a rendering failure rather
    // than a wait, so § 6 caps its speed instead of its repetition.
    expect([...PERMITTED_LOOPS].sort()).toEqual(['is-shimmer', 'is-spin'])
  })
})

describe('§ 6 — nothing moves on mount', () => {
  it('the amount does not morph on first render', () => {
    const { container } = render(
      <AmountDisplay amount={money('INR', 500000000n)} morph />,
    )
    expect(container.querySelector('.is-amount__value--morphing')).toBeNull()
  })

  it('the rail does not advance on first render', () => {
    const { container } = render(<SettlementProgress current="SETTLED" />)
    expect(container.querySelector('.is-progress--advancing')).toBeNull()
  })

  it('a settled indicator opened later does not replay the confirmation', () => {
    // The one that matters most: a customer reading last week's settlement is
    // reading a record, and § 6 bans motion while a number is being read.
    const { container } = render(<StatusIndicator tone="settled" label="Settled" />)
    expect(container.querySelector('.is-status--confirming')).toBeNull()
  })

  it('a metric does not flash on first paint', () => {
    const { container } = render(
      <MetricTile label="Available to settle" value={money('USDT', 4500000000n)} context="x" />,
    )
    expect(container.querySelector('.is-metric__value--reserved')).toBeNull()
  })
})

describe('§ 6 — each animation fires on its own state change', () => {
  it('the amount morphs when the figure changes', () => {
    const { container, rerender } = render(
      <AmountDisplay amount={money('INR', 500000000n)} morph />,
    )
    rerender(<AmountDisplay amount={money('INR', 750000000n)} morph />)
    expect(container.querySelector('.is-amount__value--morphing')).toBeTruthy()
  })

  it('and not when it re-renders with the same figure', () => {
    const { container, rerender } = render(
      <AmountDisplay amount={money('INR', 500000000n)} morph />,
    )
    rerender(<AmountDisplay amount={money('INR', 500000000n)} morph label="Recipient gets" />)
    expect(container.querySelector('.is-amount__value--morphing')).toBeNull()
  })

  it('and not at all unless the caller asked for it', () => {
    // Opt-in, because most amounts on a page are static facts.
    const { container, rerender } = render(<AmountDisplay amount={money('INR', 500000000n)} />)
    rerender(<AmountDisplay amount={money('INR', 750000000n)} />)
    expect(container.querySelector('.is-amount__value--morphing')).toBeNull()
  })

  it('the rail advances when the step changes', () => {
    const { container, rerender } = render(<SettlementProgress current="READY" />)
    rerender(<SettlementProgress current="SETTLING" />)
    expect(container.querySelector('.is-progress--advancing')).toBeTruthy()
  })

  it('the indicator confirms on arriving at settled, and not on leaving it', () => {
    const { container, rerender } = render(<StatusIndicator tone="settling" label="Settling" />)
    rerender(<StatusIndicator tone="settled" label="Settled" />)
    expect(container.querySelector('.is-status--confirming')).toBeTruthy()

    cleanup()
    const second = render(<StatusIndicator tone="settled" label="Settled" />)
    second.rerender(<StatusIndicator tone="cancelled" label="Cancelled" />)
    expect(second.container.querySelector('.is-status--confirming')).toBeNull()
  })

  it('the availability figure acknowledges a decrease and ignores an increase', () => {
    // "a single restrained confirmation on the Available to settle figure when
    // it **decreases**". An increase is capacity arriving and needs no
    // acknowledgement; a decrease is the customer's own settlement consuming it.
    const { container, rerender } = render(
      <MetricTile label="Available to settle" value={money('USDT', 4500000000n)} context="x" />,
    )
    rerender(
      <MetricTile label="Available to settle" value={money('USDT', 4000000000n)} context="x" />,
    )
    expect(container.querySelector('.is-metric__value--reserved')).toBeTruthy()

    cleanup()
    const up = render(
      <MetricTile label="Available to settle" value={money('USDT', 4000000000n)} context="x" />,
    )
    up.rerender(
      <MetricTile label="Available to settle" value={money('USDT', 9000000000n)} context="x" />,
    )
    expect(up.container.querySelector('.is-metric__value--reserved')).toBeNull()
  })
})

describe('§ 6 — nothing is left in motion', () => {
  it('every animation class is removed within its own duration', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(
        <AmountDisplay amount={money('INR', 500000000n)} morph />,
      )
      rerender(<AmountDisplay amount={money('INR', 750000000n)} morph />)
      expect(container.querySelector('.is-amount__value--morphing')).toBeTruthy()

      // Nothing loops. The class comes off, so a page left open overnight is
      // not a page still animating.
      act(() => { vi.advanceTimersByTime(MAX_DURATION_MS) })
      expect(container.querySelector('.is-amount__value--morphing')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the rail and the indicator stop too', () => {
    vi.useFakeTimers()
    try {
      const rail = render(<SettlementProgress current="READY" />)
      rail.rerender(<SettlementProgress current="SETTLING" />)
      act(() => { vi.advanceTimersByTime(MAX_DURATION_MS) })
      expect(rail.container.querySelector('.is-progress--advancing')).toBeNull()

      const dot = render(<StatusIndicator tone="settling" label="Settling" />)
      dot.rerender(<StatusIndicator tone="settled" label="Settled" />)
      act(() => { vi.advanceTimersByTime(MAX_DURATION_MS) })
      expect(dot.container.querySelector('.is-status--confirming')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('§ 6 — meaning survives without motion', () => {
  it('the new figure is present before any animation runs', () => {
    // The morph decorates a change that has already happened. A morph
    // implemented as "hide, wait, show" would blank the figure, which is the
    // exact failure the section names.
    const { container, rerender } = render(
      <AmountDisplay amount={money('INR', 500000000n)} morph />,
    )
    rerender(<AmountDisplay amount={money('INR', 750000000n)} morph />)
    expect(container.textContent).toContain('75,00,000')
  })

  it('the rail still says where it is, in text, with no animation at all', () => {
    const { container } = render(<SettlementProgress current="SETTLING" />)
    expect(container.textContent).toContain('Settling')
    expect(container.textContent).toContain('(in progress)')
  })

  it('the indicator still says Settled without the teal transition', () => {
    const { container } = render(<StatusIndicator tone="settled" label="Settled" />)
    expect(container.textContent).toContain('Settled')
  })
})

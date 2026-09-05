/**
 * Responsive behaviour — `DESIGN_SYSTEM.md § 8`.
 *
 * Three of the four breakpoints are layout, and `check-styles.mjs` proves the
 * stylesheet uses those widths and no invented ones. The fourth is a product
 * decision, and it is the one that needs behaviour tests:
 *
 *   *"On mobile the product does four things well: see what is moving, see what
 *   needs attention, open a settlement, and authorize one. Creating a batch,
 *   managing API keys and CSV import are desktop tasks and say so plainly rather
 *   than degrading."*
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopTask } from './overview.js'
import {
  BREAKPOINTS, DESKTOP_ONLY_TASKS, MOBILE_CAPABILITIES, isDesktopTaskAvailable,
} from './responsive.js'
import { screensCss } from './screens.css.js'

afterEach(cleanup)

describe('§ 8 — the four breakpoints', () => {
  it('declares the three thresholds the table names', () => {
    expect(BREAKPOINTS).toEqual({ full: 1280, compact: 1024, stacked: 768 })
  })

  it('narrows rather than builds up — desktop-first, as § 8 says', () => {
    // "Desktop-first, because this is an operations tool." Every query is a
    // max-width; a min-width would mean the desktop layout was the special case.
    expect(screensCss).not.toMatch(/@media[^{]*min-width/i)
    expect(screensCss).toMatch(/@media \(max-width: 1279px\)/)
    expect(screensCss).toMatch(/@media \(max-width: 1023px\)/)
    expect(screensCss).toMatch(/@media \(max-width: 767px\)/)
  })

  it('collapses the metric grid rather than squeezing four figures', () => {
    expect(screensCss).toMatch(/max-width: 1279px[\s\S]*?is-overview__metrics/)
    expect(screensCss).toMatch(/max-width: 767px[\s\S]*?is-overview__metrics/)
  })

  it('turns tables into stacked rows at the narrowest width', () => {
    // "tables become stacked rows keyed by amount and beneficiary" — the header
    // row goes away rather than scrolling off the side.
    const narrow = screensCss.slice(screensCss.indexOf('@media (max-width: 767px)'))
    expect(narrow).toMatch(/is-table thead/)
    expect(narrow).toMatch(/is-table__row/)
  })
})

describe('§ 8 — the monitoring experience says so plainly', () => {
  it('names the three tasks § 8 calls desktop', () => {
    expect(Object.keys(DESKTOP_ONLY_TASKS).sort()).toEqual(
      ['api_keys', 'batch_create', 'csv_import'],
    )
  })

  it('keeps the four things the phone does well', () => {
    expect(MOBILE_CAPABILITIES).toHaveLength(4)
    expect(MOBILE_CAPABILITIES).toContain('authorize one')
  })

  it('decides by width, not by sniffing the device', () => {
    // A narrow window on a laptop is the same problem as a phone, and a user
    // agent string is a guess about a person.
    expect(isDesktopTaskAvailable(767)).toBe(false)
    expect(isDesktopTaskAvailable(768)).toBe(true)
    expect(isDesktopTaskAvailable(1440)).toBe(true)
  })

  it('says what the task is, why, and what to do — not "not supported"', () => {
    for (const task of Object.keys(DESKTOP_ONLY_TASKS) as (keyof typeof DESKTOP_ONLY_TASKS)[]) {
      cleanup()
      render(<DesktopTask task={task} />)
      const detail = DESKTOP_ONLY_TASKS[task].detail
      expect(screen.getByText(DESKTOP_ONLY_TASKS[task].title)).toBeTruthy()
      expect(screen.getByText(detail)).toBeTruthy()
      // What to do next, in every one of them.
      expect(detail).toMatch(/Open INRSettle on a computer/)
      // And no apology, no error vocabulary: this is a statement about the
      // device, not a failure.
      expect(detail).not.toMatch(/sorry|unfortunately|error|unsupported|not supported/i)
      expect(detail).not.toMatch(/^\s*$/)
    }
  })

  it('explains why the API-key screen in particular needs a computer', () => {
    render(<DesktopTask task="api_keys" />)
    // The concrete reason, because "desktop only" invites someone to build the
    // degraded version: the secret is shown once, so it needs somewhere it can
    // actually be copied to.
    expect(screen.getByText(/shown once and never again/)).toBeTruthy()
  })

  it('renders as a labelled region rather than an alert', () => {
    const { container } = render(<DesktopTask task="csv_import" />)
    const section = container.querySelector('section')
    expect(section?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('can offer the part of the task that does work here', () => {
    // Reading a batch is one of the four things the phone does well, so the
    // message names what needs a computer and then offers what does not.
    render(<DesktopTask task="batch_create" alternative={<button>See batches</button>} />)
    expect(screen.getByRole('button', { name: 'See batches' })).toBeTruthy()
  })
})

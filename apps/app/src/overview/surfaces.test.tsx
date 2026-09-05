/**
 * Overview — `PRODUCT.md § 12.1`.
 *
 * Most of what this section specifies is *absence*: no fifth metric, no chart,
 * no vanity number, no hero, and no **Available to settle** figure before a
 * facility exists. Absence is the hard thing to test, because a screen that has
 * quietly grown a chart still renders and still passes any assertion about what
 * it does contain. So these tests assert the negative directly, and the view
 * model gives them something to assert against by naming four slots instead of
 * holding a list.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { money } from '@inrsettle/money'
import { Overview } from './surfaces.js'
import { BUSY, BUSY_VIEW, ONBOARDING, ONBOARDING_VIEW, QUIET_VIEW } from './fixtures.js'
import { metricList, metricsSummary, isInFlight, needsAttention, presentOverview } from './view-models.js'

afterEach(cleanup)

const noop = () => {}

function renderOverview(
  presentation = BUSY_VIEW,
  props: Partial<React.ComponentProps<typeof Overview>> = {},
) {
  return render(
    <Overview
      presentation={presentation}
      onOpenSettlement={noop}
      onNewSettlement={noop}
      onNavigate={noop}
      {...props}
    />,
  )
}

describe('§ 12.1 — four questions and nothing else', () => {
  it('answers exactly the four questions, in order', () => {
    renderOverview()
    const group = screen.getByRole('group', { name: 'Workspace summary' })
    const labels = within(group)
      .getAllByRole('article')
      .map((a) => a.getAttribute('aria-label') ?? within(a).getByRole('heading').textContent)
    expect(labels).toEqual([
      'Available to settle', 'In flight', 'Settled today', 'Needs attention',
    ])
  })

  it('has no fifth metric slot to fill', () => {
    // The structural half of the same assertion. A `MetricView[]` would make a
    // fifth metric a one-line change; four named keys make it a decision, which
    // is why Revision 5 of the frozen document could be enforced at all.
    expect(Object.keys(BUSY_VIEW.metrics).sort()).toEqual(
      ['availableToSettle', 'inFlight', 'needsAttention', 'settledToday'],
    )
  })

  it('shows no returning-to-facility metric (Revision 5)', () => {
    renderOverview()
    // Money on its way back reduces Available to settle and explains itself on
    // the affected settlement. It is not a number on this page.
    expect(document.body.textContent).not.toMatch(/returning|coming back|on its way back/i)
  })

  it('renders no chart and no vanity metric', () => {
    const { container } = renderOverview()
    expect(container.querySelector('svg[role="img"], canvas, .is-chart')).toBeNull()
    expect(document.body.textContent).not.toMatch(/vs yesterday|% change|since last week|trend/i)
  })

  it('has no welcome hero — the heading names the page', () => {
    renderOverview()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Overview')
    expect(document.body.textContent).not.toMatch(/welcome back|good morning|hello,/i)
  })
})

describe('§ 12.1 — Available to settle appears only with a facility', () => {
  it('omits the tile entirely during onboarding', () => {
    renderOverview(ONBOARDING_VIEW)
    expect(screen.queryByText('Available to settle')).toBeNull()
    const group = screen.getByRole('group', { name: 'Workspace summary' })
    expect(within(group).getAllByRole('article')).toHaveLength(3)
  })

  it('omits it rather than rendering it as zero', () => {
    // The distinction the whole tile type exists for. "You can settle nothing"
    // is a different and more alarming sentence than "we have not set this up
    // yet", and a zero says the first one.
    //
    // Note what this does *not* assert: that no zero appears on the page.
    // "Settled today ₹0.00" is a correct zero — nothing did settle today — and
    // a test that banned every zero would be banning the truth.
    renderOverview(ONBOARDING_VIEW)
    const group = screen.getByRole('group', { name: 'Workspace summary' })
    const tiles = within(group).getAllByRole('article')
    const available = tiles.find((t) => t.textContent?.includes('Available to settle'))
    expect(available).toBeUndefined()
    expect(ONBOARDING_VIEW.metrics.availableToSettle).toBeNull()
  })

  it('shows it once a facility is enabled', () => {
    renderOverview()
    expect(screen.getByText('Available to settle')).toBeTruthy()
  })

  it('drops the slot from the view model, not just from the markup', () => {
    expect(ONBOARDING_VIEW.metrics.availableToSettle).toBeNull()
    expect(metricList(ONBOARDING_VIEW)).toHaveLength(3)
    expect(metricList(BUSY_VIEW)).toHaveLength(4)
  })

  it('still answers the other three questions with no facility', () => {
    renderOverview(ONBOARDING_VIEW)
    for (const label of ['In flight', 'Settled today', 'Needs attention']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })
})

describe('the metrics do not double-count', () => {
  it('counts SETTLING as in flight and ACTION_REQUIRED as attention, never both', () => {
    expect(isInFlight('SETTLING')).toBe(true)
    expect(isInFlight('ACTION_REQUIRED')).toBe(false)
    expect(needsAttention('ACTION_REQUIRED')).toBe(true)
    expect(needsAttention('SETTLING')).toBe(false)
    // A settlement stopped waiting on the customer is not moving. Counting it
    // in both places makes the page add up to more than the truth.
    for (const s of ['READY', 'SETTLED', 'CANCELLED'] as const) {
      expect(isInFlight(s) && needsAttention(s)).toBe(false)
    }
  })
})

describe('below the metrics: active settlements and open exceptions', () => {
  it('puts what needs attention above what is merely moving', () => {
    const { container } = renderOverview()
    const headings = Array.from(container.querySelectorAll('h2'), (h) => h.textContent)
    expect(headings).toEqual(['Needs your attention', 'Active settlements'])
  })

  it('omits the attention section when nothing needs attention', () => {
    renderOverview(presentOverview({ ...BUSY, needsAttentionCount: 0, openExceptions: [] }))
    expect(screen.queryByText('Needs your attention')).toBeNull()
    expect(screen.getByText('Active settlements')).toBeTruthy()
  })

  it('opens a settlement from its beneficiary name', async () => {
    const onOpenSettlement = vi.fn()
    renderOverview(BUSY_VIEW, { onOpenSettlement })
    await userEvent.click(screen.getByRole('button', { name: 'Aarti Sharma' }))
    expect(onOpenSettlement).toHaveBeenCalledWith('set_aarti')
  })

  it('renders amounts through AmountDisplay, in Indian grouping', () => {
    renderOverview()
    // ₹50,00,000 — not 5,000,000. The grouping is the product's whole claim to
    // being built for India rather than localised into it.
    expect(document.body.textContent).toContain('50,00,000')
  })
})

describe('states', () => {
  it('loading: skeletons, and no figure showing a number it does not have', () => {
    const { container } = renderOverview(BUSY_VIEW, { loading: true })
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('50,00,000')
  })

  it('empty: one sentence and the action that makes it untrue', () => {
    renderOverview(ONBOARDING_VIEW)
    expect(screen.getByText(/Your first settlement will appear here/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'New settlement' }).length).toBeGreaterThan(0)
  })

  it('error: one metric failing does not take the page with it', () => {
    renderOverview(BUSY_VIEW, { errors: { 'Available to settle': 'Could not load. Retrying.' } })
    expect(screen.getByText('Could not load. Retrying.')).toBeTruthy()
    // The rest of the page still answers its questions.
    expect(screen.getByText('In flight')).toBeTruthy()
    expect(screen.getByText('Active settlements')).toBeTruthy()
  })

  it('quiet: a facility with no traffic reads as calm, not as broken', () => {
    renderOverview(QUIET_VIEW)
    expect(screen.getByText('Nothing needs you.')).toBeTruthy()
    expect(screen.getByText(/Nothing settled yet today/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/error|problem|failed/i)
  })
})

describe('copy', () => {
  it('singularises one and pluralises many', () => {
    const one = presentOverview({ ...BUSY, inFlightCount: 1, settledTodayCount: 1, needsAttentionCount: 1 })
    expect(one.metrics.inFlight.context).toContain('Settlement is')
    expect(one.metrics.settledToday.context).toBe('Across 1 settlement.')
    expect(one.metrics.needsAttention.context).toContain('1 settlement is')

    const many = presentOverview({ ...BUSY, inFlightCount: 3, settledTodayCount: 4, needsAttentionCount: 2 })
    expect(many.metrics.inFlight.context).toContain('Settlements are')
    expect(many.metrics.settledToday.context).toBe('Across 4 settlements.')
    expect(many.metrics.needsAttention.context).toContain('2 settlements are')
  })

  it('offers an action only where there is something to act on', () => {
    expect(BUSY_VIEW.metrics.needsAttention.action).toBeDefined()
    expect(BUSY_VIEW.metrics.inFlight.action).toBeUndefined()
    expect(QUIET_VIEW.metrics.needsAttention.action).toBeUndefined()
  })

  it('never names the mechanism the customer does not operate', () => {
    const text = [
      ...metricList(BUSY_VIEW).map((m) => `${m.label} ${m.context}`),
      BUSY_VIEW.emptyMessage ?? '',
      presentOverview(ONBOARDING).emptyMessage ?? '',
    ].join(' ')
    // § 12 forbids the words this feature reaches for most naturally, and
    // check-liquidity-copy.mjs fails the build over them. Asserted here too, so
    // the failure names the screen rather than a file.
    expect(text).not.toMatch(/\bbalance\b|\bwallet\b|\bcredit\b|\blimit\b|\bfacility\b/i)
  })

  it('summarises the figures for a screen reader without inventing one', () => {
    expect(metricsSummary(ONBOARDING_VIEW)).not.toContain('Available to settle')
    expect(metricsSummary(BUSY_VIEW)).toContain('Available to settle')
    expect(metricsSummary(BUSY_VIEW)).toContain('In flight: 2')
  })
})

describe('money stays Money', () => {
  it('carries minor units to the tile rather than a formatted string', () => {
    const view = presentOverview({ ...BUSY, settledToday: money('INR', 1250000000n) })
    const settled = view.metrics.settledToday.value
    expect(typeof settled).toBe('object')
    expect((settled as { minorUnits: bigint }).minorUnits).toBe(1250000000n)
    // INV-01: nothing on the path from the database to the pixel is a number
    // that could have been rounded.
    expect(typeof settled === 'object' && 'minorUnits' in (settled as object)).toBe(true)
  })
})

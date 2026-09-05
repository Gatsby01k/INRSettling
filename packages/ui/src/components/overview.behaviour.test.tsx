/**
 * The two `§ 5` domain components Stage 10 closes.
 *
 * The assertions worth making here are the ones where the component could look
 * right and be wrong: a tile that renders "no facility" as ₹0, and a row that
 * treats a failed *delivery* as a failed *event*.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { money } from '@inrsettle/money'
import { EventRow, MetricTile } from './overview.js'

afterEach(cleanup)

function inTable(row: React.ReactElement) {
  return render(<table><tbody>{row}</tbody></table>)
}

describe('MetricTile — an absent figure is not zero', () => {
  it('renders an em dash, not ₹0, when the workspace has no such figure', () => {
    render(
      <MetricTile
        label="Available to settle"
        value={null}
        context="You can settle once your account is set up for it."
      />,
    )
    // The whole point: a customer without a facility must not be told they have
    // no headroom. "No figure" and "zero" are different answers.
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText(/₹\s*0(\.|$)/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/0\.00/)
  })

  it('renders a real zero as a real zero', () => {
    render(<MetricTile label="Settled today" value={money('INR', 0n)} context="Nothing yet." />)
    expect(document.body.textContent).toMatch(/0/)
    expect(screen.queryByText('—')).toBeNull()
  })

  it('takes Money rather than a formatted string, so INV-01 cannot be broken upstream', () => {
    render(
      <MetricTile
        label="Settled today"
        value={money('INR', 1250000000n)}
        context="Across 4 settlements."
      />,
    )
    // Indian grouping, produced by AmountDisplay from minor units — not by
    // whoever assembled the props.
    expect(document.body.textContent).toContain('1,25,00,000')
  })

  it('shows a skeleton while loading and no figure at all', () => {
    const { container } = render(
      <MetricTile label="In flight" value={3} context="Settling now." loading />,
    )
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByText('3')).toBeNull()
  })

  it('reports a failed load instead of falling back to a stale or zero figure', () => {
    render(
      <MetricTile
        label="Available to settle"
        value={money('INR', 4500000000n)}
        context="Your settlements are unaffected."
        error="Could not load. Retrying."
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Could not load. Retrying.')
    // Even though a value was passed, the error wins. A wrong headroom figure is
    // worse than none.
    expect(document.body.textContent).not.toContain('4,50,00,000')
  })

  it('labels itself for assistive technology and offers an action only when given one', async () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <MetricTile label="Needs attention" value={2} context="Waiting on a document." />,
    )
    expect(screen.getByRole('article', { name: 'Needs attention' })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()

    rerender(
      <MetricTile
        label="Needs attention"
        value={2}
        context="Waiting on a document."
        action={{ label: 'Review', onSelect }}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onSelect).toHaveBeenCalledOnce()
  })
})

describe('EventRow — a delivery failure is not an event failure', () => {
  it('renders a failed delivery as a status on a real row', () => {
    inTable(
      <EventRow
        id="evt_1"
        type="settlement.settled"
        at="2026-03-11T09:42:17Z"
        delivery={{ tone: 'action_required', label: 'Failed — 4 attempts' }}
      />,
    )
    // The event still reads as an event. Only the delivery column says failed —
    // which is the distinction the log exists to make.
    expect(screen.getByText('settlement.settled')).toBeTruthy()
    expect(screen.getByText('Failed — 4 attempts')).toBeTruthy()
    expect(screen.getByRole('row')).toBeTruthy()
  })

  it('carries a text label beside the tone, never colour alone', () => {
    inTable(
      <EventRow
        id="evt_1"
        type="settlement.settled"
        at="2026-03-11T09:42:17Z"
        delivery={{ tone: 'settled', label: 'Delivered' }}
      />,
    )
    expect(screen.getByText('Delivered')).toBeTruthy()
  })

  it('marks an entering row so § 6 can animate it, and marks nothing otherwise', () => {
    const { container, rerender } = inTable(
      <EventRow
        id="evt_1"
        type="settlement.created"
        at="2026-03-11T09:30:55Z"
        delivery={{ tone: 'settled', label: 'Delivered' }}
      />,
    )
    expect(container.querySelector('.is-event--entering')).toBeNull()

    rerender(
      <table><tbody>
        <EventRow
          id="evt_1"
          type="settlement.created"
          at="2026-03-11T09:30:55Z"
          delivery={{ tone: 'settled', label: 'Delivered' }}
          entering
        />
      </tbody></table>,
    )
    expect(container.querySelector('.is-event--entering')).toBeTruthy()
  })

  it('is readable without being a control when it has no onSelect', () => {
    inTable(
      <EventRow
        id="evt_1"
        type="settlement.settled"
        at="2026-03-11T09:42:17Z"
        delivery={{ tone: 'settled', label: 'Delivered' }}
      />,
    )
    expect(screen.getByText('settlement.settled')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('discloses its payload on demand under aria-expanded', async () => {
    const onSelect = vi.fn()
    inTable(
      <EventRow
        id="evt_1"
        type="settlement.settled"
        at="2026-03-11T09:42:17Z"
        delivery={{ tone: 'settled', label: 'Delivered' }}
        onSelect={onSelect}
        expanded={false}
      >
        <pre>{'{"id":"evt_1"}'}</pre>
      </EventRow>,
    )
    const trigger = screen.getByRole('button', { name: 'settlement.settled' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('{"id":"evt_1"}')).toBeNull()

    await userEvent.click(trigger)
    expect(onSelect).toHaveBeenCalledWith('evt_1')
  })

  it('renders the payload row only when expanded', () => {
    inTable(
      <EventRow
        id="evt_1"
        type="settlement.settled"
        at="2026-03-11T09:42:17Z"
        delivery={{ tone: 'settled', label: 'Delivered' }}
        onSelect={() => {}}
        expanded
      >
        <pre>{'{"id":"evt_1"}'}</pre>
      </EventRow>,
    )
    expect(screen.getByText('{"id":"evt_1"}')).toBeTruthy()
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })
})

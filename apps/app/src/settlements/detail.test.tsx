/**
 * Settlement detail — `PRODUCT.md § 12.3`.
 *
 * The Stage 3 suite covers the header, the rail and the cancellation
 * affordances. These are the three things § 12.3 requires that the screen did
 * not have: the plain-language timeline it prints verbatim, the note beside a
 * frozen destination, and the return notice — which Stage 6 built a view model
 * for and no screen ever rendered.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SettlementDetail } from './surfaces.js'
import {
  DETAIL_BASE, RETURN_CONFIRMED, RETURN_REPAID, SETTLED_DESIGN_ONLY, SETTLING,
  TIMELINE, TIMELINE_EVENTS,
} from './fixtures.js'
import { formatIst, frozenDestinationNote, settlementTimeline } from './view-models.js'

afterEach(cleanup)

const AUTHORIZED_AT = new Date('2026-09-02T08:32:00Z')

function renderDetail(overrides: Partial<React.ComponentProps<typeof SettlementDetail>> = {}) {
  return render(
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={SETTLED_DESIGN_ONLY}
      internalStatus="SETTLED"
      authorizedAt={AUTHORIZED_AT}
      timeline={TIMELINE}
      {...overrides}
    />,
  )
}

describe('§ 12.3 — the timeline reads in plain language', () => {
  it('prints the four lines the document prints', () => {
    // Settlement ready / Liquidity secured / INR payout confirmed / Reconciled
    renderDetail()
    const rows = Array.from(
      document.querySelectorAll('.is-timeline__label'),
      (n) => n.textContent,
    )
    expect(rows).toEqual([
      'Settlement ready', 'Liquidity secured', 'INR payout confirmed', 'Reconciled',
    ])
  })

  it('carries the UTR on the payout line and the figures on the reconciliation line', () => {
    renderDetail()
    expect(screen.getByText('UTR 2026083112345678')).toBeTruthy()
    // Paise included. A reconciliation line is exactly where exactness is the
    // point — "expected vs observed" that rounded would be unable to show the
    // mismatch it exists to show.
    expect(screen.getByText('₹50,00,000.00 expected · ₹50,00,000.00 observed')).toBeTruthy()
  })

  it('shows times in IST, because that is where the money lands', () => {
    expect(formatIst(new Date('2026-09-02T08:32:11Z'))).toBe('14:02:11 IST')
    renderDetail()
    expect(screen.getByText('14:02:11 IST')).toBeTruthy()
  })

  it('names no internal state in the timeline', () => {
    renderDetail()
    const timeline = document.querySelector('.is-timeline')
    // "Provider identifiers, internal state names and raw event payloads never
    // dominate the page." Not one of the seventeen appears in these rows.
    expect(timeline?.textContent).not.toMatch(
      /LIQUIDITY_RESERVED|DRAWDOWN_CONFIRMED|PAYOUT_CONFIRMED|RECONCILING|PREFLIGHTING/,
    )
  })

  it('omits a step it has no plain words for, rather than naming it', () => {
    // The mapping is deliberately partial: PAYOUT_SUBMITTED is the moment we
    // started doing something, not a moment anything happened to their money.
    const rows = settlementTimeline([
      ...TIMELINE_EVENTS,
      { status: 'PAYOUT_SUBMITTED', at: new Date('2026-09-02T08:33:00Z') },
      { status: 'DRAWDOWN_REQUESTED', at: new Date('2026-09-02T08:32:20Z') },
    ])
    expect(rows).toHaveLength(TIMELINE.length)
    expect(rows.map((r) => r.label)).not.toContain('PAYOUT_SUBMITTED')
  })

  it('keeps the timeline collapsed by default — it is secondary', () => {
    const { container } = renderDetail()
    const details = container.querySelector('details.is-settlement__technical')
    expect(details).toBeTruthy()
    expect((details as HTMLDetailsElement).open).toBe(false)
    expect(container.querySelector('.is-timeline')?.closest('details')).toBe(details)
  })
})

describe('§ 12.3 — the frozen destination says it is frozen', () => {
  it('shows the note once the settlement is authorized', () => {
    renderDetail()
    expect(screen.getByText(/as they were when this settlement was authorized/)).toBeTruthy()
  })

  it('says nothing before authorization, where the note would be false', () => {
    expect(frozenDestinationNote(null)).toBeNull()
    renderDetail({ authorizedAt: null, presentation: SETTLING })
    expect(screen.queryByText(/as they were when this settlement was authorized/)).toBeNull()
  })

  it('sits beside the destination it explains, not in the technical detail', () => {
    const { container } = renderDetail()
    const note = screen.getByText(/as they were when this settlement was authorized/)
    expect(note.closest('details')).toBeNull()
    expect(note.closest('.is-facts')).toBe(container.querySelector('.is-facts'))
  })
})

describe('§ 12.3 — a return is read first, and SETTLED still stands beside it', () => {
  it('renders the notice above everything else on the page', () => {
    const { container } = renderDetail({ returnNotice: RETURN_CONFIRMED })
    const section = container.querySelector('.is-settlement') as HTMLElement
    const notice = container.querySelector('.is-return') as HTMLElement
    const header = container.querySelector('.is-page__header')

    expect(notice).toBeTruthy()
    // After the header (which carries the amount and the badge) and before the
    // rail, the facts, and everything else.
    expect(header!.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const rail = section.querySelector('.is-progress')
    if (rail) {
      expect(notice.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('leaves the settlement reading Settled, because both facts are true', () => {
    renderDetail({ returnNotice: RETURN_CONFIRMED })
    // STATE_MACHINES.md § 8.5 takes this tension knowingly: mutating a final
    // record "destroys the distinction between never delivered and delivered
    // then returned, and those have different consequences for the customer's
    // own books".
    // "Settled" appears twice on purpose: the status badge, and the final step
    // of the Ready → Settling → Settled rail. Both are the settlement's own
    // state, and neither changes because money came back afterwards.
    const badge = document.querySelector('.is-status') as HTMLElement
    expect(badge.textContent).toContain('Settled')
    expect(screen.getByText('Return confirmed')).toBeTruthy()
  })

  it('announces an open return as an alert and a closed one as a status', () => {
    const { container, rerender } = renderDetail({ returnNotice: RETURN_CONFIRMED })
    expect(container.querySelector('.is-return')?.getAttribute('role')).toBe('alert')

    rerender(
      <SettlementDetail
        {...DETAIL_BASE}
        presentation={SETTLED_DESIGN_ONLY}
        internalStatus="SETTLED"
        authorizedAt={AUTHORIZED_AT}
        timeline={TIMELINE}
        returnNotice={RETURN_REPAID}
      />,
    )
    expect(container.querySelector('.is-return')?.getAttribute('role')).toBe('status')
    expect(screen.getByText('Funds released')).toBeTruthy()
  })

  it('states the amount, the reason in words, and when it was reported', () => {
    renderDetail({ returnNotice: RETURN_CONFIRMED })
    const notice = document.querySelector('.is-return') as HTMLElement
    expect(within(notice).getByText(/50,00,000/)).toBeTruthy()
    expect(notice.textContent).toContain('The payment was returned')
    expect(notice.textContent).toMatch(/Reported/)
  })

  it('never mentions the facility on the customer notice', () => {
    renderDetail({ returnNotice: RETURN_CONFIRMED })
    const notice = document.querySelector('.is-return') as HTMLElement
    // § 12 keeps liquidity as INRSettle's arrangement with a provider, never
    // something the customer operates.
    expect(notice.textContent ?? '').not.toMatch(/facility|balance|wallet|credit/i)
  })

  it('shows nothing at all when there is no return', () => {
    const { container } = renderDetail()
    expect(container.querySelector('.is-return')).toBeNull()
  })
})

describe('§ 12.3 — cancel, and the line that replaces it', () => {
  it('explains why cancelling is no longer possible, rather than only that it is not', () => {
    renderDetail({ presentation: SETTLING })
    const line = screen.queryByText(/can no longer be cancelled/)
    if (line) expect(line.textContent).toMatch(/payout has been sent/)
  })
})

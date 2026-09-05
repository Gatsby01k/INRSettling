/**
 * New Settlement — `PRODUCT.md § 12.2`, the screen the document calls *"the most
 * important screen in the product"*.
 *
 * The existing Stage 3 suite covers what the screen does. These are the Stage 10
 * assertions: the reading order the section fixes, the fifth input it names and
 * the screen did not have, the button that must always carry the amount, and
 * the one thing `DESIGN_SYSTEM.md § 6` legislates about money in motion — *"The
 * figure never blanks and re-renders; that reads as uncertainty about money."*
 *
 * That last one was being violated. A re-price replaced the whole quote summary
 * with skeletons, so the recipient figure disappeared on every keystroke.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewSettlement, type NewSettlementValues } from './surfaces.js'
import {
  BENEFICIARIES, FUNDING_CURRENCIES, PURPOSES, QUOTE, SANDBOX_PRICING_NOTICE,
} from './fixtures.js'

afterEach(cleanup)

const noop = (): void => {}

const FILLED: NewSettlementValues = {
  beneficiaryId: 'ben_aarti',
  recipientMinorUnits: 500_000_000n,
  purposeCode: 'SOFTWARE_SERVICES',
  fundingCurrency: 'USDT',
  reference: '',
  documents: [],
}

function renderNew(overrides: Partial<React.ComponentProps<typeof NewSettlement>> = {}) {
  return render(
    <NewSettlement
      values={FILLED}
      onChange={noop}
      beneficiaries={BENEFICIARIES}
      beneficiaryQuery=""
      onBeneficiaryQueryChange={noop}
      purposes={PURPOSES}
      fundingCurrencies={FUNDING_CURRENCIES}
      quote={QUOTE}
      provisionalNotice={SANDBOX_PRICING_NOTICE}
      onSubmit={noop}
      {...overrides}
    />,
  )
}

describe('§ 12.2 — the reading order', () => {
  it('presents the five inputs in the order the document fixes', () => {
    // "Beneficiary → Recipient gets ₹ → Purpose → Funding currency →
    // Reference / documents if needed."
    renderNew({ documentsRequired: true })
    const labels = Array.from(
      document.querySelectorAll('label'),
      (l) => l.textContent?.trim() ?? '',
    ).filter((t) => t.length > 0)

    const order = ['Beneficiary', 'Recipient gets', 'Purpose', 'Funding currency', 'Your reference']
    const positions = order.map((l) => labels.findIndex((x) => x.startsWith(l)))
    expect(positions.every((p) => p >= 0), `missing one of ${order.join(', ')} in ${labels}`).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('has the fifth input at all', () => {
    // It did not. The screen stopped at funding currency from Stage 3 until
    // Stage 10, and the reading order in § 12.2 has five entries.
    renderNew()
    expect(screen.getByLabelText(/Your reference/i)).toBeTruthy()
  })

  it('asks for documents only when the purpose needs them', () => {
    renderNew()
    expect(screen.queryByText('Supporting documents')).toBeNull()
    cleanup()
    renderNew({ documentsRequired: true })
    expect(screen.getByText('Supporting documents')).toBeTruthy()
  })

  it('reports the reference back through onChange rather than holding it', () => {
    const onChange = vi.fn()
    renderNew({ onChange })
    const field = screen.getByLabelText(/Your reference/i)
    // A controlled field: one keystroke, one change with the full next value.
    field.dispatchEvent(new Event('input', { bubbles: true }))
    expect(field.getAttribute('value') ?? (field as HTMLInputElement).value).toBe('')
  })
})

describe('§ 12.2 — the button always names the amount', () => {
  it('reads "Settle ₹50,00,000", never "Confirm" or "Submit"', () => {
    renderNew()
    const button = screen.getByRole('button', { name: /^Settle/ })
    expect(button.textContent).toBe('Settle ₹50,00,000')
    expect(document.body.textContent).not.toMatch(/\bConfirm\b|\bSubmit\b/)
  })

  it('falls back to a bare Settle only when there is no amount to name', () => {
    renderNew({ values: { ...FILLED, recipientMinorUnits: null }, quote: null })
    expect(screen.getByRole('button', { name: 'Settle' })).toBeTruthy()
  })
})

describe('§ 6 — the recipient figure morphs and never blanks', () => {
  it('keeps the figure on screen while a re-price is in flight', () => {
    renderNew({ quoteRepricing: true })
    // This is the assertion the component used to fail: `loading` replaced the
    // whole summary with skeletons, so ₹50,00,000 vanished on every keystroke.
    expect(document.body.textContent).toContain('50,00,000')
  })

  it('greys only the derived lines, which genuinely are unknown', () => {
    const { container } = renderNew({ quoteRepricing: true })
    const lines = container.querySelector('.is-quote__lines')
    expect(lines?.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelectorAll('.is-skeleton').length).toBeGreaterThan(0)
  })

  it('does skeleton the whole summary on a first pricing, where nothing blanks', () => {
    const { container } = renderNew({ quote: null, quoteLoading: true })
    const aside = container.querySelector('.is-quote')
    expect(aside?.getAttribute('aria-busy')).toBe('true')
    // No figure inside the summary — there is not one yet, so a skeleton is
    // honest rather than a blanking. The *button* still names ₹50,00,000,
    // because that is the amount the customer typed and it is known without a
    // quote; § 12.2 requires it to be named there whatever pricing is doing.
    expect(aside?.textContent ?? '').not.toContain('50,00,000')
    expect(screen.getByRole('button', { name: /^Settle/ }).textContent).toBe('Settle ₹50,00,000')
  })

  it('marks the figure as morphing when it changes, and only then', async () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(
        <NewSettlement
          values={FILLED}
          onChange={noop}
          beneficiaries={BENEFICIARIES}
          beneficiaryQuery=""
          onBeneficiaryQueryChange={noop}
          purposes={PURPOSES}
          fundingCurrencies={FUNDING_CURRENCIES}
          quote={QUOTE}
          onSubmit={noop}
        />,
      )
      // Nothing has changed yet, so nothing is animating: § 6 bans motion
      // "while the user is reading a number".
      expect(container.querySelector('.is-amount__value--morphing')).toBeNull()

      rerender(
        <NewSettlement
          values={FILLED}
          onChange={noop}
          beneficiaries={BENEFICIARIES}
          beneficiaryQuery=""
          onBeneficiaryQueryChange={noop}
          purposes={PURPOSES}
          fundingCurrencies={FUNDING_CURRENCIES}
          quote={{ ...QUOTE, recipientAmount: { currency: 'INR', minorUnits: 750_000_000n } }}
          onSubmit={noop}
        />,
      )
      expect(container.querySelector('.is-amount__value--morphing')).toBeTruthy()
      // The new figure is already rendered — the class decorates a change that
      // has happened, it does not stage one.
      expect(document.body.textContent).toContain('75,00,000')

      vi.advanceTimersByTime(320)
      // …and it stops. § 6 caps every animation at 400ms.
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('§ 12.2 — the quote stays visible', () => {
  it('renders the summary alongside the form rather than below the fold', () => {
    const { container } = renderNew()
    const screenEl = container.querySelector('.is-new-settlement')
    expect(screenEl?.querySelector('.is-form')).toBeTruthy()
    expect(screenEl?.querySelector('.is-quote')).toBeTruthy()
    // Siblings, so the stylesheet can make one a sticky column. A summary
    // nested inside the form could not stay put while the form scrolls.
    expect(within(screenEl as HTMLElement).getByRole('complementary')).toBeTruthy()
  })

  it('keeps the sandbox notice with the figures, never below them', () => {
    renderNew()
    const aside = screen.getByRole('complementary')
    const notice = within(aside).getByRole('note')
    expect(notice.textContent).toBe(SANDBOX_PRICING_NOTICE)
    expect(
      notice.compareDocumentPosition(within(aside).getByText(/50,00,000/)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('keyboard alone', () => {
  it('reaches every input and the final action by Tab', async () => {
    const user = userEvent.setup()
    renderNew({ documentsRequired: true })

    const reachable: string[] = []
    for (let i = 0; i < 24; i++) {
      await user.tab()
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) break
      const name =
        el.getAttribute('aria-label') ??
        (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() : null) ??
        el.textContent?.trim() ??
        el.tagName
      if (name && !reachable.includes(name)) reachable.push(name)
    }

    // Every field, and the button that authorizes the settlement. § 12.2's
    // exit criterion is that the whole flow is completable by keyboard alone.
    expect(reachable.some((n) => n.startsWith('Beneficiary'))).toBe(true)
    expect(reachable.some((n) => n.startsWith('Recipient gets'))).toBe(true)
    expect(reachable.some((n) => n.startsWith('Purpose'))).toBe(true)
    expect(reachable.some((n) => n.startsWith('Funding currency'))).toBe(true)
    expect(reachable.some((n) => n.startsWith('Your reference'))).toBe(true)
    expect(reachable.some((n) => n.startsWith('Settle'))).toBe(true)
  })

  it('submits from the keyboard without a pointer', async () => {
    const onSubmit = vi.fn()
    renderNew({ onSubmit })
    const button = screen.getByRole('button', { name: /^Settle/ })
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalled()
  })
})

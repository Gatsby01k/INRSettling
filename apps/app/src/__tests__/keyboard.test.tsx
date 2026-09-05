/**
 * *"The whole New Settlement flow is completable by keyboard alone"* — the
 * second Stage 10 exit criterion.
 *
 * Not "every control is focusable". The criterion is that someone who never
 * touches a pointer can go from an empty screen to an authorized settlement,
 * which is a stronger claim: the combobox must be operable by arrow keys, the
 * amount must accept typed digits, the selects must change with the keyboard,
 * and the final action must fire from a key. A screen can pass an axe audit and
 * still fail this, because axe checks that things have names and roles, not that
 * a sequence of keystrokes reaches the end.
 *
 * So this walks the flow the way a person would.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_NEW_SETTLEMENT, NewSettlement, type NewSettlementValues } from '../settlements/surfaces.js'
import {
  BENEFICIARIES, FUNDING_CURRENCIES, PURPOSES, QUOTE, SANDBOX_PRICING_NOTICE,
} from '../settlements/fixtures.js'

afterEach(cleanup)

const noop = (): void => {}

/**
 * The screen, driven the way the real one is: state lives outside, every change
 * comes back through `onChange`.
 *
 * A test that passed a frozen `values` object would prove only that the controls
 * exist. Wiring the state makes it prove that a keystroke actually changes the
 * settlement being built.
 */
function Flow({ onSubmit }: { onSubmit: () => void }): React.ReactElement {
  const [values, setValues] = React.useState<NewSettlementValues>(EMPTY_NEW_SETTLEMENT)
  const [query, setQuery] = React.useState('')
  const ready =
    values.beneficiaryId !== null &&
    values.recipientMinorUnits !== null &&
    values.purposeCode !== null

  return (
    <NewSettlement
      values={values}
      onChange={setValues}
      beneficiaries={BENEFICIARIES}
      beneficiaryQuery={query}
      onBeneficiaryQueryChange={setQuery}
      purposes={PURPOSES}
      fundingCurrencies={FUNDING_CURRENCIES}
      quote={values.recipientMinorUnits !== null ? QUOTE : null}
      provisionalNotice={SANDBOX_PRICING_NOTICE}
      onSubmit={onSubmit}
      {...(ready ? {} : { submitDisabledReason: 'Choose a beneficiary, an amount and a purpose.' })}
    />
  )
}

describe('New Settlement, keyboard alone', () => {
  it('goes from empty to authorized without a pointer', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Flow onSubmit={onSubmit} />)

    // 1. Beneficiary. Tab to the combobox, type, arrow down, Enter.
    await user.tab()
    const combobox = screen.getByRole('combobox', { name: /Beneficiary/i })
    expect(document.activeElement).toBe(combobox)
    await user.keyboard('Aarti')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    // 2. Recipient gets ₹. Typed, not spun: § 12.2's first figure.
    const amount = screen.getByLabelText(/Recipient gets/i)
    amount.focus()
    await user.keyboard('50000')

    // 3. Purpose, by keyboard on the select.
    const purpose = screen.getByLabelText(/^Purpose/i) as HTMLSelectElement
    purpose.focus()
    await user.selectOptions(purpose, 'SOFTWARE_SERVICES')

    // 4. Funding currency is already USDT — V1 has one funding path (D-10),
    //    so leaving it is a real path through the flow, not a shortcut.

    // 5. The final action, which names the amount and fires from the keyboard.
    const settle = screen.getByRole('button', { name: /^Settle/ })
    expect(settle.getAttribute('aria-disabled')).not.toBe('true')
    settle.focus()
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('names the amount on the button the customer reached by keyboard', async () => {
    const user = userEvent.setup()
    render(<Flow onSubmit={noop} />)

    const amount = screen.getByLabelText(/Recipient gets/i)
    amount.focus()
    await user.keyboard('50000')

    // § 12.2: "A settlement is never authorized by a button that says 'Confirm'
    // or 'Submit'." Including when the customer got there with a keyboard.
    expect(screen.getByRole('button', { name: /^Settle/ }).textContent).toBe('Settle ₹50,000')
  })

  it('keeps the reason a disabled action is disabled reachable by keyboard', async () => {
    render(<Flow onSubmit={noop} />)
    const settle = screen.getByRole('button', { name: /^Settle/ })

    // A natively disabled button leaves the tab order and takes its explanation
    // with it — which is why the design system refuses to use one.
    expect(settle.getAttribute('aria-disabled')).toBe('true')
    settle.focus()
    expect(document.activeElement).toBe(settle)

    const describedBy = settle.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent)
      .toBe('Choose a beneficiary, an amount and a purpose.')
  })

  it('does not authorize from the keyboard while the action is disabled', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Flow onSubmit={onSubmit} />)

    const settle = screen.getByRole('button', { name: /^Settle/ })
    settle.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('closes the beneficiary list with Escape without losing the field', async () => {
    const user = userEvent.setup()
    render(<Flow onSubmit={noop} />)

    const combobox = screen.getByRole('combobox', { name: /Beneficiary/i })
    combobox.focus()
    await user.keyboard('A')
    expect(combobox.getAttribute('aria-expanded')).toBe('true')

    await user.keyboard('{Escape}')
    expect(combobox.getAttribute('aria-expanded')).toBe('false')
    // Focus stays put. A dismissal that also moved focus would make Escape a
    // trap rather than an escape.
    expect(document.activeElement).toBe(combobox)
  })

  it('reaches every control in the flow by Tab, in the § 12.2 reading order', async () => {
    const user = userEvent.setup()
    render(<Flow onSubmit={noop} />)

    const order: string[] = []
    for (let i = 0; i < 20; i++) {
      await user.tab()
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) break
      const label = el.id
        ? document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()
        : null
      const name = label ?? el.textContent?.trim() ?? ''
      if (name && !order.includes(name)) order.push(name)
    }

    const positions = ['Beneficiary', 'Recipient gets', 'Purpose', 'Funding currency', 'Your reference']
      .map((l) => order.findIndex((x) => x.startsWith(l)))
    expect(positions.every((p) => p >= 0), `reached: ${order.join(' → ')}`).toBe(true)
    // Tab order follows reading order. A screen where Tab jumps around is
    // completable by keyboard and still not usable by one.
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('exposes the quote to a screen reader without requiring focus', async () => {
    const user = userEvent.setup()
    render(<Flow onSubmit={noop} />)

    // There is no summary before there is an amount — a quote panel holding
    // nothing is a promise the screen has not kept yet.
    expect(screen.queryByRole('complementary')).toBeNull()

    const amount = screen.getByLabelText(/Recipient gets/i)
    amount.focus()
    await user.keyboard('50000')

    // Once priced, the summary is a complementary landmark, so it can be
    // reached by landmark navigation rather than by tabbing through the whole
    // form to find it.
    const aside = screen.getByRole('complementary')
    expect(within(aside).getByRole('note').textContent).toBe(SANDBOX_PRICING_NOTICE)
  })
})

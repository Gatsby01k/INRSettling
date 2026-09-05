/**
 * Behaviour of the Stage 2 domain components.
 *
 * The load-bearing assertions here are the product rules, not the markup: a
 * requirement always shows its action, and no component can be handed a full
 * account number to display.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BeneficiaryPicker, RequirementCard, StatusIndicator } from './beneficiary.js'

afterEach(cleanup)

describe('RequirementCard', () => {
  const base = {
    code: 'beneficiary_account_unverified',
    title: 'Beneficiary payout details need verification',
    detail: 'We confirm that HDFC •••• 6789 accepts payments and matches the beneficiary name.',
  }

  it('renders the title, the detail and exactly one action', async () => {
    const onAction = vi.fn()
    render(<RequirementCard {...base} action={{ label: 'Verify now', onAction }} />)

    expect(screen.getByRole('heading', { name: base.title })).toBeTruthy()
    expect(screen.getByText(base.detail)).toBeTruthy()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)

    await userEvent.click(buttons[0]!)
    expect(onAction).toHaveBeenCalledOnce()
  })

  it('is labelled by its own title, so a list of cards is navigable', () => {
    render(<RequirementCard {...base} action={{ label: 'Verify now', onAction: () => {} }} />)
    const article = screen.getByRole('article')
    const labelledBy = article.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe(base.title)
  })

  it('does not fire the action while busy', async () => {
    const onAction = vi.fn()
    render(<RequirementCard {...base} busy action={{ label: 'Verifying', onAction }} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('gives a keyboard user the reason its action is unavailable', async () => {
    render(
      <RequirementCard
        {...base}
        action={{ label: 'Talk to us about going live', onAction: () => {} }}
        actionDisabledReason="Only a workspace admin can request this."
      />,
    )
    const button = screen.getByRole('button', { name: 'Talk to us about going live' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/workspace admin/)
    // Still reachable, so the reason is actually readable.
    await userEvent.tab()
    expect(document.activeElement).toBe(button)
  })

  it('carries its machine code without showing it', () => {
    render(<RequirementCard {...base} action={{ label: 'Verify now', onAction: () => {} }} />)
    const article = screen.getByRole('article')
    expect(article.getAttribute('data-requirement-code')).toBe(base.code)
    expect(article.textContent).not.toContain(base.code)
  })
})

describe('StatusIndicator', () => {
  it('never encodes status in colour alone', () => {
    render(<StatusIndicator tone="settled" label="Verified" detail="checked 12 Aug" />)
    expect(screen.getByText('Verified')).toBeTruthy()
    expect(screen.getByText('checked 12 Aug')).toBeTruthy()
  })

  it('hides the dot from assistive technology', () => {
    const { container } = render(<StatusIndicator tone="action_required" label="Could not verify" />)
    const dot = container.querySelector('.is-status__dot')
    expect(dot?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('BeneficiaryPicker', () => {
  const options = [
    {
      id: 'ben_1',
      displayName: 'Aarti Sharma',
      destinationSummary: 'HDFC •••• 6789',
      verification: { tone: 'settled' as const, label: 'Verified' },
    },
    {
      id: 'ben_2',
      displayName: 'Ravi Menon',
      destinationSummary: null,
      verification: { tone: 'ready' as const, label: 'Not verified yet' },
    },
  ]

  it('shows the masked destination and verification state inline', async () => {
    render(<BeneficiaryPicker label="Beneficiary" options={options} onChange={() => {}} />)
    await userEvent.click(screen.getByRole('combobox'))
    expect(screen.getByText('HDFC •••• 6789')).toBeTruthy()
    expect(screen.getByText('Verified')).toBeTruthy()
    // A beneficiary with no destination says so rather than showing a blank.
    expect(screen.getByText('No payout destination yet')).toBeTruthy()
  })

  it('selects with the keyboard', async () => {
    const onChange = vi.fn()
    render(<BeneficiaryPicker label="Beneficiary" options={options} onChange={onChange} />)
    const input = screen.getByRole('combobox')
    await userEvent.click(input)
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('ben_2')
  })

  it('points at the active option for a screen reader', async () => {
    render(<BeneficiaryPicker label="Beneficiary" options={options} onChange={() => {}} />)
    const input = screen.getByRole('combobox')
    await userEvent.click(input)
    expect(input.getAttribute('aria-activedescendant')).toMatch(/ben_1$/)
    await userEvent.keyboard('{ArrowDown}')
    expect(input.getAttribute('aria-activedescendant')).toMatch(/ben_2$/)
  })

  it('says what to do when nothing matches, rather than showing an empty box', async () => {
    render(<BeneficiaryPicker label="Beneficiary" options={[]} query="zzz" onChange={() => {}} />)
    await userEvent.click(screen.getByRole('combobox'))
    expect(screen.getByText(/Create one to continue/)).toBeTruthy()
  })

  it('closes on Escape', async () => {
    render(<BeneficiaryPicker label="Beneficiary" options={options} onChange={() => {}} />)
    const input = screen.getByRole('combobox')
    await userEvent.click(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    await userEvent.keyboard('{Escape}')
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not open or change when disabled, and explains why', async () => {
    const onChange = vi.fn()
    render(
      <BeneficiaryPicker
        label="Beneficiary"
        options={options}
        onChange={onChange}
        disabled
        disabledReason="Choose a funding currency first."
      />,
    )
    const input = screen.getByRole('combobox')
    expect(input.getAttribute('aria-disabled')).toBe('true')
    const describedBy = input.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/funding currency/)
    await userEvent.click(input)
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onChange).not.toHaveBeenCalled()
  })
})

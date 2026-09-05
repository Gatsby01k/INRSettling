/**
 * Behaviour, not story existence.
 *
 * A published story proves a component renders. It does not prove that
 * `loading` loads, that a disabled reason reaches a keyboard user, or that a
 * modal closes. These are the assertions that do.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, IconButton, Modal, Select } from './index.js'

afterEach(cleanup)

describe('Button — disabled reasons reach a keyboard user', () => {
  it('keeps a disabled-with-reason button focusable and describes it', async () => {
    render(<Button disabled disabledReason="Add a beneficiary before settling">Settle</Button>)
    const btn = screen.getByRole('button', { name: 'Settle' })

    // Not natively disabled — a native disabled button leaves the tab order and
    // takes its explanation with it.
    expect(btn).not.toHaveProperty('disabled', true)
    expect(btn.getAttribute('aria-disabled')).toBe('true')

    const describedBy = btn.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent)
      .toBe('Add a beneficiary before settling')

    btn.focus()
    expect(document.activeElement).toBe(btn)
  })

  it('does not fire onClick while disabled, by pointer or by keyboard', async () => {
    const onClick = vi.fn()
    render(<Button disabled disabledReason="Not yet" onClick={onClick}>Settle</Button>)
    const btn = screen.getByRole('button', { name: 'Settle' })

    await userEvent.click(btn)
    btn.focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('fires onClick when enabled', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Settle</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Settle' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('marks a loading button busy and inert', async () => {
    const onClick = vi.fn()
    render(<Button loading onClick={onClick}>Settling</Button>)
    const btn = screen.getByRole('button', { name: /Settling/ })
    expect(btn.getAttribute('aria-busy')).toBe('true')
    await userEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('IconButton — loading actually loads', () => {
  it('does not forward `loading` to the DOM as an attribute', () => {
    const { container } = render(<IconButton label="Copy" loading>⧉</IconButton>)
    const btn = container.querySelector('button')!
    expect(btn.getAttribute('loading')).toBeNull()
    expect(btn.hasAttribute('loading')).toBe(false)
  })

  it('renders the loading affordance and blocks activation', async () => {
    const onClick = vi.fn()
    const { container } = render(
      <IconButton label="Copy reference" loading onClick={onClick}>⧉</IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Copy reference' })
    expect(btn.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('.is-spinner')).not.toBeNull()
    await userEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps its accessible name and hides the glyph from assistive tech', () => {
    const { container } = render(<IconButton label="Copy reference">⧉</IconButton>)
    expect(screen.getByRole('button', { name: 'Copy reference' })).toBeTruthy()
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('⧉')
  })

  it('carries a keyboard-reachable disabled reason too', () => {
    render(<IconButton label="Copy" disabled disabledReason="Nothing to copy yet">⧉</IconButton>)
    const btn = screen.getByRole('button', { name: 'Copy' })
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    const id = btn.getAttribute('aria-describedby')!
    expect(document.getElementById(id)?.textContent).toBe('Nothing to copy yet')
  })
})

describe('Modal — onClose works and focus behaves', () => {
  const Harness = ({ onClose }: { onClose: () => void }) => (
    <Modal open title="Turn off separation of duties?" onClose={onClose}
      actions={<><Button variant="secondary">Keep it on</Button><Button variant="destructive">Turn it off</Button></>}>
      One person will be able to create and approve settlements in live.
    </Modal>
  )

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('calls onClose when the scrim is clicked, but not the panel', async () => {
    const onClose = vi.fn()
    const { container } = render(<Harness onClose={onClose} />)
    fireEvent.mouseDown(container.querySelector('.is-modal')!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(container.querySelector('.is-modal__scrim')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the dialog on open', async () => {
    render(<Harness onClose={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Keep it on' })).toBe(document.activeElement))
  })

  it('is announced as a modal dialog with a name', () => {
    render(<Harness onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Turn off separation of duties?')
  })

  it('wraps Tab from the last control back to the first', async () => {
    render(<Harness onClose={vi.fn()} />)
    const first = screen.getByRole('button', { name: 'Keep it on' })
    const last = screen.getByRole('button', { name: 'Turn it off' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    await waitFor(() => expect(document.activeElement).toBe(first))
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal open={false} title="x" onClose={vi.fn()}>body</Modal>,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('Select — the empty state is a real state', () => {
  it('disables itself and says what is missing when there is nothing to choose', () => {
    render(<Select id="f" label="Funding currency" options={[]}
      emptyLabel="No funding currencies enabled yet" />)
    const select = screen.getByLabelText('Funding currency') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(select.textContent).toContain('No funding currencies enabled yet')
  })

  it('associates its error message with the control', () => {
    render(<Select id="g" label="Funding currency" options={[{ value: 'a', label: 'A' }]}
      error="Choose a funding currency." />)
    const select = screen.getByLabelText('Funding currency')
    expect(select.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('Choose a funding currency.')
  })
})

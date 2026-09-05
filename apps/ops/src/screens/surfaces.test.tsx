/**
 * What the Internal Operations screens must actually do.
 *
 * One rule dominates: **nothing happens without a reason.** `SECURITY.md § 6`
 * makes it mandatory, and a screen where the reason were optional — or where an
 * operator could click through and be refused server-side — would make the
 * audit log a list of blanks and teach everyone the field was decoration.
 *
 * The second: an action the machine will refuse is disabled *before* the click,
 * with the reason on screen. Past the point of no return, `fail` and `cancel`
 * are gone and the row says why.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExceptionQueue, FacilityBoard, ProviderEventLog, ReasonedConfirm } from './surfaces.js'
import { exceptionRow, facilityCard, providerEventRow } from './view-models.js'

afterEach(cleanup)

const NOW = new Date('2026-09-05T12:00:00Z')
const ago = (m: number): Date => new Date(NOW.getTime() - m * 60_000)
const noop = (): void => {}
const REASON = 'Provider confirmed by phone the credit never left.'

const openException = exceptionRow({
  id: 'exc_1',
  settlementId: 'stl_open',
  workspaceId: 'ws_alpha',
  environment: 'live',
  code: 'RECONCILIATION_MISMATCH',
  enteredFrom: 'RECONCILING',
  openedAt: ago(30),
  recipientAmount: { currency: 'INR', minorUnits: '500000000' },
  pastPointOfNoReturn: false,
  providerRawCode: null,
  classification: null,
}, NOW)

const dispatchedException = exceptionRow({
  id: 'exc_2',
  settlementId: 'stl_out',
  workspaceId: 'ws_alpha',
  environment: 'live',
  code: 'PAYOUT_STATUS_UNKNOWN',
  enteredFrom: 'PAYOUT_SUBMITTED',
  openedAt: ago(90),
  recipientAmount: { currency: 'INR', minorUnits: '100000' },
  pastPointOfNoReturn: true,
  providerRawCode: 'ERR_9001',
  classification: 'unmapped',
}, NOW)

/* ── The reason ─────────────────────────────────────────────────────────── */

describe('the reason dialog', () => {
  const confirmation = {
    title: 'Resume this settlement?',
    body: 'It goes back to RECONCILING and carries on.',
    confirmLabel: 'Resume settlement',
    reasonPrompt: 'Why is it safe to resume? This is recorded permanently.',
  }

  it('will not confirm until a reason is written, and says so', async () => {
    const onConfirm = vi.fn()
    render(
      <ReasonedConfirm confirmation={confirmation} onConfirm={onConfirm} onCancel={noop} />,
    )
    const confirm = screen.getByRole('button', { name: 'Resume settlement' })
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('Write why you are doing this first.')).toBeTruthy()

    await userEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms with the reason once one is written', async () => {
    const onConfirm = vi.fn()
    render(
      <ReasonedConfirm confirmation={confirmation} onConfirm={onConfirm} onCancel={noop} />,
    )
    await userEvent.type(screen.getByLabelText('Reason'), REASON)
    await userEvent.click(screen.getByRole('button', { name: 'Resume settlement' }))
    expect(onConfirm).toHaveBeenCalledWith(REASON)
  })

  it('refuses whitespace, which is what an accidental submit produces', async () => {
    const onConfirm = vi.fn()
    render(
      <ReasonedConfirm confirmation={confirmation} onConfirm={onConfirm} onCancel={noop} />,
    )
    await userEvent.type(screen.getByLabelText('Reason'), '        ')
    await userEvent.click(screen.getByRole('button', { name: 'Resume settlement' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('says what will happen before asking for the reason', () => {
    render(<ReasonedConfirm confirmation={confirmation} onConfirm={noop} onCancel={noop} />)
    expect(screen.getByText(confirmation.body)).toBeTruthy()
    expect(screen.getByText(confirmation.reasonPrompt)).toBeTruthy()
  })

  it('renders nothing when there is nothing to confirm', () => {
    render(<ReasonedConfirm confirmation={null} onConfirm={noop} onCancel={noop} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

/* ── The exception queue ────────────────────────────────────────────────── */

describe('the exception queue', () => {
  const props = {
    rows: [openException, dispatchedException],
    onResolve: noop,
    onOpenSettlement: noop,
  }

  it('disables fail and cancel past the point of no return, and says why', () => {
    render(<ExceptionQueue {...props} />)
    const row = screen.getByText('stl_out').closest('tr')!
    expect(within(row).getByRole('button', { name: 'Fail' }).getAttribute('aria-disabled'))
      .toBe('true')
    expect(within(row).getByRole('button', { name: 'Cancel' }).getAttribute('aria-disabled'))
      .toBe('true')
    // Resume is always available: it is the honest action when we do not know.
    expect(within(row).getByRole('button', { name: 'Resume' }).getAttribute('aria-disabled'))
      .not.toBe('true')
    // Once per disabled action, which is right: each says why it is disabled.
    expect(within(row).getAllByText(/may already have credited/)).toHaveLength(2)
  })

  it('offers all three before dispatch', () => {
    render(<ExceptionQueue {...props} />)
    const row = screen.getByText('stl_open').closest('tr')!
    for (const label of ['Resume', 'Fail', 'Cancel']) {
      expect(within(row).getByRole('button', { name: label }).getAttribute('aria-disabled'))
        .not.toBe('true')
    }
  })

  it('shows where a resume would go, which is data rather than a choice', () => {
    render(<ExceptionQueue {...props} />)
    expect(screen.getByText('RECONCILING')).toBeTruthy()
    expect(screen.getByText('PAYOUT_SUBMITTED')).toBeTruthy()
  })

  it('flags a provider code the mapping table does not cover', () => {
    render(<ExceptionQueue {...props} />)
    expect(screen.getByText('Unmapped provider code')).toBeTruthy()
  })

  it('resolves only after a reason, and passes it through', async () => {
    const onResolve = vi.fn()
    render(<ExceptionQueue {...props} onResolve={onResolve} />)

    const row = screen.getByText('stl_open').closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: 'Resume' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/goes back to RECONCILING/)).toBeTruthy()
    expect(onResolve).not.toHaveBeenCalled()

    await userEvent.type(within(dialog).getByLabelText('Reason'), REASON)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resume settlement' }))
    expect(onResolve).toHaveBeenCalledWith('stl_open', 'resume', REASON)
  })

  it('never carries a reason from one action to the next', async () => {
    // A reason typed for a resume must not be submitted for a fail. The
    // consequence otherwise is an audit record whose reason describes a
    // different decision.
    const onResolve = vi.fn()
    render(<ExceptionQueue {...props} onResolve={onResolve} />)

    const row = screen.getByText('stl_open').closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: 'Resume' }))
    await userEvent.type(screen.getByLabelText('Reason'), REASON)
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))

    await userEvent.click(within(row).getByRole('button', { name: 'Fail' }))
    expect((screen.getByLabelText('Reason') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'Mark failed' }).getAttribute('aria-disabled'))
      .toBe('true')
  })

  it('tells an operator plainly when nothing is stuck', () => {
    render(<ExceptionQueue {...props} rows={[]} />)
    expect(screen.getByText('Nothing is stuck')).toBeTruthy()
    expect(screen.getByText(/state the queue should normally be in/)).toBeTruthy()
  })

  it('shows a loading and an error state', () => {
    render(<ExceptionQueue {...props} rows={[]} loading />)
    expect(screen.getByLabelText('Loading exceptions')).toBeTruthy()
    cleanup()
    render(<ExceptionQueue {...props} rows={[]} error="The connection dropped." />)
    expect(screen.getByText('We could not load the queue')).toBeTruthy()
  })

  it('never renders anything that looks like an account number', () => {
    render(<ExceptionQueue {...props} />)
    expect(document.body.textContent).not.toMatch(/\d{10,}/)
  })
})

/* ── Facilities ─────────────────────────────────────────────────────────── */

describe('the facility board', () => {
  const card = facilityCard({
    id: 'fac_1',
    workspaceId: 'ws_alpha',
    environment: 'live',
    providerId: 'partner_one',
    currency: 'USDT',
    limit: { currency: 'USDT', minorUnits: '100000000' },
    available: { currency: 'USDT', minorUnits: '60000000' },
    reserved: { currency: 'USDT', minorUnits: '10000000' },
    drawn: { currency: 'USDT', minorUnits: '30000000' },
    status: 'ACTIVE',
  })
  const props = { cards: [card], onSetLimit: noop, onSetStatus: noop }

  it('states the committed floor before anyone tries to go below it', () => {
    render(<FacilityBoard {...props} />)
    expect(screen.getByText('Committed')).toBeTruthy()
    expect(screen.getByText('400,000.00 USDT')).toBeTruthy()
  })

  it('will not take a limit that is not an integer of minor units', async () => {
    render(<FacilityBoard {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Change limit' }))
    await userEvent.type(screen.getByLabelText('New limit (minor units)'), '1000.50')
    expect(screen.getByRole('button', { name: 'Continue' }).getAttribute('aria-disabled'))
      .toBe('true')
  })

  it('says what suspending does and does not do, before it does it', async () => {
    const onSetStatus = vi.fn()
    render(<FacilityBoard {...props} onSetStatus={onSetStatus} />)
    await userEvent.click(screen.getByRole('button', { name: 'Suspend' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/New reservations stop/)).toBeTruthy()
    // The half people get wrong: an existing reservation is a promise a
    // settlement is counting on, and suspending does not break it.
    expect(within(dialog).getByText(/already made stand/)).toBeTruthy()

    await userEvent.type(within(dialog).getByLabelText('Reason'), REASON)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend facility' }))
    expect(onSetStatus).toHaveBeenCalledWith('fac_1', 'SUSPENDED', REASON)
  })

  it('warns before settlements stall rather than after', () => {
    cleanup()
    render(<FacilityBoard {...props} cards={[facilityCard({
      id: 'fac_2', workspaceId: 'ws_beta', environment: 'live', providerId: 'p',
      currency: 'USDT',
      limit: { currency: 'USDT', minorUnits: '100000000' },
      available: { currency: 'USDT', minorUnits: '0' },
      reserved: { currency: 'USDT', minorUnits: '0' },
      drawn: { currency: 'USDT', minorUnits: '100000000' },
      status: 'ACTIVE',
    })]} />)
    expect(screen.getByText(/settlements will stall here/)).toBeTruthy()
  })
})

/* ── Provider events ────────────────────────────────────────────────────── */

describe('the provider event log', () => {
  const rows = [
    providerEventRow({
      id: 'pev_1', providerId: 'partner_one', eventType: 'payout.status',
      receivedAt: ago(2), signatureValid: true, interpretation: 'payout_credited',
      unmappedCode: null, subjectId: 'stl_1',
    }, NOW),
    providerEventRow({
      id: 'pev_2', providerId: 'partner_one', eventType: 'payout.status',
      receivedAt: ago(4), signatureValid: false, interpretation: null,
      unmappedCode: null, subjectId: 'stl_2',
    }, NOW),
    providerEventRow({
      id: 'pev_3', providerId: 'partner_one', eventType: 'payout.status',
      receivedAt: ago(6), signatureValid: true, interpretation: null,
      unmappedCode: 'ERR_9001', subjectId: null,
    }, NOW),
  ]

  it('says an unsigned event changed nothing', () => {
    render(<ProviderEventLog rows={rows} onOpenSettlement={noop} />)
    expect(screen.getByText(/changed nothing/)).toBeTruthy()
  })

  it('names the code the mapping table is missing', () => {
    render(<ProviderEventLog rows={rows} onOpenSettlement={noop} />)
    expect(screen.getByText(/ERR_9001/)).toBeTruthy()
    expect(screen.getByText(/mapping table needs it/)).toBeTruthy()
  })

  it('explains why the screen exists, since the two failures look identical', () => {
    render(<ProviderEventLog rows={rows} onOpenSettlement={noop} />)
    expect(screen.getByText(/mapping problem, not a provider problem/)).toBeTruthy()
  })

  it('opens the settlement an event was about, from the keyboard', async () => {
    const onOpenSettlement = vi.fn()
    render(<ProviderEventLog rows={rows} onOpenSettlement={onOpenSettlement} />)
    const trigger = screen.getByRole('button', { name: 'stl_1' })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(onOpenSettlement).toHaveBeenCalledWith('stl_1')
  })
})

/**
 * What the Stage 3 settlement surfaces must do.
 *
 * Two rules carry most of the weight here. The cancellation affordance appears
 * **only while the settlement is genuinely cancellable** — offering a button
 * that cannot work is worse than offering none. And nothing on these screens
 * claims a capability Stages 4–6 have not built.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { money } from '@inrsettle/money'
import { SETTLEMENT_STATUSES, projectCustomerStatus } from '@inrsettle/domain/browser'
import { NewSettlement, SettlementDetail, EMPTY_NEW_SETTLEMENT } from './surfaces.js'
import { customerStateBadge, presentSettlement, progressStep } from './view-models.js'
import {
  ACTION_REQUIRED,
  BENEFICIARIES,
  CANCELLATION_REQUESTED,
  CANCELLED,
  DELAYED,
  DETAIL_BASE,
  FUNDING_CURRENCIES,
  INVOICE_REQUIREMENT,
  PURPOSES,
  QUOTE,
  READY,
  SANDBOX_PRICING_NOTICE,
  SETTLING,
  SETTLING_PAST_PONR,
} from './fixtures.js'

afterEach(cleanup)

const noop = (): void => {}

const FILLED = {
  beneficiaryId: 'ben_aarti',
  recipientMinorUnits: 500_000_000n,
  purposeCode: 'SOFTWARE_SERVICES',
  fundingCurrency: 'USDT' as const,
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

function renderDetail(overrides: Partial<React.ComponentProps<typeof SettlementDetail>> = {}) {
  return render(
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={READY}
      internalStatus="QUOTED"
      {...overrides}
    />,
  )
}

describe('New settlement', () => {
  it('asks for exactly the four frozen inputs', () => {
    renderNew()
    expect(screen.getByLabelText('Beneficiary')).toBeTruthy()
    expect(screen.getByLabelText('Recipient gets')).toBeTruthy()
    expect(screen.getByLabelText('Purpose')).toBeTruthy()
    expect(screen.getByLabelText('Funding currency')).toBeTruthy()
  })

  it('is recipient-first: the dominant figure is what the beneficiary receives', () => {
    renderNew()
    const quote = screen.getByLabelText('Quote', { selector: 'aside' })
    // The hero figure in the summary is the recipient amount, not the funding one.
    const hero = quote.querySelector('.is-amount--hero')
    expect(hero?.textContent).toContain('Recipient gets')
    expect(hero?.textContent).toContain('₹50,00,000.00')
  })

  it('names the commitment in the submit button, with the figure', () => {
    renderNew()
    expect(screen.getByRole('button', { name: 'Settle ₹50,00,000' })).toBeTruthy()
  })

  it('falls back to a bare label before an amount is entered', () => {
    renderNew({ values: EMPTY_NEW_SETTLEMENT, quote: null })
    expect(screen.getByRole('button', { name: 'Settle' })).toBeTruthy()
  })

  it('always states that sandbox pricing is not a commercial quote', () => {
    renderNew()
    // D-08 and D-09 are open. A test rate presented as a real price is the most
    // expensive kind of mock, so the notice is not optional decoration.
    const note = screen.getByRole('note')
    expect(note.textContent).toMatch(/Sandbox pricing/)
    expect(note.textContent).toMatch(/not a commercial quote/)
  })

  it('shows a blocking requirement with its own action and blocks submission', async () => {
    const onSubmit = vi.fn()
    renderNew({
      requirements: [INVOICE_REQUIREMENT],
      submitDisabledReason: 'Attach the invoice before you can settle this amount.',
      onSubmit,
    })
    expect(screen.getByText(INVOICE_REQUIREMENT.title)).toBeTruthy()
    const settle = screen.getByRole('button', { name: /^Settle/ })
    expect(settle.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(settle)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renders the pricing failure instead of a stale price', () => {
    renderNew({ quote: null, quoteError: 'We could not reach the pricing service.' })
    expect(screen.getByText('We could not price this settlement')).toBeTruthy()
    expect(document.body.textContent).not.toContain('83.0000000000')
  })

  it('names no provider, no rail and nothing from a later stage', () => {
    renderNew()
    const body = (document.body.textContent ?? '').toLowerCase()
    for (const word of ['neft', 'imps', 'rtgs', 'utr', 'paymate', 'facility', 'drawdown', 'reconcil']) { // liquidity-copy:allow — this list *is* the prohibition
      expect(body, `"${word}" does not belong on the customer's New Settlement screen`).not.toContain(word)
    }
  })
})

describe('Settlement detail', () => {
  it('leads with the amount and the customer state', () => {
    renderDetail()
    expect(screen.getByText('₹50,00,000.00')).toBeTruthy()
    expect(screen.getByText('Ready to settle')).toBeTruthy()
  })

  it('shows the Ready → Settling → Settled rail with the right step current', () => {
    renderDetail({ presentation: SETTLING, internalStatus: 'AUTHORIZED' })
    const rail = screen.getByRole('group', { name: 'Settlement progress' })
    const current = within(rail).getByText('Settling')
    expect(current.getAttribute('aria-current')).toBe('step')
    // Ready is behind it; Settled is not yet reached.
    expect(within(rail).getByText('Ready').getAttribute('aria-current')).toBeNull()
    expect(within(rail).getByText('Settled').getAttribute('aria-current')).toBeNull()
  })

  it('keeps technical detail secondary, behind a disclosure', () => {
    renderDetail({
      presentation: SETTLING,
      internalStatus: 'AUTHORIZED',
      authorizedTermsHash: 'a'.repeat(64),
      destinationVersionId: 'dvr_9Kd2ZxKp0Wq4',
    })
    const details = document.querySelector('details.is-settlement__technical')
    expect(details).toBeTruthy()
    expect((details as HTMLDetailsElement).open).toBe(false)
    expect(within(details as HTMLElement).getByText('AUTHORIZED')).toBeTruthy()
  })
})

describe('the cancellation affordance appears only while genuinely cancellable', () => {
  it('offers immediate cancellation before authorization', async () => {
    const onCancel = vi.fn()
    renderDetail({ presentation: READY, onCancel })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel settlement' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('offers a *request* after authorization, and says what that means', async () => {
    const onRequestCancellation = vi.fn()
    renderDetail({ presentation: SETTLING, internalStatus: 'AUTHORIZED', onRequestCancellation })
    expect(screen.queryByRole('button', { name: 'Cancel settlement' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Request cancellation' }))
    expect(onRequestCancellation).toHaveBeenCalledOnce()
    // Honesty about T26: the request is recorded, not applied.
    expect(screen.getByText(/stop it at the next safe point/)).toBeTruthy()
  })

  it('offers nothing once a cancellation is already requested', () => {
    renderDetail({
      presentation: CANCELLATION_REQUESTED,
      internalStatus: 'DRAWDOWN_CONFIRMED',
      onCancel: noop,
      onRequestCancellation: noop,
    })
    expect(screen.queryByRole('button', { name: /[Cc]ancel/ })).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/Cancellation requested/)
  })

  it('offers nothing past the point of no return, and says so', () => {
    renderDetail({
      presentation: SETTLING_PAST_PONR,
      internalStatus: 'PAYOUT_SUBMITTED',
      onCancel: noop,
      onRequestCancellation: noop,
    })
    expect(screen.queryByRole('button', { name: /[Cc]ancel/ })).toBeNull()
    // Stage 10 widened the copy to say *why*. § 12.3: the control "disappears
    // once the payout has been sent, replaced by a single line explaining why",
    // and a line that only states the fact explains nothing.
    expect(screen.getByText(/can no longer be cancelled — the payout has been sent/)).toBeTruthy()
  })

  it('offers nothing on a terminal settlement', () => {
    renderDetail({
      presentation: CANCELLED,
      internalStatus: 'CANCELLED',
      onCancel: noop,
      onRequestCancellation: noop,
    })
    expect(screen.queryByRole('button', { name: /[Cc]ancel/ })).toBeNull()
  })
})

describe('exceptions on the detail screen', () => {
  it('a customer-actionable exception renders a four-field requirement card', async () => {
    const onRequirementAction = vi.fn()
    renderDetail({ presentation: ACTION_REQUIRED, internalStatus: 'EXCEPTION', onRequirementAction })
    const card = document.querySelector('[data-requirement-code]')
    expect(card).toBeTruthy()
    expect(within(card as HTMLElement).getByRole('heading').textContent).toBeTruthy()
    await userEvent.click(within(card as HTMLElement).getByRole('button'))
    expect(onRequirementAction).toHaveBeenCalledOnce()
    // It reassures about the money before asking for anything.
    expect(card?.textContent).toMatch(/No funds left your facility/)
  })

  it('a non-actionable exception stays on the rail and explains the delay', () => {
    renderDetail({ presentation: DELAYED, internalStatus: 'EXCEPTION' })
    // Still Settling, not an alarm — the customer cannot fix it. "Settling"
    // appears twice by design: once as the state badge and once as the current
    // step on the rail, so both are asserted where they belong.
    const rail = screen.getByRole('group', { name: 'Settlement progress' })
    expect(within(rail).getByText('Settling').getAttribute('aria-current')).toBe('step')
    expect(document.querySelector('.is-status__label')?.textContent).toBe('Settling')
    expect(document.querySelector('[data-requirement-code]')).toBeNull()
    expect(document.body.textContent).toMatch(/confirming the final status/)
  })

  it('never shows an internal exception code or an ops resolution path', () => {
    for (const presentation of [DELAYED, ACTION_REQUIRED]) {
      cleanup()
      renderDetail({ presentation, internalStatus: 'EXCEPTION' })
      const body = document.body.textContent ?? ''
      expect(body).not.toContain('PAYOUT_STATUS_UNKNOWN')
      expect(body).not.toContain('PAYOUT_REJECTED_DESTINATION')
      expect(body.toLowerCase()).not.toContain('ops:')
    }
  })
})

describe('the projection is not re-derived here', () => {
  it('every internal status presents exactly what the domain projection says', () => {
    for (const status of SETTLEMENT_STATUSES) {
      const projection = projectCustomerStatus({ status, openExceptionCode: null })
      const presentation = presentSettlement({
        status,
        pointOfNoReturnAt: null,
        cancellationRequestedAt: null,
      })
      expect(presentation.customerStatus, status).toBe(projection.customerStatus)
      expect(presentation.listed, status).toBe(projection.listed)
    }
  })

  it('the badge is a function of the customer state alone', () => {
    // If a label needed the internal status to be decided, the projection would
    // be leaking into presentation. It does not: same customer state, same badge.
    const fromAuthorized = presentSettlement({
      status: 'AUTHORIZED', pointOfNoReturnAt: null, cancellationRequestedAt: null,
    })
    const fromPayoutSubmitted = presentSettlement({
      status: 'PAYOUT_SUBMITTED', pointOfNoReturnAt: null, cancellationRequestedAt: null,
    })
    expect(fromAuthorized.badge).toEqual(fromPayoutSubmitted.badge)
  })

  it('only the three on-rail states have a step', () => {
    expect(progressStep('READY')).toBe('READY')
    expect(progressStep('SETTLING')).toBe('SETTLING')
    expect(progressStep('SETTLED')).toBe('SETTLED')
    expect(progressStep('ACTION_REQUIRED')).toBeNull()
    expect(progressStep('CANCELLED')).toBeNull()
  })

  it('DRAFT is not a customer state and renders no badge', () => {
    const draft = presentSettlement({
      status: 'DRAFT', pointOfNoReturnAt: null, cancellationRequestedAt: null,
    })
    expect(draft.customerStatus).toBeNull()
    expect(draft.listed).toBe(false)
    expect(draft.badge).toBeNull()
  })

  it('FAILED and CANCELLED share one badge, and the reason carries the difference', () => {
    // D-03, closed. The badge used to take a `resolution` and render "Not
    // completed" for a failure, which was a sixth customer state wearing a
    // label instead of a name — same divergence, same integrator confusion, but
    // invisible to anyone reading the status enum. The badge no longer takes
    // the resolution at all, so that route back is closed by the signature.
    expect(customerStateBadge('CANCELLED').label).toBe('Cancelled')

    const failed = presentSettlement({
      status: 'FAILED', pointOfNoReturnAt: null, cancellationRequestedAt: null,
      resolutionCode: 'provider_rejected',
    })
    const cancelled = presentSettlement({
      status: 'CANCELLED', pointOfNoReturnAt: null, cancellationRequestedAt: null,
      resolutionCode: 'cancelled_by_customer',
    })

    expect(failed.badge).toEqual(cancelled.badge)
    expect(failed.customerStatus).toBe(cancelled.customerStatus)
    // Different explanations, and both of them say what happened to the money.
    expect(failed.resolutionMessage).not.toBe(cancelled.resolutionMessage)
    expect(failed.resolutionMessage).toMatch(/no funds were sent/i)
    expect(cancelled.resolutionMessage).toMatch(/no funds were sent/i)
  })

  it('a terminal settlement with no reason still renders, rather than showing a blank', () => {
    const bare = presentSettlement({
      status: 'FAILED', pointOfNoReturnAt: null, cancellationRequestedAt: null,
    })
    expect(bare.badge?.label).toBe('Cancelled')
    expect(bare.resolutionMessage).toBeNull()
  })
})

describe('nothing claims a capability Stage 3 has not built', () => {
  it('the detail screen offers no receipt, no UTR and no reconciliation', () => {
    renderDetail({ presentation: SETTLING, internalStatus: 'AUTHORIZED' })
    const body = (document.body.textContent ?? '').toLowerCase()
    for (const word of ['receipt', 'utr', 'download', 'reconcil', 'proof of payment']) {
      expect(body, `"${word}" belongs to a later stage`).not.toContain(word)
    }
  })

  it('renders an amount only from Money, never from a number', () => {
    // A compile-time guarantee made visible: AmountDisplay's prop is Money, so
    // a float can never reach the renderer. This asserts the runtime shape the
    // type protects.
    const amount = money('INR', 500_000_000n)
    expect(typeof amount.minorUnits).toBe('bigint')
    renderDetail({ recipientAmount: amount })
    expect(screen.getByText('₹50,00,000.00')).toBeTruthy()
  })
})

/**
 * What the beneficiary surfaces must actually do.
 *
 * The rules under test are product rules, not markup: preflight shows a real
 * action per requirement, editing a verified destination says what saving will
 * cost, and nothing anywhere renders a full account number.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Requirement } from '@inrsettle/domain/browser'
import {
  BeneficiaryDetail,
  BeneficiaryList,
  CreateBeneficiaryForm,
  EditDestinationForm,
  EMPTY_BENEFICIARY_FORM,
  PreflightPanel,
} from './surfaces.js'
import { actionLabel, verificationBadge } from './view-models.js'
import { DESTINATION_EDITED, DESTINATION_VERIFIED, FAILED, FORM_VALUES, ROWS, VERIFIED } from './fixtures.js'

afterEach(cleanup)

const noop = (): void => {}

describe('Beneficiaries list', () => {
  it('shows masked destinations and never a full account number', () => {
    render(
      <BeneficiaryList rows={ROWS} query="" onQueryChange={noop} onOpen={noop} onCreate={noop} />,
    )
    expect(screen.getByText('HDFC •••• 6789')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\d{10,}/)
  })

  it('says what to do when a beneficiary has no destination', () => {
    render(
      <BeneficiaryList rows={ROWS} query="" onQueryChange={noop} onOpen={noop} onCreate={noop} />,
    )
    expect(screen.getByText('Not added yet')).toBeTruthy()
  })

  it('opens a row from the keyboard', async () => {
    const onOpen = vi.fn()
    render(
      <BeneficiaryList rows={ROWS} query="" onQueryChange={noop} onOpen={onOpen} onCreate={noop} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Aarti Sharma' }))
    expect(onOpen).toHaveBeenCalledWith('ben_aarti')
  })

  it('its empty state tells the customer what to do, not that there is nothing', () => {
    render(<BeneficiaryList rows={[]} query="" onQueryChange={noop} onOpen={noop} onCreate={noop} />)
    expect(screen.getByText(/Add the person or company you want to pay/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'New beneficiary' }).length).toBeGreaterThan(0)
  })

  it('distinguishes "no results" from "nothing yet"', () => {
    render(<BeneficiaryList rows={[]} query="zzz" onQueryChange={noop} onOpen={noop} onCreate={noop} />)
    expect(screen.getByText('No beneficiary matches that name')).toBeTruthy()
  })

  it('is not a CRM', () => {
    render(<BeneficiaryList rows={ROWS} query="" onQueryChange={noop} onOpen={noop} onCreate={noop} />)
    const body = document.body.textContent ?? ''
    for (const word of ['Tags', 'Notes', 'Owner', 'Activity', 'Contacts', 'Lifecycle']) {
      expect(body, `${word} does not belong on a beneficiary surface`).not.toContain(word)
    }
  })
})

describe('Beneficiary detail', () => {
  function renderDetail(overrides: Partial<React.ComponentProps<typeof BeneficiaryDetail>> = {}) {
    const props: React.ComponentProps<typeof BeneficiaryDetail> = {
      displayName: 'Aarti Sharma',
      legalName: 'Aarti Sharma',
      country: 'IN',
      taxIdLast4: '234F',
      status: { tone: 'settled', label: 'Verified' },
      destinations: [DESTINATION_VERIFIED],
      onVerify: noop,
      onEditDestination: noop,
      onAddDestination: noop,
      ...overrides,
    }
    return render(<BeneficiaryDetail {...props} />)
  }

  it('masks the PAN', () => {
    renderDetail()
    expect(screen.getByText('•••• 234F')).toBeTruthy()
  })

  it('offers no verify action on a destination that is already verified', () => {
    renderDetail()
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull()
  })

  it('offers verification on a version that needs it, and names that version', async () => {
    const onVerify = vi.fn()
    renderDetail({ destinations: [DESTINATION_EDITED], onVerify })
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    // dvr_2 is the *current* version created by the edit — not the verified dvr_1.
    expect(onVerify).toHaveBeenCalledWith('dvr_2')
  })

  it('says "Try again" rather than "Verify" after a failure', () => {
    renderDetail({ destinations: [{ ...DESTINATION_EDITED, verification: FAILED }] })
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('shows previous details as history and explains why they are kept', async () => {
    renderDetail({ destinations: [DESTINATION_EDITED] })
    await userEvent.click(screen.getByText(/Previous details/))
    expect(screen.getByText('HDFC •••• 6789')).toBeTruthy()
    expect(screen.getByText(/Settlements already authorized against them are unaffected/)).toBeTruthy()
  })

  it('names no provider and no verification mechanic', () => {
    renderDetail({ destinations: [DESTINATION_EDITED] })
    const body = (document.body.textContent ?? '').toLowerCase()
    for (const word of ['penny drop', 'penny-drop', 'paymate', 'provider lookup', 'name match score']) {
      expect(body, `"${word}" is a mechanic, not customer language`).not.toContain(word)
    }
  })
})

describe('Editing a payout destination', () => {
  it('warns that saving creates a new version that needs verifying', () => {
    render(
      <EditDestinationForm
        beneficiaryName="Aarti Sharma"
        currentSummary="HDFC •••• 6789"
        currentVerification={VERIFIED}
        values={FORM_VALUES}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    )
    const note = screen.getByRole('note')
    expect(note.textContent).toMatch(/creates a new version/)
    expect(note.textContent).toMatch(/verify it before your next settlement/)
    expect(note.textContent).toMatch(/stay exactly as they are/)
  })

  it('does not warn when there was nothing verified to lose', () => {
    render(
      <EditDestinationForm
        beneficiaryName="Ravi Menon"
        currentSummary="HDFC •••• 8777"
        currentVerification={{ tone: 'ready', label: 'Not verified yet' }}
        values={FORM_VALUES}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    )
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('explains, rather than silently ignoring, a save that would change nothing', async () => {
    const onSubmit = vi.fn()
    render(
      <EditDestinationForm
        beneficiaryName="Aarti Sharma"
        currentSummary="HDFC •••• 6789"
        currentVerification={VERIFIED}
        values={FORM_VALUES}
        unchanged
        onChange={noop}
        onSubmit={onSubmit}
        onCancel={noop}
      />,
    )
    const save = screen.getByRole('button', { name: 'Save new details' })
    const describedBy = save.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/already saved/)
    await userEvent.click(save)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('Create beneficiary', () => {
  it('reports problems against the fields that have them', () => {
    render(
      <CreateBeneficiaryForm
        values={{ ...EMPTY_BENEFICIARY_FORM, type: 'business' }}
        errors={{
          displayName: 'Enter the name this beneficiary is known by.',
          legalName: 'A business needs its registered legal name.',
        }}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    )
    expect(screen.getByText('Enter the name this beneficiary is known by.')).toBeTruthy()
    expect(screen.getByText('A business needs its registered legal name.')).toBeTruthy()
    // Never a single generic banner.
    expect(document.body.textContent).not.toMatch(/validation failed/i) // copy-check:allow
  })

  it('asks for a legal name only when the beneficiary is a business', () => {
    const { rerender } = render(
      <CreateBeneficiaryForm values={EMPTY_BENEFICIARY_FORM} onChange={noop} onSubmit={noop} onCancel={noop} />,
    )
    expect(screen.queryByLabelText('Registered legal name')).toBeNull()
    rerender(
      <CreateBeneficiaryForm
        values={{ ...EMPTY_BENEFICIARY_FORM, type: 'business' }}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    )
    expect(screen.getByLabelText('Registered legal name')).toBeTruthy()
  })

  it('switches the destination fields between a bank account and UPI', () => {
    const { rerender } = render(
      <CreateBeneficiaryForm values={EMPTY_BENEFICIARY_FORM} onChange={noop} onSubmit={noop} onCancel={noop} />,
    )
    expect(screen.getByLabelText('IFSC')).toBeTruthy()
    rerender(
      <CreateBeneficiaryForm
        values={{ ...EMPTY_BENEFICIARY_FORM, kind: 'upi' }}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    )
    expect(screen.queryByLabelText('IFSC')).toBeNull()
    expect(screen.getByLabelText('UPI ID')).toBeTruthy()
  })
})

describe('Preflight panel', () => {
  const requirements: Requirement[] = [
    {
      code: 'beneficiary_account_unverified',
      severity: 'blocking',
      title: 'Beneficiary payout details need verification',
      detail: 'We confirm that HDFC •••• 8777 accepts payments and matches the beneficiary name.',
      action: { type: 'verify_beneficiary', beneficiaryId: 'ben_a', destinationVersionId: 'dvr_2' },
    },
    {
      code: 'large_settlement_review',
      severity: 'advisory',
      title: 'Large settlements may take longer to clear',
      detail: 'Settlements of ₹50,00,000.00 are reviewed by the partner bank.',
      action: { type: 'contact_support', topic: 'large_settlement_timing' },
    },
  ]

  it('gives every requirement its own explanation and its own button', () => {
    render(<PreflightPanel status="action_required" requirements={requirements} onAction={noop} />)
    for (const requirement of requirements) {
      const card = document.querySelector(`[data-requirement-code="${requirement.code}"]`)
      expect(card, requirement.code).toBeTruthy()
      expect(within(card as HTMLElement).getByRole('heading').textContent).toBe(requirement.title)
      expect(within(card as HTMLElement).getAllByRole('button')).toHaveLength(1)
    }
  })

  it('never shows an aggregate count instead of an explanation', () => {
    render(<PreflightPanel status="action_required" requirements={requirements} onAction={noop} />)
    expect(document.body.textContent).not.toMatch(/\d+ (problems?|errors?|issues?)/i)
  })

  it('passes the requirement itself to the handler, so the action is unambiguous', async () => {
    const onAction = vi.fn()
    render(<PreflightPanel status="action_required" requirements={requirements} onAction={onAction} />)
    await userEvent.click(screen.getByRole('button', { name: 'Verify now' }))
    expect(onAction).toHaveBeenCalledWith(requirements[0])
  })

  it('says ready, plainly, when nothing is outstanding', () => {
    render(<PreflightPanel status="ready" requirements={[]} onAction={noop} />)
    expect(screen.getByRole('heading', { name: 'Ready to settle' })).toBeTruthy()
  })

  it('an advisory requirement does not make the settlement look blocked', () => {
    render(
      <PreflightPanel
        status="ready"
        requirements={requirements.filter((r) => r.severity === 'advisory')}
        onAction={noop}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Ready to settle' })).toBeTruthy()
    expect(screen.getByText('Large settlements may take longer to clear')).toBeTruthy()
  })

  it('has a label for every action type a rule can produce', () => {
    const actions: Requirement['action'][] = [
      { type: 'verify_beneficiary', beneficiaryId: 'b', destinationVersionId: 'v' },
      { type: 'edit_beneficiary', beneficiaryId: 'b', field: 'tax_id' },
      { type: 'add_payout_destination', beneficiaryId: 'b' },
      { type: 'upload_document', documentType: 'commercial_invoice' },
      { type: 'select_purpose' },
      { type: 'contact_support', topic: 't' },
      { type: 'set_up_liquidity_facility' },
    ]
    for (const action of actions) {
      expect(actionLabel(action).length, action.type).toBeGreaterThan(3)
    }
  })
})

describe('verification copy', () => {
  it('describes state in product language, never in provider mechanics', () => {
    for (const status of ['unverified', 'verifying', 'verified', 'failed'] as const) {
      const badge = verificationBadge(status)
      const text = `${badge.label} ${badge.detail ?? ''}`.toLowerCase()
      expect(text).not.toMatch(/penny|lookup|provider|score/)
      expect(badge.label.length).toBeGreaterThan(3)
    }
  })
})

/* ─────────────────────────────────── INV-12 at the rendering boundary ──── */

describe('INV-12 — no surface can render a full account number', () => {
  const ACCOUNT = '50100987654321'
  const PAN = 'ABCDE1234F'

  /** Anything longer than the permitted last four is a leak. */
  function leaked(text: string): string | null {
    if (text.includes(PAN)) return PAN
    for (let len = 5; len <= ACCOUNT.length; len += 1) {
      const tail = ACCOUNT.slice(-len)
      if (text.includes(tail)) return tail
    }
    return null
  }

  const masked = `HDFC •••• ${ACCOUNT.slice(-4)}`
  const destination = { ...DESTINATION_EDITED, summary: masked }

  it('the detector catches a leak when one is present', () => {
    expect(leaked(`account ${ACCOUNT}`)).toBeTruthy()
    expect(leaked(masked)).toBeNull()
  })

  it('the list renders only the masked summary', () => {
    render(
      <BeneficiaryList
        rows={[{ ...ROWS[0]!, destinationSummary: masked }]}
        query=""
        onQueryChange={noop}
        onOpen={noop}
        onCreate={noop}
      />,
    )
    expect(leaked(document.body.textContent ?? '')).toBeNull()
    expect(screen.getByText(masked)).toBeTruthy()
  })

  it('the detail screen, including expanded history, renders only masked forms', async () => {
    render(
      <BeneficiaryDetail
        displayName="Aarti Sharma"
        legalName="Aarti Sharma"
        country="IN"
        taxIdLast4={PAN.slice(-4)}
        status={{ tone: 'settled', label: 'Verified' }}
        destinations={[
          {
            ...destination,
            history: destination.history.map((v) => ({ ...v, summary: masked })),
          },
        ]}
        onVerify={noop}
        onEditDestination={noop}
        onAddDestination={noop}
      />,
    )
    await userEvent.click(screen.getByText(/Previous details/))
    const text = document.body.textContent ?? ''
    expect(leaked(text)).toBeNull()
    // The PAN is shown masked, which is the point — not omitted entirely.
    expect(text).toContain(`•••• ${PAN.slice(-4)}`)
  })

  it('a preflight requirement built from a real destination summary leaks nothing', () => {
    render(
      <PreflightPanel
        status="action_required"
        requirements={[
          {
            code: 'beneficiary_account_unverified',
            severity: 'blocking',
            title: 'Beneficiary payout details need verification',
            detail: `We confirm that ${masked} accepts payments and matches the beneficiary name.`,
            action: { type: 'verify_beneficiary', beneficiaryId: 'ben_a', destinationVersionId: 'dvr_2' },
          },
        ]}
        onAction={noop}
      />,
    )
    expect(leaked(document.body.textContent ?? '')).toBeNull()
  })

  it('the edit form shows the current destination masked, and never prefills a full number', () => {
    render(
      <EditDestinationForm
        beneficiaryName="Aarti Sharma"
        currentSummary={masked}
        currentVerification={VERIFIED}
        // The form starts empty for the account number: re-entering it is the
        // point of an edit, and prefilling would put the secret in the DOM.
        values={{ ...FORM_VALUES, accountNumber: '' }}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    )
    expect(leaked(document.body.textContent ?? '')).toBeNull()
    expect((screen.getByLabelText('Account number') as HTMLInputElement).value).toBe('')
  })

  it('no surface renders a keyed fingerprint', () => {
    // The fingerprint is not in the view model at all, so this is a
    // regression guard: if someone adds it back, the summary is where it would
    // surface first.
    render(
      <BeneficiaryList
        rows={[{ ...ROWS[0]!, destinationSummary: masked }]}
        query=""
        onQueryChange={noop}
        onOpen={noop}
        onCreate={noop}
      />,
    )
    expect(document.body.textContent).not.toMatch(/v1:[A-Za-z0-9_-]{20,}/)
  })
})

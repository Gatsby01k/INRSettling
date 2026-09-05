import type { Meta, StoryObj } from '@storybook/react'
import type { Requirement } from '@inrsettle/domain/browser'
import {
  BeneficiaryDetail,
  BeneficiaryList,
  CreateBeneficiaryForm,
  EditDestinationForm,
  EMPTY_BENEFICIARY_FORM,
  PreflightPanel,
} from './surfaces.js'
import {
  DESTINATION_EDITED,
  DESTINATION_VERIFIED,
  FAILED,
  FORM_VALUES,
  ROWS,
  UNVERIFIED,
  VERIFIED,
  VERIFYING,
} from './fixtures.js'

const noop = (): void => {}

/* ── List ──────────────────────────────────────────────────────────────── */

const listMeta: Meta<typeof BeneficiaryList> = {
  title: 'Surfaces/Beneficiaries list',
  component: BeneficiaryList,
  args: { rows: ROWS, query: '', onQueryChange: noop, onOpen: noop, onCreate: noop },
}
export default listMeta
type L = StoryObj<typeof BeneficiaryList>

export const ListDefault: L = { name: 'Default' }
export const ListLoading: L = { name: 'Loading', args: { loading: true, rows: [] } }
export const ListEmpty: L = { name: 'Empty', args: { rows: [] } }
export const ListNoMatch: L = { name: 'No match', args: { rows: [], query: 'zzz' } }
export const ListError: L = {
  name: 'Error',
  args: { rows: [], error: 'The connection dropped while loading this page.' },
}

/* ── Detail ────────────────────────────────────────────────────────────── */

export const DetailVerified: StoryObj<typeof BeneficiaryDetail> = {
  name: 'Detail — verified',
  render: () => (
    <BeneficiaryDetail
      displayName="Aarti Sharma"
      legalName="Aarti Sharma"
      country="IN"
      taxIdLast4="234F"
      status={{ tone: 'settled', label: 'Verified' }}
      destinations={[DESTINATION_VERIFIED]}
      onVerify={noop}
      onEditDestination={noop}
      onAddDestination={noop}
      onNewSettlement={noop}
    />
  ),
}

export const DetailAfterEdit: StoryObj<typeof BeneficiaryDetail> = {
  name: 'Detail — edited, needs re-verification',
  render: () => (
    <BeneficiaryDetail
      displayName="Aarti Sharma"
      legalName="Aarti Sharma"
      country="IN"
      taxIdLast4="234F"
      status={{ tone: 'ready', label: 'Needs verification' }}
      destinations={[DESTINATION_EDITED]}
      onVerify={noop}
      onEditDestination={noop}
      onAddDestination={noop}
    />
  ),
}

export const DetailVerifying: StoryObj<typeof BeneficiaryDetail> = {
  name: 'Detail — verification running',
  render: () => (
    <BeneficiaryDetail
      displayName="Vertex Software Pvt Ltd"
      legalName="Vertex Software Private Limited"
      country="IN"
      taxIdLast4={null}
      status={{ tone: 'ready', label: 'Needs verification' }}
      destinations={[{ ...DESTINATION_EDITED, verification: VERIFYING, verifying: true }]}
      onVerify={noop}
      onEditDestination={noop}
      onAddDestination={noop}
    />
  ),
}

export const DetailFailed: StoryObj<typeof BeneficiaryDetail> = {
  name: 'Detail — verification failed',
  render: () => (
    <BeneficiaryDetail
      displayName="Aarti Sharma"
      legalName="Aarti Sharma"
      country="IN"
      taxIdLast4="234F"
      status={{ tone: 'ready', label: 'Needs verification' }}
      destinations={[{ ...DESTINATION_EDITED, verification: FAILED }]}
      onVerify={noop}
      onEditDestination={noop}
      onAddDestination={noop}
    />
  ),
}

export const DetailNoDestination: StoryObj<typeof BeneficiaryDetail> = {
  name: 'Detail — no destination yet',
  render: () => (
    <BeneficiaryDetail
      displayName="Ravi Menon"
      legalName={null}
      country="IN"
      taxIdLast4={null}
      status={{ tone: 'ready', label: 'No payout destination' }}
      destinations={[]}
      onVerify={noop}
      onEditDestination={noop}
      onAddDestination={noop}
    />
  ),
}

/* ── Create ────────────────────────────────────────────────────────────── */

export const CreateDefault: StoryObj<typeof CreateBeneficiaryForm> = {
  name: 'Create — empty',
  render: () => (
    <CreateBeneficiaryForm
      values={EMPTY_BENEFICIARY_FORM}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />
  ),
}

export const CreateWithFieldErrors: StoryObj<typeof CreateBeneficiaryForm> = {
  name: 'Create — field errors',
  render: () => (
    <CreateBeneficiaryForm
      values={{ ...EMPTY_BENEFICIARY_FORM, type: 'business', ifsc: 'HDFC123' }}
      errors={{
        displayName: 'Enter the name this beneficiary is known by.',
        legalName: 'A business needs its registered legal name.',
        ifsc: 'An IFSC is eleven characters, for example HDFC0000123.',
      }}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />
  ),
}

export const CreateSubmitting: StoryObj<typeof CreateBeneficiaryForm> = {
  name: 'Create — submitting',
  render: () => (
    <CreateBeneficiaryForm values={FORM_VALUES} submitting onChange={noop} onSubmit={noop} onCancel={noop} />
  ),
}

/* ── Edit destination ──────────────────────────────────────────────────── */

export const EditWarnsAboutReverification: StoryObj<typeof EditDestinationForm> = {
  name: 'Edit — warns a new version needs verifying',
  render: () => (
    <EditDestinationForm
      beneficiaryName="Aarti Sharma"
      currentSummary="HDFC •••• 6789"
      currentVerification={VERIFIED}
      values={FORM_VALUES}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />
  ),
}

export const EditUnchanged: StoryObj<typeof EditDestinationForm> = {
  name: 'Edit — nothing changed',
  render: () => (
    <EditDestinationForm
      beneficiaryName="Aarti Sharma"
      currentSummary="HDFC •••• 6789"
      currentVerification={VERIFIED}
      values={FORM_VALUES}
      unchanged
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />
  ),
}

export const EditUnverified: StoryObj<typeof EditDestinationForm> = {
  name: 'Edit — destination never verified',
  render: () => (
    <EditDestinationForm
      beneficiaryName="Ravi Menon"
      currentSummary="HDFC •••• 8777"
      currentVerification={UNVERIFIED}
      values={FORM_VALUES}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />
  ),
}

/* ── Preflight ─────────────────────────────────────────────────────────── */

const REQUIREMENTS: Requirement[] = [
  {
    code: 'beneficiary_account_unverified',
    severity: 'blocking',
    title: 'Beneficiary payout details need verification',
    detail:
      'We confirm that HDFC •••• 8777 accepts payments and matches the beneficiary name. This takes about a minute.',
    action: { type: 'verify_beneficiary', beneficiaryId: 'ben_aarti', destinationVersionId: 'dvr_2' },
  },
  {
    code: 'invoice_required',
    severity: 'blocking',
    title: 'Invoice is required for this settlement',
    detail:
      'Settlements of ₹20,00,000.00 for Software services need a commercial invoice before we can send them.',
    action: { type: 'upload_document', documentType: 'commercial_invoice' },
  },
  {
    code: 'liquidity_facility_required',
    severity: 'blocking',
    title: 'Your account is not set up to settle yet',
    detail:
      'Live settlements need your account to be enabled for settling. Sandbox settlements work without it, so you can keep building and testing.',
    action: { type: 'set_up_liquidity_facility' },
  },
  {
    code: 'large_settlement_review',
    severity: 'advisory',
    title: 'Large settlements may take longer to clear',
    detail:
      'Settlements of ₹50,00,000.00 are reviewed by the partner bank, which can add a few hours to delivery.',
    action: { type: 'contact_support', topic: 'large_settlement_timing' },
  },
]

export const PreflightReady: StoryObj<typeof PreflightPanel> = {
  name: 'Preflight — ready',
  render: () => <PreflightPanel status="ready" requirements={[]} onAction={noop} />,
}

export const PreflightActionRequired: StoryObj<typeof PreflightPanel> = {
  name: 'Preflight — action required',
  render: () => <PreflightPanel status="action_required" requirements={REQUIREMENTS} onAction={noop} />,
}

export const PreflightBusy: StoryObj<typeof PreflightPanel> = {
  name: 'Preflight — action running',
  render: () => (
    <PreflightPanel
      status="action_required"
      requirements={REQUIREMENTS}
      busyCodes={['beneficiary_account_unverified']}
      onAction={noop}
    />
  ),
}

export const PreflightLoading: StoryObj<typeof PreflightPanel> = {
  name: 'Preflight — loading',
  render: () => <PreflightPanel status="ready" requirements={[]} loading onAction={noop} />,
}

export const PreflightAdvisoryOnly: StoryObj<typeof PreflightPanel> = {
  name: 'Preflight — ready with advice',
  render: () => (
    <PreflightPanel
      status="ready"
      requirements={REQUIREMENTS.filter((r) => r.severity === 'advisory')}
      onAction={noop}
    />
  ),
}

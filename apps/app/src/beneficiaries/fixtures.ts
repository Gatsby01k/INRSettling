/**
 * Shared fixtures for the beneficiary surface stories and tests.
 *
 * Every account number here ends in a digit pair the sandbox verification
 * simulator recognises, so a story and an integration test describe the same
 * scenario rather than two unrelated ones.
 */
import type { BeneficiaryRow, VerificationBadge, VersionRow } from './view-models.js'
import type { DestinationPanel } from './surfaces.js'
import { EMPTY_BENEFICIARY_FORM, type BeneficiaryFormValues } from './surfaces.js'

export const VERIFIED: VerificationBadge = { tone: 'settled', label: 'Verified', detail: '12 Aug 2026' }
export const UNVERIFIED: VerificationBadge = { tone: 'ready', label: 'Not verified yet' }
export const VERIFYING: VerificationBadge = { tone: 'settling', label: 'Verifying', detail: 'usually under a minute' }
export const FAILED: VerificationBadge = { tone: 'action_required', label: 'Could not verify' }

export const ROWS: BeneficiaryRow[] = [
  {
    id: 'ben_aarti',
    displayName: 'Aarti Sharma',
    destinationSummary: 'HDFC •••• 6789',
    status: { tone: 'settled', label: 'Verified' },
  },
  {
    id: 'ben_vertex',
    displayName: 'Vertex Software Pvt Ltd',
    destinationSummary: 'ICIC •••• 0099',
    status: { tone: 'ready', label: 'Needs verification' },
  },
  {
    id: 'ben_ravi',
    displayName: 'Ravi Menon',
    destinationSummary: null,
    status: { tone: 'ready', label: 'No payout destination' },
  },
]

export const HISTORY: VersionRow[] = [
  {
    id: 'dvr_2',
    versionNumber: 2,
    summary: 'HDFC •••• 8777',
    verification: UNVERIFIED,
    createdAt: new Date('2026-08-20T09:00:00Z'),
    current: true,
  },
  {
    id: 'dvr_1',
    versionNumber: 1,
    summary: 'HDFC •••• 6789',
    verification: VERIFIED,
    createdAt: new Date('2026-08-12T09:00:00Z'),
    current: false,
  },
]

export const DESTINATION_VERIFIED: DestinationPanel = {
  id: 'dst_1',
  kind: 'bank_account',
  currentVersionId: 'dvr_1',
  summary: 'HDFC •••• 6789',
  verification: VERIFIED,
  verifying: false,
  history: [HISTORY[1]!].map((v) => ({ ...v, current: true })),
}

export const DESTINATION_EDITED: DestinationPanel = {
  id: 'dst_1',
  kind: 'bank_account',
  currentVersionId: 'dvr_2',
  summary: 'HDFC •••• 8777',
  verification: UNVERIFIED,
  verifying: false,
  history: HISTORY,
}

export const FORM_VALUES: BeneficiaryFormValues = {
  ...EMPTY_BENEFICIARY_FORM,
  displayName: 'Aarti Sharma',
  accountHolderName: 'Aarti Sharma',
  accountNumber: '50100123456789',
  ifsc: 'HDFC0000123',
}

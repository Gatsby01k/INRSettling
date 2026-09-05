/**
 * The shapes the beneficiary surfaces render.
 *
 * These are deliberately *not* the database rows and not the domain types. They
 * are what a screen needs, and the mapping from `BeneficiaryView` happens here
 * in one place — which is also the last point at which a full account number
 * could leak into a rendered page. It cannot: `BeneficiaryView` has no field
 * carrying one (`INV-12`), and neither does anything below.
 */
import type { StatusTone } from '@inrsettle/ui'
import type { BeneficiaryView, DestinationVersionView } from '@inrsettle/app-services'
import type { Requirement, VerificationStatus } from '@inrsettle/domain/browser'

export interface VerificationBadge {
  tone: StatusTone
  label: string
  detail?: string
}

/**
 * How a verification state is described to a customer.
 *
 * Product language is "Verify beneficiary" (`PRODUCT.md § 7.1`). Penny drop,
 * provider lookup and name-match scores are mechanics; none of them appear
 * here, and `D-11` can be answered either way without this copy changing.
 */
export function verificationBadge(
  status: VerificationStatus,
  verifiedAt?: Date | null,
): VerificationBadge {
  switch (status) {
    case 'verified':
      return {
        tone: 'settled',
        label: 'Verified',
        ...(verifiedAt ? { detail: formatDay(verifiedAt) } : {}),
      }
    case 'verifying':
      return { tone: 'settling', label: 'Verifying', detail: 'usually under a minute' }
    case 'failed':
      return { tone: 'action_required', label: 'Could not verify' }
    case 'unverified':
      return { tone: 'ready', label: 'Not verified yet' }
  }
}

function formatDay(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

export function beneficiaryStatusBadge(view: BeneficiaryView): VerificationBadge {
  switch (view.status) {
    case 'verified':
      return { tone: 'settled', label: 'Verified' }
    case 'pending_verification':
      return { tone: 'ready', label: 'Needs verification' }
    case 'rejected':
      return { tone: 'action_required', label: 'Rejected' }
    case 'disabled':
      return { tone: 'cancelled', label: 'Disabled' }
    case 'draft':
      return { tone: 'ready', label: 'No payout destination' }
  }
}

export interface BeneficiaryRow {
  id: string
  displayName: string
  /** Masked summary of the default destination, or null when there is none. */
  destinationSummary: string | null
  status: VerificationBadge
}

export function toRow(view: BeneficiaryView): BeneficiaryRow {
  const primary =
    view.destinations.find((d) => d.id === view.defaultDestinationId) ??
    view.destinations.find((d) => d.disabledAt === null)
  return {
    id: view.id,
    displayName: view.displayName,
    destinationSummary: primary?.currentVersion?.summary ?? null,
    status: beneficiaryStatusBadge(view),
  }
}

/** One line of destination history, newest first. */
export interface VersionRow {
  id: string
  versionNumber: number
  summary: string
  verification: VerificationBadge
  createdAt: Date
  current: boolean
}

export function toVersionRow(v: DestinationVersionView, currentVersionId: string | null): VersionRow {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    summary: v.summary,
    verification: verificationBadge(v.verificationStatus, v.verifiedAt),
    createdAt: v.createdAt,
    current: v.id === currentVersionId,
  }
}

/**
 * The label on a requirement's action button.
 *
 * One label per action type, because a requirement gets exactly one action and
 * the customer should recognise it from the verb, not from the sentence above
 * it.
 */
export function actionLabel(action: Requirement['action']): string {
  switch (action.type) {
    case 'verify_beneficiary':
      return 'Verify now'
    case 'edit_beneficiary':
      return 'Edit details'
    case 'add_payout_destination':
      return 'Add payout destination'
    case 'upload_document':
      return 'Attach document'
    case 'select_purpose':
      return 'Choose a purpose'
    case 'contact_support':
      return 'Contact support'
    case 'set_up_liquidity_facility':
      // Not "Set up facility". A facility is our arrangement with a liquidity
      // provider, not something the customer operates or has heard of; the
      // action they can actually take is to talk to us (`PRODUCT.md § 12`).
      return 'Talk to us about going live'
  }
}

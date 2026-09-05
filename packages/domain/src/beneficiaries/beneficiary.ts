/**
 * Beneficiary — DOMAIN.md § 6.2, PRODUCT.md § 11.
 *
 * Deliberately not a CRM. The fields here are the ones that help someone
 * settle; anything else is out of scope by design, not by omission.
 */
export type BeneficiaryType = 'individual' | 'business'
export type BeneficiaryStatus =
  | 'draft' | 'pending_verification' | 'verified' | 'rejected' | 'disabled'

export interface BeneficiaryIdentity {
  displayName: string
  legalName?: string | undefined
  type: BeneficiaryType
  /** V1 is India-only. */
  country: 'IN'
  /** PAN. Optional here; whether it is *required* is a preflight rule (D-06). */
  taxId?: string | undefined
}

export const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/

export type IdentityProblem =
  | { field: 'displayName'; code: 'display_name_missing' }
  | { field: 'legalName'; code: 'legal_name_required_for_business' }
  | { field: 'taxId'; code: 'tax_id_invalid' }

export function validateBeneficiaryIdentity(b: BeneficiaryIdentity): IdentityProblem[] {
  const problems: IdentityProblem[] = []
  if (b.displayName.trim() === '') problems.push({ field: 'displayName', code: 'display_name_missing' })
  if (b.type === 'business' && !b.legalName?.trim()) {
    problems.push({ field: 'legalName', code: 'legal_name_required_for_business' })
  }
  if (b.taxId !== undefined && b.taxId !== '' && !PAN_PATTERN.test(b.taxId)) {
    problems.push({ field: 'taxId', code: 'tax_id_invalid' })
  }
  return problems
}

/**
 * Beneficiary status is derived from its destinations, not set by hand: a
 * beneficiary is verified when it has at least one verified current destination
 * version. Stage 3 authorizes against the *version* (`INV-11`), so this status
 * is a summary for the customer rather than the thing execution checks.
 *
 * `rejected` is deliberately **not** derived from a failed verification. A
 * penny drop that does not land means "these account details did not work" —
 * fixable by editing the destination, which creates a new version. `REJECTED`
 * is a decision about the *beneficiary* (screening, compliance), it is not
 * fixable by the customer, and it is therefore an explicit input here rather
 * than something a transient rail failure can trigger. Collapsing the two would
 * route a customer with a mistyped IFSC to support instead of to the fix.
 */
export function deriveBeneficiaryStatus(args: {
  disabled: boolean
  /** Set by an operator decision, never by a verification outcome. */
  rejected: boolean
  destinationCount: number
  anyCurrentVersionVerified: boolean
}): BeneficiaryStatus {
  if (args.disabled) return 'disabled'
  if (args.rejected) return 'rejected'
  if (args.destinationCount === 0) return 'draft'
  if (args.anyCurrentVersionVerified) return 'verified'
  return 'pending_verification'
}

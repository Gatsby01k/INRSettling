/**
 * Payout destinations and their immutable versions — DOMAIN.md § 6.2.
 *
 * Pure. No persistence, no crypto, no framework. The rule this file exists to
 * make true: a destination id is a handle the customer owns, and a *version* is
 * the immutable thing money is actually sent to.
 */

export type DestinationKind = 'bank_account' | 'upi'
export type AccountType = 'savings' | 'current'
export type VerificationStatus = 'unverified' | 'verifying' | 'verified' | 'failed'
export type VerificationMethod = 'penny_drop' | 'provider_lookup' | 'manual'

/** The payout details themselves, in plaintext. Never persisted in this shape. */
export type PayoutDetails =
  | {
      kind: 'bank_account'
      accountNumber: string
      ifsc: string
      accountType: AccountType
      accountHolderName: string
    }
  | { kind: 'upi'; vpa: string }

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/
/** A VPA is `handle@psp`; the PSP list is provider data, so only shape is checked. */
export const VPA_PATTERN = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/

export type DetailsProblem =
  | { field: 'accountNumber'; code: 'account_number_invalid' }
  | { field: 'ifsc'; code: 'ifsc_invalid' }
  | { field: 'accountHolderName'; code: 'account_holder_name_missing' }
  | { field: 'vpa'; code: 'vpa_invalid' }

/**
 * Normalise details to the form that is stored, hashed and compared.
 *
 * Validation, equality and persistence all run on this form, so they cannot
 * disagree: an IFSC typed in lower case is the *same* IFSC, and it must not be
 * accepted by the hash and rejected by the validator — or the customer is
 * refused for typing something we would have stored identically.
 */
export function normalisePayoutDetails(d: PayoutDetails): PayoutDetails {
  if (d.kind === 'bank_account') {
    return {
      kind: 'bank_account',
      accountNumber: d.accountNumber.trim(),
      ifsc: d.ifsc.trim().toUpperCase(),
      accountType: d.accountType,
      accountHolderName: d.accountHolderName.trim().replace(/\s+/g, ' '),
    }
  }
  return { kind: 'upi', vpa: d.vpa.trim().toLowerCase() }
}

export function validatePayoutDetails(raw: PayoutDetails): DetailsProblem[] {
  const d = normalisePayoutDetails(raw)
  const problems: DetailsProblem[] = []
  if (d.kind === 'bank_account') {
    if (!/^\d{6,20}$/.test(d.accountNumber)) {
      problems.push({ field: 'accountNumber', code: 'account_number_invalid' })
    }
    if (!IFSC_PATTERN.test(d.ifsc)) problems.push({ field: 'ifsc', code: 'ifsc_invalid' })
    if (d.accountHolderName === '') {
      problems.push({ field: 'accountHolderName', code: 'account_holder_name_missing' })
    }
  } else if (!VPA_PATTERN.test(d.vpa)) {
    problems.push({ field: 'vpa', code: 'vpa_invalid' })
  }
  return problems
}

/**
 * Canonical serialisation of the *plaintext* details.
 *
 * The hash is taken before encryption, so identical details always produce an
 * identical hash. That makes "did the payout details actually change" a
 * comparison rather than a judgement, and it is what stops a no-op save from
 * creating a version and silently un-verifying a destination.
 */
export function canonicalDetails(raw: PayoutDetails): string {
  const d = normalisePayoutDetails(raw)
  if (d.kind === 'bank_account') {
    return JSON.stringify({
      kind: d.kind,
      accountNumber: d.accountNumber,
      ifsc: d.ifsc,
      accountType: d.accountType,
      accountHolderName: d.accountHolderName,
    })
  }
  return JSON.stringify({ kind: d.kind, vpa: d.vpa })
}

/**
 * Turns canonical payout details into the value stored for change detection.
 *
 * This is a **port**, not a function, because the answer must be keyed. A plain
 * SHA-256 of the canonical details is a offline-guessable digest of a bank
 * account: the input space is small and structured (an 11-character IFSC and a
 * numeric account), so anyone holding the column could enumerate candidates and
 * confirm an account number without ever touching the ciphertext. Encrypting
 * the account number and then storing an unkeyed hash of it beside would undo
 * the encryption.
 *
 * The implementation is HMAC-SHA256 under a secret that lives outside the
 * database (`@inrsettle/app-services`), scoped per workspace and environment so
 * one tenant's fingerprints cannot be compared against another's. The domain
 * states the requirement; infrastructure holds the key.
 */
export interface DestinationFingerprinter {
  /** Opaque, stable for identical details in the same tenant scope. */
  fingerprint(scope: { workspaceId: string; environment: string }, d: PayoutDetails): string
}

/**
 * Did the payout details actually change?
 *
 * Both sides go through the same fingerprinter and the same scope, so this
 * answers "would saving create a new version" without either side being
 * derivable from the answer.
 */
export function detailsChanged(
  fingerprinter: DestinationFingerprinter,
  scope: { workspaceId: string; environment: string },
  a: PayoutDetails,
  b: PayoutDetails,
): boolean {
  return fingerprinter.fingerprint(scope, a) !== fingerprinter.fingerprint(scope, b)
}

/** Only the last four digits are ever shown (INV-12). */
export function maskAccountNumber(accountNumber: string): string {
  return accountNumber.slice(-4)
}

export function destinationSummary(v: {
  kind: DestinationKind
  ifsc?: string | null
  accountNumberLast4?: string | null
  vpa?: string | null
}): string {
  if (v.kind === 'upi') return v.vpa ?? 'UPI'
  const bank = v.ifsc ? v.ifsc.slice(0, 4) : 'Bank'
  return `${bank} •••• ${v.accountNumberLast4 ?? '????'}`
}

/**
 * A new version always starts unverified (INV-44). This is stated as a function
 * rather than a default so that no call site can pass something else.
 */
export const INITIAL_VERSION_VERIFICATION: VerificationStatus = 'unverified'

/** Verification belongs to the version that was checked (INV-45). */
export interface VersionVerification {
  destinationVersionId: string
  status: VerificationStatus
  method: VerificationMethod | null
  nameMatchScore: number | null
  verifiedAt: Date | null
}

export function isVersionVerified(v: VersionVerification | null | undefined): boolean {
  return v?.status === 'verified'
}

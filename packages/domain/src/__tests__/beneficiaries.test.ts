import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  INITIAL_VERSION_VERIFICATION,
  canonicalDetails,
  deriveBeneficiaryStatus,
  destinationSummary,
  detailsChanged,
  isVersionVerified,
  maskAccountNumber,
  normalisePayoutDetails,
  validateBeneficiaryIdentity,
  validatePayoutDetails,
  type DestinationFingerprinter,
  type PayoutDetails,
} from '../index.js'

/**
 * A stand-in for the real fingerprinter. The domain declares the port; this
 * proves the port's *contract* (same details in the same scope agree, different
 * scopes differ), while the real HMAC implementation is tested in
 * `packages/app`.
 */
function testFingerprinter(secret = 'test-secret'): DestinationFingerprinter {
  return {
    fingerprint: (scope, d) =>
      createHmac('sha256', secret)
        .update(`${scope.workspaceId}|${scope.environment}|${canonicalDetails(d)}`)
        .digest('base64url'),
  }
}

const WS = { workspaceId: 'ws_a', environment: 'live' }

const BANK: PayoutDetails = {
  kind: 'bank_account',
  accountNumber: '50100123456789',
  ifsc: 'HDFC0000123',
  accountType: 'savings',
  accountHolderName: 'Aarti Sharma',
}

describe('payout details', () => {
  it('accepts a well-formed bank account and UPI id', () => {
    expect(validatePayoutDetails(BANK)).toEqual([])
    expect(validatePayoutDetails({ kind: 'upi', vpa: 'aarti@okhdfcbank' })).toEqual([])
  })

  it('rejects a malformed IFSC', () => {
    expect(validatePayoutDetails({ ...BANK, ifsc: 'HDFC123' })).toContainEqual({
      field: 'ifsc',
      code: 'ifsc_invalid',
    })
  })

  it('rejects a non-numeric account number and a missing holder name', () => {
    const problems = validatePayoutDetails({ ...BANK, accountNumber: '50-100-123', accountHolderName: '  ' })
    expect(problems.map((p) => p.code)).toEqual(['account_number_invalid', 'account_holder_name_missing'])
  })

  it('rejects a malformed VPA', () => {
    expect(validatePayoutDetails({ kind: 'upi', vpa: 'not-a-vpa' })).toContainEqual({
      field: 'vpa',
      code: 'vpa_invalid',
    })
  })
})

describe('canonical details', () => {
  it('normalises casing and spacing the rail ignores too', () => {
    expect(canonicalDetails({ ...BANK, ifsc: 'hdfc0000123', accountHolderName: 'Aarti   Sharma ' }))
      .toBe(canonicalDetails(BANK))
  })

  it('distinguishes a UPI id from a bank account', () => {
    expect(canonicalDetails({ kind: 'upi', vpa: 'aarti@okhdfcbank' })).not.toBe(canonicalDetails(BANK))
  })

  it('is what normalisePayoutDetails produces, so storage and hashing agree', () => {
    const normalised = normalisePayoutDetails({ ...BANK, ifsc: 'hdfc0000123' })
    expect(canonicalDetails(normalised)).toBe(canonicalDetails(BANK))
  })
})

describe('destination fingerprint (the port contract)', () => {
  const fp = testFingerprinter()

  it('is stable for the same details in the same scope', () => {
    expect(fp.fingerprint(WS, BANK)).toBe(fp.fingerprint(WS, { ...BANK }))
  })

  it('ignores casing and spacing that the rail ignores too', () => {
    expect(
      detailsChanged(fp, WS, BANK, { ...BANK, ifsc: 'hdfc0000123', accountHolderName: 'Aarti   Sharma ' }),
    ).toBe(false)
  })

  it('changes when any payout detail changes', () => {
    expect(detailsChanged(fp, WS, BANK, { ...BANK, accountNumber: '50100123456780' })).toBe(true)
    expect(detailsChanged(fp, WS, BANK, { ...BANK, accountType: 'current' })).toBe(true)
    expect(detailsChanged(fp, WS, BANK, { ...BANK, accountHolderName: 'Aarti Verma' })).toBe(true)
  })

  it('differs across workspaces and environments for identical details', () => {
    const live = fp.fingerprint(WS, BANK)
    expect(fp.fingerprint({ workspaceId: 'ws_b', environment: 'live' }, BANK)).not.toBe(live)
    expect(fp.fingerprint({ workspaceId: 'ws_a', environment: 'sandbox' }, BANK)).not.toBe(live)
  })

  it('is not reproducible without the key', () => {
    // The point of keying it: holding the column and the canonical details is
    // not enough to confirm a guess.
    expect(testFingerprinter('another-secret').fingerprint(WS, BANK)).not.toBe(fp.fingerprint(WS, BANK))
  })
})

describe('masking', () => {
  it('keeps only the last four digits', () => {
    expect(maskAccountNumber('50100123456789')).toBe('6789')
  })

  it('never renders a full account number in a summary', () => {
    const summary = destinationSummary({
      kind: 'bank_account',
      ifsc: 'HDFC0000123',
      accountNumberLast4: '6789',
    })
    expect(summary).toBe('HDFC •••• 6789')
    expect(summary).not.toContain('50100123456789')
  })
})

describe('version verification', () => {
  it('a new version always starts unverified', () => {
    expect(INITIAL_VERSION_VERIFICATION).toBe('unverified')
  })

  it('only a verified status counts as verified', () => {
    for (const status of ['unverified', 'verifying', 'failed'] as const) {
      expect(
        isVersionVerified({
          destinationVersionId: 'dvr_1',
          status,
          method: null,
          nameMatchScore: null,
          verifiedAt: null,
        }),
      ).toBe(false)
    }
    expect(isVersionVerified(null)).toBe(false)
    expect(
      isVersionVerified({
        destinationVersionId: 'dvr_1',
        status: 'verified',
        method: 'penny_drop',
        nameMatchScore: 96,
        verifiedAt: new Date(0),
      }),
    ).toBe(true)
  })

})

describe('beneficiary identity', () => {
  it('requires a display name, and a legal name for businesses', () => {
    expect(
      validateBeneficiaryIdentity({ displayName: '', type: 'individual', country: 'IN' }).map((p) => p.code),
    ).toEqual(['display_name_missing'])
    expect(
      validateBeneficiaryIdentity({ displayName: 'Acme', type: 'business', country: 'IN' }).map((p) => p.code),
    ).toEqual(['legal_name_required_for_business'])
  })

  it('validates PAN shape when present, and allows it to be absent', () => {
    expect(
      validateBeneficiaryIdentity({ displayName: 'A', type: 'individual', country: 'IN', taxId: 'ABCDE1234F' }),
    ).toEqual([])
    expect(
      validateBeneficiaryIdentity({ displayName: 'A', type: 'individual', country: 'IN', taxId: 'NOPE' }).map(
        (p) => p.code,
      ),
    ).toEqual(['tax_id_invalid'])
    expect(validateBeneficiaryIdentity({ displayName: 'A', type: 'individual', country: 'IN' })).toEqual([])
  })
})

describe('derived beneficiary status', () => {
  const base = { disabled: false, rejected: false, destinationCount: 1, anyCurrentVersionVerified: false }

  it('is draft with no destinations', () => {
    expect(deriveBeneficiaryStatus({ ...base, destinationCount: 0 })).toBe('draft')
  })

  it('is verified when a current version is verified', () => {
    expect(deriveBeneficiaryStatus({ ...base, anyCurrentVersionVerified: true })).toBe('verified')
  })

  it('is pending while nothing is verified yet', () => {
    expect(deriveBeneficiaryStatus(base)).toBe('pending_verification')
  })

  it('disabled and rejected outrank everything', () => {
    expect(deriveBeneficiaryStatus({ ...base, anyCurrentVersionVerified: true, disabled: true })).toBe('disabled')
    expect(deriveBeneficiaryStatus({ ...base, anyCurrentVersionVerified: true, rejected: true })).toBe('rejected')
  })

  it('a failed verification does not reject the beneficiary', () => {
    // A failed penny drop is a fixable detail problem, not a compliance
    // decision — the requirement points at the edit, not at support.
    expect(deriveBeneficiaryStatus(base)).not.toBe('rejected')
  })
})

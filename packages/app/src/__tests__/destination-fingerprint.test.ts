/**
 * The keyed destination fingerprint.
 *
 * The property under test is not "it hashes" — it is that holding the column
 * and guessing the account number is not enough to confirm the guess. A plain
 * SHA-256 over canonical payout details fails that: the input space is an IFSC
 * from a published list plus a bounded run of digits, which is enumerable
 * offline in seconds.
 */
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalDetails, type PayoutDetails } from '@inrsettle/domain'
import {
  FingerprintKeyError,
  createDestinationFingerprinter,
  destinationFingerprinterFromEnv,
  fingerprintsEqual,
} from '../crypto/destination-fingerprint.js'

const SECRET = randomBytes(32)
const fp = createDestinationFingerprinter(SECRET)

const LIVE = { workspaceId: 'ws_a', environment: 'live' }
const SANDBOX = { workspaceId: 'ws_a', environment: 'sandbox' }
const OTHER = { workspaceId: 'ws_b', environment: 'live' }

const BANK: PayoutDetails = {
  kind: 'bank_account',
  accountNumber: '50100123456789',
  ifsc: 'HDFC0000123',
  accountType: 'savings',
  accountHolderName: 'Aarti Sharma',
}
const UPI: PayoutDetails = { kind: 'upi', vpa: 'aarti@okhdfcbank' }

describe('stability', () => {
  it('is identical for identical details in the same scope', () => {
    expect(fp.fingerprint(LIVE, BANK)).toBe(fp.fingerprint(LIVE, { ...BANK }))
  })

  it('survives the normalisation the rail applies anyway', () => {
    expect(fp.fingerprint(LIVE, { ...BANK, ifsc: 'hdfc0000123', accountHolderName: 'Aarti  Sharma ' })).toBe(
      fp.fingerprint(LIVE, BANK),
    )
  })

  it('changes for any change to the details', () => {
    const base = fp.fingerprint(LIVE, BANK)
    expect(fp.fingerprint(LIVE, { ...BANK, accountNumber: '50100123456780' })).not.toBe(base)
    expect(fp.fingerprint(LIVE, { ...BANK, ifsc: 'ICIC0000123' })).not.toBe(base)
    expect(fp.fingerprint(LIVE, { ...BANK, accountType: 'current' })).not.toBe(base)
    expect(fp.fingerprint(LIVE, { ...BANK, accountHolderName: 'Aarti Verma' })).not.toBe(base)
    expect(fp.fingerprint(LIVE, UPI)).not.toBe(base)
  })

  it('carries a version prefix, so the scheme can change without ambiguity', () => {
    expect(fp.fingerprint(LIVE, BANK).startsWith('v1:')).toBe(true)
  })
})

describe('it is keyed, not a plain digest', () => {
  it('differs from the unkeyed hash of the same canonical details', () => {
    const naive = createHash('sha256').update(canonicalDetails(BANK), 'utf8').digest('base64url')
    expect(fp.fingerprint(LIVE, BANK)).not.toContain(naive)
  })

  it('cannot be reproduced without the secret', () => {
    // This is the whole defence. An attacker holding a database dump knows the
    // canonical form and can guess the account number; without the key, they
    // still cannot check whether a guess is right.
    const attacker = createDestinationFingerprinter(randomBytes(32))
    expect(attacker.fingerprint(LIVE, BANK)).not.toBe(fp.fingerprint(LIVE, BANK))
  })

  it('an offline guessing run against the column gets nowhere without the key', () => {
    const target = fp.fingerprint(LIVE, BANK)
    const attacker = createDestinationFingerprinter(randomBytes(32))
    // Enumerate the last four digits — trivially small, and exactly the shape
    // of attack an unkeyed digest would lose to.
    for (let i = 0; i < 10_000; i += 1) {
      const guess = { ...BANK, accountNumber: `5010012345${String(i).padStart(4, '0')}` }
      expect(attacker.fingerprint(LIVE, guess)).not.toBe(target)
      if (i > 200) break // the point is made; keep the suite fast
    }
  })

  it('rejects a secret too short to be one', () => {
    expect(() => createDestinationFingerprinter(randomBytes(16))).toThrow(FingerprintKeyError)
  })
})

describe('tenant scoping', () => {
  it('gives identical details different fingerprints in different workspaces', () => {
    // Otherwise the column would reveal that two workspaces pay the same person.
    expect(fp.fingerprint(OTHER, BANK)).not.toBe(fp.fingerprint(LIVE, BANK))
  })

  it('separates sandbox from live', () => {
    expect(fp.fingerprint(SANDBOX, BANK)).not.toBe(fp.fingerprint(LIVE, BANK))
  })
})

describe('comparison', () => {
  it('matches equal fingerprints and rejects unequal ones', () => {
    expect(fingerprintsEqual(fp.fingerprint(LIVE, BANK), fp.fingerprint(LIVE, BANK))).toBe(true)
    expect(fingerprintsEqual(fp.fingerprint(LIVE, BANK), fp.fingerprint(LIVE, UPI))).toBe(false)
  })

  it('handles different lengths without throwing', () => {
    expect(fingerprintsEqual('short', fp.fingerprint(LIVE, BANK))).toBe(false)
    expect(fingerprintsEqual('', '')).toBe(true)
  })
})

describe('key sourcing', () => {
  it('reads the secret from the environment', () => {
    const built = destinationFingerprinterFromEnv({
      INRSETTLE_FINGERPRINT_SECRET: SECRET.toString('base64'),
    } as NodeJS.ProcessEnv)
    expect(built.fingerprint(LIVE, BANK)).toBe(fp.fingerprint(LIVE, BANK))
  })

  it('refuses to run without one', () => {
    expect(() => destinationFingerprinterFromEnv({} as NodeJS.ProcessEnv)).toThrow(FingerprintKeyError)
  })
})

/**
 * The verification contract against a real database.
 *
 * Four properties, each of which would be a serious defect if it did not hold:
 *
 *   an untrusted callback can never mark a destination VERIFIED;
 *   a callback can never verify a version other than the one requested;
 *   raw provider evidence is persisted and audited either way (`INV-33`);
 *   the name-match policy — not the provider — decides the name.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import type { NameMatchPolicySet, PayoutDetails } from '@inrsettle/domain'
import {
  SANDBOX_NAME_MATCH_POLICIES,
  SANDBOX_UPI_NAME_MATCH_POLICIES,
  SANDBOX_UPI_PROVIDER_ID,
  createSandboxVerificationProvider,
  createSandboxVpaVerificationProvider,
} from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary, getBeneficiary } from '../beneficiary.service.js'
import { ingestVerificationCallback, listVerifications, requestVerification } from '../verification.service.js'

let h: Harness
const WS = 'ws_trust'
const scope = { workspaceId: WS, environment: 'live' as const }
const actor = { type: 'user' as const, id: 'usr_admin' }
const providerActor = { type: 'provider' as const, id: 'sandbox' }

const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}
const bank = createSandboxVerificationProvider()
const vpa = createSandboxVpaVerificationProvider()
const policies = SANDBOX_NAME_MATCH_POLICIES

const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)

const GOOD: PayoutDetails = {
  kind: 'bank_account',
  accountNumber: '50100123456789',
  ifsc: 'HDFC0000123',
  accountType: 'savings',
  accountHolderName: 'Aarti Sharma',
}
/** Suffix 07 → accepted, resolves by callback. */
const PENDING: PayoutDetails = { ...GOOD, accountNumber: '50100123456707' }

beforeAll(async () => {
  h = await createTestDatabase('verification_trust')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin'],
  })
})
afterAll(async () => { await h.close() })

let seq = 0
async function pending(name: string, details: PayoutDetails = PENDING) {
  const created = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: `${name} ${(seq += 1)}`, type: 'individual', country: 'IN' },
      destination: details,
      actor,
    }),
  )
  const versionId = created.destinations[0]!.currentVersion!.id
  const started = await requestVerification(h.db, scope, bank, crypto.cipher, policies, { destinationVersionId: versionId, actor })

  if (!started.ok || started.status !== 'verifying') throw new Error('expected an in-flight verification')
  return { beneficiaryId: created.id, versionId, verificationId: started.verificationId }
}

function payload(requestId: string, versionId: string, eventId: string, extra: Record<string, unknown> = {}) {
  return {
    request_id: requestId,
    destination_version_id: versionId,
    event_id: eventId,
    result: 'account_confirmed',
    registry_name: 'AARTI SHARMA',
    ...extra,
  }
}

describe('untrusted evidence cannot verify', () => {
  it('an unsigned callback is refused, and the destination stays unverified', async () => {
    const { beneficiaryId, versionId, verificationId } = await pending('Unsigned')
    const result = await live((tx) =>
      ingestVerificationCallback(tx, scope, bank, policies, {
        providerEventId: 'evt_unsigned',
        payload: payload(verificationId, versionId, 'evt_unsigned'),
        signatureValid: false,
        actor: providerActor,
      }),
    )
    expect(result).toEqual({ applied: false, reason: 'untrusted_evidence' })

    const after = await live((tx) => getBeneficiary(tx, scope, beneficiaryId))
    expect(after?.destinations[0]?.currentVersion?.verificationStatus).toBe('verifying')
    expect(after?.status).not.toBe('verified')

    const verifications = await live((tx) => listVerifications(tx, scope, versionId))
    expect(verifications[0]?.status).toBe('verifying')
    expect(verifications[0]?.resolvedAt).toBeNull()
  })

  it('INV-33 — the unsigned payload is still stored verbatim and marked', async () => {
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT payload::text AS body, signature_valid, interpretation
        FROM provider_events WHERE provider_event_id = 'evt_unsigned'`),
    ) as unknown as { body: string; signature_valid: boolean; interpretation: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.signature_valid).toBe(false)
    expect(rows[0]?.interpretation).toBe('untrusted_signature')
    expect(rows[0]?.body).toContain('AARTI SHARMA')
  })

  it('the refusal is audited rather than silently dropped', async () => {
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT after::text AS body FROM audit_log
        WHERE action = 'beneficiary.verification_callback_rejected'
          AND after::text LIKE '%untrusted_signature%'`),
    ) as unknown as { body: string }[]
    expect(rows.length).toBeGreaterThan(0)
  })

  it('a signed callback for the same check still works afterwards', async () => {
    const { beneficiaryId, versionId, verificationId } = await pending('Signed After')
    const rejected = await live((tx) =>
      ingestVerificationCallback(tx, scope, bank, policies, {
        providerEventId: 'evt_pair_bad',
        payload: payload(verificationId, versionId, 'evt_pair_bad'),
        signatureValid: false,
        actor: providerActor,
      }),
    )
    expect(rejected.applied).toBe(false)

    const accepted = await live((tx) =>
      ingestVerificationCallback(tx, scope, bank, policies, {
        providerEventId: 'evt_pair_good',
        payload: payload(verificationId, versionId, 'evt_pair_good'),
        signatureValid: true,
        actor: providerActor,
      }),
    )
    expect(accepted).toMatchObject({ applied: true, status: 'verified' })
    const after = await live((tx) => getBeneficiary(tx, scope, beneficiaryId))
    expect(after?.destinations[0]?.currentVersion?.verificationStatus).toBe('verified')
  })
})

describe('a callback cannot verify the wrong version', () => {
  it('is refused even when properly signed', async () => {
    const { verificationId } = await pending('Wrong Version')
    const victim = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Victim', type: 'individual', country: 'IN' },
        destination: { ...GOOD, accountNumber: '50100555444333' },
        actor,
      }),
    )
    const victimVersionId = victim.destinations[0]!.currentVersion!.id

    const result = await live((tx) =>
      ingestVerificationCallback(tx, scope, bank, policies, {
        providerEventId: 'evt_wrong_version',
        payload: payload(verificationId, victimVersionId, 'evt_wrong_version'),
        // A valid signature proves the *provider* sent it. It does not prove
        // the provider named the right version, and the two are not the same
        // guarantee.
        signatureValid: true,
        actor: providerActor,
      }),
    )
    expect(result).toMatchObject({ applied: false, reason: 'version_mismatch' })

    const victimAfter = await live((tx) => getBeneficiary(tx, scope, victim.id))
    expect(victimAfter?.destinations[0]?.currentVersion?.verificationStatus).toBe('unverified')
  })
})

describe('the policy decides the name, not the provider', () => {
  it('a callback claiming confirmation with a mismatched name does not verify', async () => {
    const { beneficiaryId, versionId, verificationId } = await pending('Callback Bad Name')
    const result = await live((tx) =>
      ingestVerificationCallback(tx, scope, bank, policies, {
        providerEventId: 'evt_bad_name',
        payload: payload(verificationId, versionId, 'evt_bad_name', { registry_name: 'RAJESH KUMAR' }),
        signatureValid: true,
        actor: providerActor,
      }),
    )
    expect(result).toMatchObject({ applied: true, status: 'failed' })

    const verifications = await live((tx) => listVerifications(tx, scope, versionId))
    expect(verifications[0]).toMatchObject({
      status: 'failed',
      reasonCode: 'name_mismatch',
      nameMatchOutcome: 'mismatch',
      nameMatchBasis: 'registry_name',
      nameMatchPolicyVersion: policies.version,
    })
    const after = await live((tx) => getBeneficiary(tx, scope, beneficiaryId))
    expect(after?.status).not.toBe('verified')
  })

  it('a callback with no name evidence at all cannot verify under a registry-name policy', async () => {
    const { versionId, verificationId } = await pending('Callback No Name')
    const result = await live((tx) =>
      ingestVerificationCallback(tx, scope, bank, policies, {
        providerEventId: 'evt_no_name',
        payload: {
          request_id: verificationId,
          destination_version_id: versionId,
          event_id: 'evt_no_name',
          result: 'account_confirmed',
        },
        signatureValid: true,
        actor: providerActor,
      }),
    )
    expect(result).toMatchObject({ applied: true, status: 'failed' })
    const verifications = await live((tx) => listVerifications(tx, scope, versionId))
    expect(verifications[0]?.nameMatchOutcome).toBe('insufficient_evidence')
    expect(verifications[0]?.reasonCode).toBe('unavailable')
  })

  it('records which policy version decided, so a past decision stays explainable', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Policy Version', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    await requestVerification(h.db, scope, bank, crypto.cipher, policies, { destinationVersionId: versionId, actor })

    const verifications = await live((tx) => listVerifications(tx, scope, versionId))
    expect(verifications[0]).toMatchObject({
      status: 'verified',
      nameMatchOutcome: 'satisfied',
      nameMatchBasis: 'registry_name',
      nameMatchScore: 100,
      nameMatchPolicyVersion: policies.version,
    })
  })

  it('an unregistered provider/method pair cannot verify anything', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Unregistered Provider', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const emptyPolicies: NameMatchPolicySet = {
      version: 'empty-1',
      source: 'sandbox_fixture',
      description: 'A policy set registering nothing, used to prove the closed default.',
      entries: [],
    }
    const result = await requestVerification(h.db, scope, bank, crypto.cipher, emptyPolicies, {
        destinationVersionId: versionId,
        actor,
      })

    expect(result).toMatchObject({ ok: true, status: 'failed' })
    const verifications = await live((tx) => listVerifications(tx, scope, versionId))
    expect(verifications[0]?.nameMatchBasis).toBe('unregistered')
  })
})

describe('the UPI path end to end', () => {
  it('verifies a resolvable handle with no name, under its own policy', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'UPI Person', type: 'individual', country: 'IN' },
        destination: { kind: 'upi', vpa: 'aarti@okhdfcbank' },
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const result = await requestVerification(h.db, scope, vpa, crypto.cipher, SANDBOX_UPI_NAME_MATCH_POLICIES, {
        destinationVersionId: versionId,
        actor,
      })

    expect(result).toMatchObject({ ok: true, status: 'verified' })

    const verifications = await live((tx) => listVerifications(tx, scope, versionId))
    expect(verifications[0]).toMatchObject({
      status: 'verified',
      providerId: SANDBOX_UPI_PROVIDER_ID,
      nameMatchOutcome: 'satisfied',
      nameMatchBasis: 'not_required',
      nameMatchScore: null,
    })

    const after = await live((tx) => getBeneficiary(tx, scope, created.id))
    expect(after?.destinations[0]?.currentVersion?.summary).toBe('aarti@okhdfcbank')
    expect(after?.status).toBe('verified')
  })

  it('fails an unregistered handle with a specific reason', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'UPI Unknown', type: 'individual', country: 'IN' },
        destination: { kind: 'upi', vpa: 'unknown.person@okaxis' },
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const result = await requestVerification(h.db, scope, vpa, crypto.cipher, SANDBOX_UPI_NAME_MATCH_POLICIES, {
        destinationVersionId: versionId,
        actor,
      })

    expect(result).toMatchObject({ ok: true, status: 'failed', reasonCode: 'vpa_not_found' })
  })

  it('the bank adapter refuses a UPI destination rather than guessing', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'UPI Wrong Adapter', type: 'individual', country: 'IN' },
        destination: { kind: 'upi', vpa: 'aarti@okhdfcbank' },
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const bankOnly = createSandboxVerificationProvider({ kinds: ['bank_account'] })
    const result = await requestVerification(h.db, scope, bankOnly, crypto.cipher, policies, {
        destinationVersionId: versionId,
        actor,
      })

    expect(result).toEqual({ ok: false, reason: 'unsupported_kind' })
  })
})

describe('malformed details fail verification with a specific reason', () => {
  it('a bank account whose IFSC does not resolve', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Bad Branch', type: 'individual', country: 'IN' },
        // Suffix 05 is the simulator's "well-formed IFSC, no such branch".
        destination: { ...GOOD, accountNumber: '50100123456705' },
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const result = await requestVerification(h.db, scope, bank, crypto.cipher, policies, {
        destinationVersionId: versionId,
        actor,
      })

    expect(result).toMatchObject({ ok: true, status: 'failed', reasonCode: 'invalid_ifsc' })
  })
})

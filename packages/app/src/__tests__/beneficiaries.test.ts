/**
 * Stage 2 exit criteria that only a real database can demonstrate:
 * append-only versions, version-specific verification, masking, isolation and
 * audit. These run as `inrsettle_app` against real RLS.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import type { PayoutDetails } from '@inrsettle/domain'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import {
  BeneficiaryError,
  addPayoutDestination,
  createBeneficiary,
  editPayoutDestination,
  getBeneficiary,
  listBeneficiaries,
  listDestinationVersions,
} from '../beneficiary.service.js'
import { ingestVerificationCallback, listVerifications, requestVerification } from '../verification.service.js'

let h: Harness
const WS = 'ws_ben'
const OTHER = 'ws_other'
const scope = { workspaceId: WS, environment: 'live' as const }
const sandboxScope = { workspaceId: WS, environment: 'sandbox' as const }
const otherScope = { workspaceId: OTHER, environment: 'live' as const }
const actor = { type: 'user' as const, id: 'usr_admin' }

const cipher = createFieldCipher({
  activeKeyId: 'k1',
  keks: { k1: randomBytes(32), k0: randomBytes(32) },
})
const fingerprinter = createDestinationFingerprinter(randomBytes(32))
const crypto = { cipher, fingerprinter }
const provider = createSandboxVerificationProvider()
const policies = SANDBOX_NAME_MATCH_POLICIES

const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)
const sandbox = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, sandboxScope, fn)
const other = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, otherScope, fn)

/** Verifies successfully in the simulator (no scenario suffix). */
const GOOD: PayoutDetails = {
  kind: 'bank_account',
  accountNumber: '50100123456789',
  ifsc: 'HDFC0000123',
  accountType: 'savings',
  accountHolderName: 'Aarti Sharma',
}
/** Suffix 04 → name mismatch. */
const MISMATCH: PayoutDetails = { ...GOOD, accountNumber: '50100123456704' }
/** Suffix 07 → accepted, resolves by callback. */
const PENDING: PayoutDetails = { ...GOOD, accountNumber: '50100123456707' }

beforeAll(async () => {
  h = await createTestDatabase('beneficiaries')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin'],
  })
  await seedWorkspace(h.admin, {
    workspaceId: OTHER, userId: 'usr_other', email: 'o@example.test', roles: ['admin'],
  })
})
afterAll(async () => { await h.close() })

describe('creating a beneficiary', () => {
  it('stores it, derives its status and emits an audit record and an event', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN', taxId: 'ABCDE1234F' },
        actor,
      }),
    )
    expect(created.status).toBe('draft')
    expect(created.destinations).toEqual([])
    // PAN is stored encrypted; only the last four are readable.
    expect(created.taxIdLast4).toBe('234F')
    expect(created.hasTaxId).toBe(true)

    const [audit] = await live((tx) =>
      tx.execute(sql`SELECT action, after FROM audit_log WHERE subject_id = ${created.id}`),
    ) as unknown as { action: string; after: Record<string, unknown> }[]
    expect(audit?.action).toBe('beneficiary.created')

    const events = await live((tx) =>
      tx.execute(sql`SELECT type FROM events WHERE subject_id = ${created.id}`),
    ) as unknown as { type: string }[]
    expect(events.map((e) => e.type)).toContain('beneficiary.created')
  })

  it('refuses incomplete identity with field problems, not a generic error', async () => {
    await expect(
      live((tx) =>
        createBeneficiary(tx, scope, crypto, {
          identity: { displayName: 'Acme', type: 'business', country: 'IN' },
          actor,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_identity',
      problems: [{ field: 'legalName', code: 'legal_name_required_for_business' }],
    })
  })

  it('a second destination does not displace the first as default', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Two Destinations', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const firstId = created.destinations[0]!.id

    const second = await live((tx) =>
      addPayoutDestination(tx, scope, crypto, {
        beneficiaryId: created.id,
        details: { kind: 'upi', vpa: 'aarti@okhdfcbank' },
        actor,
      }),
    )
    expect(second.kind).toBe('upi')
    expect(second.currentVersion?.versionNumber).toBe(1)
    expect(second.currentVersion?.verificationStatus).toBe('unverified')

    const after = await live((tx) => getBeneficiary(tx, scope, created.id))
    expect(after?.destinations).toHaveLength(2)
    // Adding a destination is not a silent change of where money goes.
    expect(after?.defaultDestinationId).toBe(firstId)
  })

  it('creates the first destination alongside the beneficiary and makes it the default', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Ravi Menon', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    expect(created.destinations).toHaveLength(1)
    expect(created.defaultDestinationId).toBe(created.destinations[0]?.id)
    expect(created.destinations[0]?.currentVersion?.versionNumber).toBe(1)
    expect(created.destinations[0]?.currentVersion?.verificationStatus).toBe('unverified')
    expect(created.status).toBe('pending_verification')
  })
})

describe('INV-12 — account numbers never appear in the clear', () => {
  it('stores ciphertext plus last four, and the read model has no account number', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Masking Test', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const version = created.destinations[0]!.currentVersion!
    expect(version.accountNumberLast4).toBe('6789')
    expect(version.summary).toBe('HDFC •••• 6789')
    expect(JSON.stringify(created)).not.toContain('50100123456789')

    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT account_number_ciphertext, account_number_last4
        FROM payout_destination_versions WHERE id = ${version.id}`),
    ) as unknown as { account_number_ciphertext: string; account_number_last4: string }[]
    expect(rows[0]?.account_number_last4).toBe('6789')
    expect(rows[0]?.account_number_ciphertext).not.toContain('50100123456789')
    expect(rows[0]?.account_number_ciphertext.startsWith('v1.k1.')).toBe(true)
  })

  it('no audit record or event payload anywhere contains a full account number', async () => {
    const leaks = await live((tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM (
          SELECT before::text AS body FROM audit_log
          UNION ALL SELECT after::text FROM audit_log
          UNION ALL SELECT payload::text FROM events
        ) t WHERE t.body LIKE '%50100123456%'`),
    ) as unknown as { n: number }[]
    expect(leaks[0]?.n).toBe(0)
  })
})

describe('INV-44 — editing appends a version and never mutates one', () => {
  it('creates a new unverified version and supersedes the old one, which keeps its verification', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Edit Test', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const destinationId = created.destinations[0]!.id
    const v1 = created.destinations[0]!.currentVersion!

    await requestVerification(h.db, scope, provider, cipher, policies, {
      destinationVersionId: v1.id, actor,
    })
    const afterVerify = await live((tx) => getBeneficiary(tx, scope, created.id))
    expect(afterVerify?.destinations[0]?.currentVersion?.verificationStatus).toBe('verified')
    expect(afterVerify?.status).toBe('verified')

    const edited = await live((tx) =>
      editPayoutDestination(tx, scope, crypto, {
        destinationId,
        details: { ...GOOD, accountNumber: '50100999888777' },
        actor,
      }),
    )
    expect(edited.versionCreated).toBe(true)
    const v2 = edited.destination.currentVersion!
    expect(v2.versionNumber).toBe(2)
    expect(v2.id).not.toBe(v1.id)
    // The new version starts unverified — this is the whole point.
    expect(v2.verificationStatus).toBe('unverified')
    expect(v2.accountNumberLast4).toBe('8777')

    // The old version is untouched apart from being superseded, and keeps its
    // own verified status and timestamp.
    const history = await live((tx) => listDestinationVersions(tx, scope, destinationId))
    const previous = history.find((v) => v.id === v1.id)!
    expect(previous.verificationStatus).toBe('verified')
    expect(previous.verifiedAt).toBeInstanceOf(Date)
    expect(previous.supersededAt).toBeInstanceOf(Date)
    expect(previous.accountNumberLast4).toBe('6789')

    // And the beneficiary is no longer verified, because its *current* version
    // is not.
    const after = await live((tx) => getBeneficiary(tx, scope, created.id))
    expect(after?.status).toBe('pending_verification')
  })

  it('a save that changes nothing creates no version and does not un-verify', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'No-op Test', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const destinationId = created.destinations[0]!.id
    await requestVerification(h.db, scope, provider, cipher, policies, {
      destinationVersionId: created.destinations[0]!.currentVersion!.id, actor,
    })

    // Same details, different casing and spacing — the rail would treat these
    // as identical, so we must too.
    const result = await live((tx) =>
      editPayoutDestination(tx, scope, crypto, {
        destinationId,
        details: { ...GOOD, ifsc: 'hdfc0000123', accountHolderName: 'Aarti  Sharma ' },
        actor,
      }),
    )
    expect(result.versionCreated).toBe(false)
    expect(result.destination.currentVersion?.versionNumber).toBe(1)
    expect(result.destination.currentVersion?.verificationStatus).toBe('verified')
  })

  it('the database refuses to mutate a version even if application code tries', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Trigger Test', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id

    await expect(
      live((tx) =>
        tx.execute(sql`
          UPDATE payout_destination_versions SET account_number_last4 = '0000' WHERE id = ${versionId}`),
      ),
    ).rejects.toThrow(/append-only/)

    await expect(
      live((tx) =>
        tx.execute(sql`UPDATE payout_destination_versions SET ifsc = 'ICIC0000001' WHERE id = ${versionId}`),
      ),
    ).rejects.toThrow(/append-only/)
  })

  it('a version cannot be deleted at all', async () => {
    await expect(
      live((tx) => tx.execute(sql`DELETE FROM payout_destination_versions`)),
    ).rejects.toThrow(/permission denied/i)
  })

  it('refuses to turn a bank account into a UPI id under the same destination', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Kind Test', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    await expect(
      live((tx) =>
        editPayoutDestination(tx, scope, crypto, {
          destinationId: created.destinations[0]!.id,
          details: { kind: 'upi', vpa: 'someone@okaxis' },
          actor,
        }),
      ),
    ).rejects.toBeInstanceOf(BeneficiaryError)
  })
})

describe('INV-45 — verification belongs to a version', () => {
  it('records the version it checked, not the destination', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Version Bind', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const result = await requestVerification(h.db, scope, provider, cipher, policies, { destinationVersionId: versionId, actor })

    expect(result).toMatchObject({ ok: true, status: 'verified' })

    const verifications = await live((tx) => listVerifications(tx, scope, versionId))
    expect(verifications).toHaveLength(1)
    expect(verifications[0]?.destinationVersionId).toBe(versionId)
    expect(verifications[0]?.nameMatchScore).toBe(100)
  })

  it('a failed check records a specific reason, and the version stays unverified', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Mismatch Test', type: 'individual', country: 'IN' },
        destination: MISMATCH,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const result = await requestVerification(h.db, scope, provider, cipher, policies, { destinationVersionId: versionId, actor })

    expect(result).toMatchObject({ ok: true, status: 'failed', reasonCode: 'name_mismatch' })

    const after = await live((tx) => getBeneficiary(tx, scope, created.id))
    expect(after?.destinations[0]?.currentVersion?.verificationStatus).toBe('failed')
    // A failed rail check is not a rejected beneficiary.
    expect(after?.status).toBe('pending_verification')
  })

  it('refuses to verify a second time once verified', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Double Verify', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    await requestVerification(h.db, scope, provider, cipher, policies, { destinationVersionId: versionId, actor })
    const second = await requestVerification(h.db, scope, provider, cipher, policies, { destinationVersionId: versionId, actor })

    expect(second).toEqual({ ok: false, reason: 'already_verified' })
  })

  it('verifying a new version leaves the old version verified and untouched', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Two Versions', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const destinationId = created.destinations[0]!.id
    const v1Id = created.destinations[0]!.currentVersion!.id
    await requestVerification(h.db, scope, provider, cipher, policies, { destinationVersionId: v1Id, actor })

    const edited = await live((tx) =>
      editPayoutDestination(tx, scope, crypto, {
        destinationId, details: { ...GOOD, accountNumber: '50100123456704' }, actor,
      }),
    )
    const v2Id = edited.destination.currentVersion!.id
    await requestVerification(h.db, scope, provider, cipher, policies, { destinationVersionId: v2Id, actor })

    const history = await live((tx) => listDestinationVersions(tx, scope, destinationId))
    const v1 = history.find((v) => v.id === v1Id)!
    const v2 = history.find((v) => v.id === v2Id)!
    expect(v1.verificationStatus).toBe('verified')
    expect(v2.verificationStatus).toBe('failed')

    // Each verification names exactly one version.
    const all = await live((tx) =>
      tx.execute(sql`SELECT destination_version_id FROM destination_verifications`),
    ) as unknown as { destination_version_id: string }[]
    expect(new Set(all.map((r) => r.destination_version_id)).size).toBe(all.length)
  })
})

describe('provider callbacks', () => {
  async function pendingVersion(name: string): Promise<{ versionId: string; verificationId: string }> {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: name, type: 'individual', country: 'IN' },
        destination: PENDING,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const started = await requestVerification(h.db, scope, provider, cipher, policies, { destinationVersionId: versionId, actor })

    if (!started.ok) throw new Error('expected the pending scenario to start')
    expect(started.status).toBe('verifying')
    return { versionId, verificationId: started.verificationId }
  }

  it('applies a result to the version that was checked', async () => {
    const { versionId, verificationId } = await pendingVersion('Callback OK')
    const result = await live((tx) =>
      ingestVerificationCallback(tx, scope, provider, policies, {
        providerEventId: 'evt_cb_1',
        payload: {
          request_id: verificationId,
          destination_version_id: versionId,
          event_id: 'evt_cb_1',
          result: 'verified',
          name_match_score: 97,
          registry_name: 'AARTI SHARMA',
        },
        signatureValid: true,
        actor: { type: 'provider', id: 'sandbox' },
      }),
    )
    expect(result).toMatchObject({ applied: true, status: 'verified' })
  })

  it('cannot verify a different destination version than the one requested', async () => {
    const { verificationId } = await pendingVersion('Callback Mismatch')
    const victim = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Victim', type: 'individual', country: 'IN' },
        destination: { ...GOOD, accountNumber: '50100555444333' },
        actor,
      }),
    )
    const victimVersionId = victim.destinations[0]!.currentVersion!.id

    const result = await live((tx) =>
      ingestVerificationCallback(tx, scope, provider, policies, {
        providerEventId: 'evt_cb_evil',
        payload: {
          request_id: verificationId,
          // Points at someone else's version.
          destination_version_id: victimVersionId,
          event_id: 'evt_cb_evil',
          result: 'verified',
          name_match_score: 100,
        },
        signatureValid: true,
        actor: { type: 'provider', id: 'sandbox' },
      }),
    )
    expect(result).toMatchObject({ applied: false, reason: 'version_mismatch' })

    // The victim is untouched…
    const victimAfter = await live((tx) => getBeneficiary(tx, scope, victim.id))
    expect(victimAfter?.destinations[0]?.currentVersion?.verificationStatus).toBe('unverified')

    // …and the refusal is recorded rather than rolled back with the throw.
    const audits = await live((tx) =>
      tx.execute(sql`
        SELECT action FROM audit_log WHERE action = 'beneficiary.verification_callback_rejected'`),
    ) as unknown as { action: string }[]
    expect(audits.length).toBeGreaterThan(0)
  })

  it('a redelivered callback is a no-op', async () => {
    const { versionId, verificationId } = await pendingVersion('Callback Retry')
    const payload = {
      request_id: verificationId,
      destination_version_id: versionId,
      event_id: 'evt_cb_retry',
      result: 'failed',
      reason_code: 'account_closed',
    }
    const first = await live((tx) =>
      ingestVerificationCallback(tx, scope, provider, policies, {
        providerEventId: 'evt_cb_retry', payload, signatureValid: true,
        actor: { type: 'provider', id: 'sandbox' },
      }),
    )
    const second = await live((tx) =>
      ingestVerificationCallback(tx, scope, provider, policies, {
        providerEventId: 'evt_cb_retry', payload, signatureValid: true,
        actor: { type: 'provider', id: 'sandbox' },
      }),
    )
    expect(first).toMatchObject({ applied: true, status: 'failed' })
    expect(second).toEqual({ applied: false, reason: 'duplicate_event' })

    const verifications = await live((tx) => listVerifications(tx, scope, versionId))
    expect(verifications.filter((v) => v.status !== 'verifying')).toHaveLength(1)
  })

  it('INV-33 — a signed but uninterpretable payload is still stored, and does not throw', async () => {
    // Signed, so the trust gate lets it through to interpretation; the point
    // here is that a payload we cannot read is kept rather than discarded.
    // The unsigned case is a *different* refusal and is covered in
    // `verification-trust.test.ts`.
    const result = await live((tx) =>
      ingestVerificationCallback(tx, scope, provider, policies, {
        providerEventId: 'evt_junk',
        payload: { something: 'we have never seen', nested: { x: 1 } },
        signatureValid: true,
        actor: { type: 'provider', id: 'sandbox' },
      }),
    )
    expect(result).toEqual({ applied: false, reason: 'uninterpretable' })

    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT payload::text AS body, interpretation, signature_valid
        FROM provider_events WHERE provider_event_id = 'evt_junk'`),
    ) as unknown as { body: string; interpretation: string; signature_valid: boolean }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.interpretation).toBe('uninterpretable')
    expect(rows[0]?.body).toContain('we have never seen')
  })

  it('an unsigned payload is refused before it is even interpreted', async () => {
    const result = await live((tx) =>
      ingestVerificationCallback(tx, scope, provider, policies, {
        providerEventId: 'evt_junk_unsigned',
        payload: { something: 'we have never seen' },
        signatureValid: false,
        actor: { type: 'provider', id: 'sandbox' },
      }),
    )
    expect(result).toEqual({ applied: false, reason: 'untrusted_evidence' })
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT interpretation FROM provider_events WHERE provider_event_id = 'evt_junk_unsigned'`),
    ) as unknown as { interpretation: string }[]
    expect(rows[0]?.interpretation).toBe('untrusted_signature')
  })
})

describe('INV-31 — isolation', () => {
  it('another workspace cannot see these beneficiaries', async () => {
    const mine = await live((tx) => listBeneficiaries(tx, scope))
    expect(mine.length).toBeGreaterThan(0)
    const theirs = await other((tx) => listBeneficiaries(tx, otherScope))
    expect(theirs).toEqual([])
  })

  it('sandbox and live are separate even inside one workspace', async () => {
    const inSandbox = await sandbox((tx) => listBeneficiaries(tx, sandboxScope))
    expect(inSandbox).toEqual([])

    await sandbox((tx) =>
      createBeneficiary(tx, sandboxScope, crypto, {
        identity: { displayName: 'Sandbox Only', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const liveNames = (await live((tx) => listBeneficiaries(tx, scope))).map((b) => b.displayName)
    expect(liveNames).not.toContain('Sandbox Only')
    expect((await sandbox((tx) => listBeneficiaries(tx, sandboxScope)))).toHaveLength(1)
  })

  it('a destination version is invisible from the wrong environment', async () => {
    const rows = await sandbox((tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM payout_destination_versions`),
    ) as unknown as { n: number }[]
    // Exactly the one created in sandbox above.
    expect(rows[0]?.n).toBe(1)
  })

  it('ciphertext cannot be decrypted with a different tenant binding', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'AAD Test', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT account_number_ciphertext AS ct FROM payout_destination_versions WHERE id = ${versionId}`),
    ) as unknown as { ct: string }[]

    expect(() =>
      cipher.decrypt(rows[0]!.ct, {
        field: 'payout_destination_version.account_number',
        workspaceId: OTHER,
        environment: 'live',
      }),
    ).toThrow(/could not be decrypted/)
  })
})

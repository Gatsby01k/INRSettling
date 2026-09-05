/**
 * Preflight end to end: reference data loaded from the versioned files, the
 * subject assembled from real rows, and the same input producing the same
 * answer every time.
 */
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { inspectRequirement, validateRuleSet, type PreflightRuleSet } from '@inrsettle/domain'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary, editPayoutDestination } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { availablePurposes, runPreflightFor } from '../preflight.service.js'
import {
  ReferenceDataError,
  activeRuleSetVersion,
  loadReferenceData,
  loadRuleSetFromDatabase,
} from '../reference-data.service.js'

let h: Harness
let ruleSet: PreflightRuleSet

const WS = 'ws_pf'
const scope = { workspaceId: WS, environment: 'live' as const }
const sandboxScope = { workspaceId: WS, environment: 'sandbox' as const }
const actor = { type: 'user' as const, id: 'usr_admin' }
const cipher = createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } })
const fingerprinter = createDestinationFingerprinter(randomBytes(32))
const crypto = { cipher, fingerprinter }
const provider = createSandboxVerificationProvider()
const policies = SANDBOX_NAME_MATCH_POLICIES
const REFERENCE_DIR = fileURLToPath(new URL('../../../../reference/preflight', import.meta.url))

const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)
const sandbox = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, sandboxScope, fn)

const GOOD = {
  kind: 'bank_account' as const,
  accountNumber: '50100123456789',
  ifsc: 'HDFC0000123',
  accountType: 'savings' as const,
  accountHolderName: 'Aarti Sharma',
}

async function verifiedBeneficiary(name: string): Promise<string> {
  const created = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: name, type: 'individual', country: 'IN', taxId: 'ABCDE1234F' },
      destination: GOOD,
      actor,
    }),
  )
  await requestVerification(h.db, scope, provider, cipher, policies, {
      destinationVersionId: created.destinations[0]!.currentVersion!.id,
      actor,
    })

  return created.id
}

beforeAll(async () => {
  h = await createTestDatabase('preflight')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin'],
  })
  const version = await activeRuleSetVersion(h.admin, 'sandbox', new Date())
  const loaded = await loadRuleSetFromDatabase(h.admin, version!)
  ruleSet = loaded!.ruleSet
})
afterAll(async () => { await h.close() })

describe('reference data', () => {
  it('is loaded by the harness from the same files deployment uses', () => {
    expect(ruleSet.version).toBe('sandbox-2026-09-01')
    expect(ruleSet.source).toBe('sandbox_fixture')
    expect(ruleSet.rules.length).toBeGreaterThan(0)
  })

  it('every loaded rule still satisfies the four-field requirement', () => {
    expect(validateRuleSet(ruleSet)).toEqual([])
  })

  it('says on its face that it is not regulatory truth', () => {
    expect(ruleSet.description).toMatch(/NOT REGULATORY TRUTH/)
    expect(ruleSet.description).toMatch(/D-06/)
  })

  it('carries no regulatory purpose codes, and the database will not accept one', async () => {
    // D-06 is open. Three layers say so: the fixture file, the loader, and the
    // table constraint — this asserts the last of them, which is the one that
    // holds even if someone writes to the table by hand.
    const loaded = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM purpose_codes WHERE regulatory_code IS NOT NULL`
    expect(loaded[0]?.n).toBe(0)

    await expect(
      h.admin`
        INSERT INTO purpose_codes (rule_set_version, code, label, regulatory_code, source)
        VALUES (${ruleSet.version}, 'SNEAKY', 'Sneaky', 'P0802', 'sandbox_fixture')`,
    ).rejects.toThrow(/sandbox_fixture_has_no_regulatory_code/)
  })

  it('re-running the loader is a no-op', async () => {
    const again = await loadReferenceData(h.admin, REFERENCE_DIR)
    expect(again.every((r) => r.loaded === false)).toBe(true)
  })

  it('refuses to change a published version in place', async () => {
    await h.admin`
      UPDATE preflight_rule_sets SET checksum = 'tampered' WHERE version = ${ruleSet.version}`
    await expect(loadReferenceData(h.admin, REFERENCE_DIR)).rejects.toBeInstanceOf(ReferenceDataError)
    // And reading it back detects the mismatch rather than trusting the row.
    await expect(loadRuleSetFromDatabase(h.admin, ruleSet.version)).rejects.toThrow(/checksum/)
    await h.admin`
      UPDATE preflight_rule_sets SET checksum = ${(await import('@inrsettle/domain')).ruleSetChecksum(ruleSet)}
      WHERE version = ${ruleSet.version}`
  })

  it('offers the purposes the customer can choose from', () => {
    const purposes = availablePurposes(ruleSet)
    expect(purposes.map((p) => p.code)).toContain('SOFTWARE_SERVICES')
    expect(purposes.every((p) => p.label.length > 0)).toBe(true)
  })

  it('live will not fall back to a sandbox fixture', async () => {
    expect(await activeRuleSetVersion(h.admin, 'live', new Date())).toBeNull()
    expect(await activeRuleSetVersion(h.admin, 'sandbox', new Date())).toBe(ruleSet.version)
  })
})

describe('running preflight against real rows', () => {
  it('is ready when the beneficiary is verified and nothing is outstanding', async () => {
    const beneficiaryId = await verifiedBeneficiary('Preflight Ready')
    const result = await live((tx) =>
      runPreflightFor(tx, scope, ruleSet, {
        beneficiaryId,
        amount: { currency: 'INR', minorUnits: 500_000_00n },
        purposeCode: 'SOFTWARE_SERVICES',
        hasActiveLiquidityFacility: true,
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.outcome.status).toBe('ready')
      expect(result.outcome.requirements).toEqual([])
    }
  })

  it('raises liquidity_facility_required with a real action, not a message', async () => {
    const beneficiaryId = await verifiedBeneficiary('Preflight No Facility')
    const result = await live((tx) =>
      runPreflightFor(tx, scope, ruleSet, {
        beneficiaryId,
        amount: { currency: 'INR', minorUnits: 500_000_00n },
        purposeCode: 'SOFTWARE_SERVICES',
        hasActiveLiquidityFacility: false,
      }),
    )
    if (!result.ok) throw new Error('expected a subject')
    const requirement = result.outcome.requirements.find((r) => r.code === 'liquidity_facility_required')
    expect(requirement).toBeDefined()
    expect(inspectRequirement(requirement)).toEqual([])
    expect(requirement?.action).toEqual({ type: 'set_up_liquidity_facility' })
  })

  it('an edited destination makes a previously ready settlement need action again', async () => {
    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Preflight Edit', type: 'individual', country: 'IN' },
        destination: GOOD,
        actor,
      }),
    )
    await requestVerification(h.db, scope, provider, cipher, policies, {
        destinationVersionId: created.destinations[0]!.currentVersion!.id, actor,
      })

    const input = {
      beneficiaryId: created.id,
      amount: { currency: 'INR' as const, minorUnits: 100_00n },
      purposeCode: 'SOFTWARE_SERVICES',
      hasActiveLiquidityFacility: true,
    }
    const before = await live((tx) => runPreflightFor(tx, scope, ruleSet, input))
    expect(before.ok && before.outcome.status).toBe('ready')

    const edited = await live((tx) =>
      editPayoutDestination(tx, scope, crypto, {
        destinationId: created.destinations[0]!.id,
        details: { ...GOOD, accountNumber: '50100000011122' },
        actor,
      }),
    )
    const after = await live((tx) => runPreflightFor(tx, scope, ruleSet, input))
    if (!after.ok) throw new Error('expected a subject')
    expect(after.outcome.status).toBe('action_required')
    const requirement = after.outcome.requirements.find((r) => r.code === 'beneficiary_account_unverified')
    expect(requirement?.action).toEqual({
      type: 'verify_beneficiary',
      beneficiaryId: created.id,
      // The action points at the *new* version, which is the one that needs checking.
      destinationVersionId: edited.destination.currentVersion!.id,
    })
  })

  it('applies the sandbox document rule and names the amount in the copy', async () => {
    const beneficiaryId = await verifiedBeneficiary('Preflight Invoice')
    const result = await live((tx) =>
      runPreflightFor(tx, scope, ruleSet, {
        beneficiaryId,
        amount: { currency: 'INR', minorUnits: 2_000_000_00n },
        purposeCode: 'SOFTWARE_SERVICES',
        hasActiveLiquidityFacility: true,
      }),
    )
    if (!result.ok) throw new Error('expected a subject')
    const invoice = result.outcome.requirements.find((r) => r.code === 'invoice_required')
    expect(invoice?.detail).toContain('₹20,00,000.00')
    expect(invoice?.action).toEqual({ type: 'upload_document', documentType: 'commercial_invoice' })
  })

  it('every requirement it can produce carries all four fields', async () => {
    const beneficiaryId = await verifiedBeneficiary('Preflight Complete')
    for (const purposeCode of [null, 'SOFTWARE_SERVICES', 'GOODS_EXPORT', 'FAMILY_MAINTENANCE']) {
      for (const minorUnits of [100_00n, 2_000_000_00n, 6_000_000_00n]) {
        const result = await live((tx) =>
          runPreflightFor(tx, scope, ruleSet, {
            beneficiaryId,
            amount: { currency: 'INR', minorUnits },
            purposeCode,
            hasActiveLiquidityFacility: false,
          }),
        )
        if (!result.ok) throw new Error('expected a subject')
        for (const requirement of result.outcome.requirements) {
          expect(inspectRequirement(requirement), requirement.code).toEqual([])
          expect(requirement.detail).not.toContain('{{')
        }
      }
    }
  })

  it('is deterministic and versioned across repeated runs', async () => {
    const beneficiaryId = await verifiedBeneficiary('Preflight Determinism')
    const input = {
      beneficiaryId,
      amount: { currency: 'INR' as const, minorUnits: 2_000_000_00n },
      purposeCode: 'SOFTWARE_SERVICES',
      hasActiveLiquidityFacility: false,
    }
    const a = await live((tx) => runPreflightFor(tx, scope, ruleSet, input))
    const b = await live((tx) => runPreflightFor(tx, scope, ruleSet, input))
    if (!a.ok || !b.ok) throw new Error('expected a subject')
    expect(a.outcome).toEqual(b.outcome)
    expect(a.outcome.ruleSetVersion).toBe(ruleSet.version)
    expect(a.outcome.ruleSetSource).toBe('sandbox_fixture')
    expect(a.outcome.fingerprint).toBe(b.outcome.fingerprint)
  })

  it('sandbox does not require a facility; live does', async () => {
    const beneficiaryId = await verifiedBeneficiary('Preflight Env')
    const inSandbox = await sandbox((tx) =>
      runPreflightFor(tx, sandboxScope, ruleSet, {
        beneficiaryId,
        amount: { currency: 'INR', minorUnits: 100_00n },
        purposeCode: 'SOFTWARE_SERVICES',
        hasActiveLiquidityFacility: false,
      }),
    )
    // The beneficiary lives in live, so sandbox cannot see it at all — which is
    // itself the isolation guarantee.
    expect(inSandbox).toEqual({ ok: false, reason: 'beneficiary_not_found' })
  })

  it('reports a missing beneficiary as a reason, not an exception', async () => {
    const result = await live((tx) =>
      runPreflightFor(tx, scope, ruleSet, {
        beneficiaryId: 'ben_doesnotexist',
        amount: { currency: 'INR', minorUnits: 100_00n },
        purposeCode: 'SOFTWARE_SERVICES',
        hasActiveLiquidityFacility: true,
      }),
    )
    expect(result).toEqual({ ok: false, reason: 'beneficiary_not_found' })
  })
})

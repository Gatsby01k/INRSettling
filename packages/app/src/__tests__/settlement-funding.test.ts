/**
 * The funding leg end to end — T09–T14, T27, T28 against a real facility.
 *
 * Stage 3 answered `facility_active`, `sufficient_availability` and
 * `active_reservation_exists` from an explicit test harness, because the truth
 * belonged to a stage that did not exist yet. This file is that stage checking
 * its own work: every one of those guards is now answered from the database,
 * and the tests below are the ones that would have been impossible to write
 * before — a settlement refused because a facility really is short, a
 * cancellation compensated differently depending on whether funding moved.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedUser, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { money } from '@inrsettle/money'
import type { PreflightRuleSet } from '@inrsettle/domain'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { activeRuleSetVersion, loadRuleSetFromDatabase } from '../reference-data.service.js'
import { createQuote } from '../quote.service.js'
import { createSettlement } from '../settlement-transition.service.js'
import {
  attachQuote,
  authorizeSettlement,
  cancelSettlement,
  getSettlement,
  runSettlementPreflight,
} from '../settlement.service.js'
import { createFacility, listFacilities, readFacility } from '../liquidity.service.js'
import {
  compensateCancellation,
  requestDrawdown,
  reserveForSettlement,
  resolveDrawdown,
} from '../settlement-liquidity.service.js'

let h: Harness
let ruleSet: PreflightRuleSet
const WS = 'ws_funding'
const scope = { workspaceId: WS, environment: 'sandbox' as const }
const creator = { type: 'user' as const, id: 'usr_creator' }
const approver = { type: 'user' as const, id: 'usr_approver' }
const ROLES = ['admin', 'approver', 'operator'] as const
const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}
const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)

const AMOUNT = 500_000_000n
const DOCUMENTS = ['commercial_invoice'] as const
/** Sandbox configuration, supplied by the caller. `D-05` is open on duration. */
const SANDBOX_TTL_SECONDS = 900
const UNIT = 1_000_000n

let beneficiaryId = ''
let seq = 0

beforeAll(async () => {
  h = await createTestDatabase('settlement_funding')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: creator.id, email: 'c@example.test', roles: [...ROLES],
  })
  await seedUser(h.admin, {
    workspaceId: WS, userId: approver.id, email: 'a@example.test', roles: [...ROLES],
  })
  const version = await activeRuleSetVersion(h.admin, 'sandbox', new Date())
  ruleSet = (await loadRuleSetFromDatabase(h.admin, version!))!.ruleSet

  const created = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN' },
      destination: {
        kind: 'bank_account', accountNumber: '50100123456789', ifsc: 'HDFC0000123',
        accountType: 'savings', accountHolderName: 'Aarti Sharma',
      },
      actor: creator,
    }),
  )
  beneficiaryId = created.id
  await requestVerification(h.db, scope, createSandboxVerificationProvider(), crypto.cipher, SANDBOX_NAME_MATCH_POLICIES, {
      destinationVersionId: created.destinations[0]!.currentVersion!.id,
      actor: creator,
    })

})
afterAll(async () => { await h.close() })

async function newFacility(limitMinor: bigint): Promise<string> {
  const { id } = await live((tx) =>
    createFacility(tx, scope, {
      providerId: 'mock_liquidity', currency: 'USDT',
      limit: money('USDT', limitMinor), actor: creator,
    }),
  )
  return id
}

/** A settlement carried through preflight, quote and authorization. */
async function authorized(): Promise<string> {
  const { id: settlementId } = await live((tx) =>
    createSettlement(tx, scope, {
      beneficiaryId, recipientAmountMinor: AMOUNT, fundingCurrency: 'USDT',
      purposeCode: 'SOFTWARE_SERVICES', externalReference: `fund_${(seq += 1)}`, actor: creator,
    }),
  )
  // Takes the pool, not a transaction: T02 and T03 are two status transitions
  // and INV-32 permits one per transaction.
  // `D-10` is closed: live settlement requires a facility, so preflight asks.
  // Stage 3 had to be told the answer; Stage 4 reads it.
  const facilities = await live((tx) => listFacilities(tx, scope, 'USDT'))
  const preflight = await runSettlementPreflight(h.db, scope, {
    settlementId, ruleSet, actor: creator, documents: DOCUMENTS,
    hasActiveLiquidityFacility: facilities.length > 0,
  })
  if (!preflight.ok) throw new Error(`preflight failed: ${JSON.stringify(preflight)}`)

  const quote = await live((tx) =>
    createQuote(tx, scope, {
      fundingCurrency: 'USDT',
      recipientAmount: { currency: 'INR', minorUnits: AMOUNT },
      actor: creator,
    }),
  )
  const attached = await live((tx) =>
    attachQuote(tx, scope, { settlementId, quoteId: quote.id, actor: creator }),
  )
  if (!attached.ok) throw new Error(`attach failed: ${JSON.stringify(attached)}`)

  const auth = await live((tx) =>
    authorizeSettlement(tx, scope, {
      settlementId, actor: approver, actorRoles: [...ROLES], ruleSet,
      hasActiveLiquidityFacility: true, documents: DOCUMENTS,
    }),
  )
  if (!auth.ok) throw new Error(`authorize failed: ${JSON.stringify(auth)}`)
  return settlementId
}

const FUNDING = money('USDT', UNIT)

describe('the funding leg reaches DRAWDOWN_CONFIRMED', () => {
  it('runs T09 → T10 → T12 → T13 and moves the facility exactly once each way', async () => {
    const facilityId = await newFacility(10n * UNIT)
    const settlementId = await authorized()

    const reserved = await reserveForSettlement(h.db, scope, {
      settlementId, facilityId, fundingAmount: FUNDING,
      ttlSeconds: SANDBOX_TTL_SECONDS, actor: creator,
    })
    expect(reserved).toMatchObject({ ok: true, transition: 'T10' })
    expect((await live((tx) => getSettlement(tx, settlementId)))?.status).toBe('LIQUIDITY_RESERVED')

    let facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility?.position.reserved.minorUnits).toBe(UNIT)
    expect(facility?.available.minorUnits).toBe(9n * UNIT)

    expect(
      await live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator })),
    ).toMatchObject({ ok: true, transition: 'T12' })

    const confirmed = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'confirmed', actor: creator,
        providerReference: 'pdrw_1', providerEventVerified: true,
        evidence: { amountMinor: UNIT, currency: 'USDT', facilityId },
      }),
    )
    expect(confirmed).toMatchObject({ ok: true, transition: 'T13' })
    expect((await live((tx) => getSettlement(tx, settlementId)))?.status).toBe('DRAWDOWN_CONFIRMED')

    // reserved → drawn, in one movement. Availability is unchanged across the
    // consumption, because the value was already committed.
    facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility?.position.reserved.minorUnits).toBe(0n)
    expect(facility?.position.drawn.minorUnits).toBe(UNIT)
    expect(facility?.available.minorUnits).toBe(9n * UNIT)
  })

  it('refuses to reserve against a facility that is genuinely short, and opens T11', async () => {
    // The guard Stage 3 could only answer from a harness. Here the facility
    // really cannot fund it, and the settlement lands in EXCEPTION rather than
    // stalling in LIQUIDITY_RESERVING.
    const facilityId = await newFacility(UNIT / 2n)
    const settlementId = await authorized()

    const result = await reserveForSettlement(h.db, scope, {
      settlementId, facilityId, fundingAmount: FUNDING,
      ttlSeconds: SANDBOX_TTL_SECONDS, actor: creator,
    })
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_availability' })

    const row = await live((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('EXCEPTION')
    expect(row?.openExceptionCode).toBe('LIQUIDITY_UNAVAILABLE')
    // Not customer-actionable, so the customer still reads SETTLING.
    expect(row?.customerStatus).toBe('SETTLING')
  })

  it('opens FACILITY_SUSPENDED rather than LIQUIDITY_UNAVAILABLE when the facility is suspended', async () => {
    const facilityId = await newFacility(10n * UNIT)
    await h.admin`UPDATE liquidity_facilities SET status = 'SUSPENDED' WHERE id = ${facilityId}`
    const settlementId = await authorized()

    const result = await reserveForSettlement(h.db, scope, {
      settlementId, facilityId, fundingAmount: FUNDING,
      ttlSeconds: SANDBOX_TTL_SECONDS, actor: creator,
    })
    // T09's own guard catches it: the settlement never reaches LIQUIDITY_RESERVING.
    expect(result).toMatchObject({ ok: false })
    expect((await live((tx) => getSettlement(tx, settlementId)))?.status).toBe('AUTHORIZED')
  })
})

describe('a failed drawdown releases; an unknown one does not', () => {
  async function toDrawdownRequested(limit = 10n * UNIT): Promise<{ facilityId: string; settlementId: string }> {
    const facilityId = await newFacility(limit)
    const settlementId = await authorized()
    await reserveForSettlement(h.db, scope, {
      settlementId, facilityId, fundingAmount: FUNDING,
      ttlSeconds: SANDBOX_TTL_SECONDS, actor: creator,
    })
    await live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator }))
    return { facilityId, settlementId }
  }

  it('T14 releases the reservation and gives the capacity straight back', async () => {
    const { facilityId, settlementId } = await toDrawdownRequested()
    const failed = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'failed', actor: creator, providerEventVerified: true,
      }),
    )
    expect(failed).toMatchObject({ ok: true, transition: 'T14' })

    const facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility?.available.minorUnits).toBe(10n * UNIT)
    expect(facility?.position.reserved.minorUnits).toBe(0n)

    const row = await live((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('EXCEPTION')
    expect(row?.openExceptionCode).toBe('DRAWDOWN_FAILED')
  })

  it('T29 holds the reservation, because the money may have moved', async () => {
    // The asymmetry that justifies UNKNOWN. Releasing here would free capacity
    // that is possibly already drawn, and the facility would then fund a second
    // settlement against the same money.
    const { facilityId, settlementId } = await toDrawdownRequested()
    const timedOut = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'sla_elapsed', actor: creator, providerEventVerified: true,
      }),
    )
    expect(timedOut).toMatchObject({ ok: true, transition: 'T29' })

    const facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility?.position.reserved.minorUnits).toBe(UNIT)
    expect(facility?.available.minorUnits).toBe(9n * UNIT)

    const reservations = (await live((tx) => tx.execute(sql`
      SELECT status FROM liquidity_reservations WHERE settlement_id = ${settlementId}`))) as unknown as
      { status: string }[]
    expect(reservations[0]!.status).toBe('ACTIVE')
    expect((await live((tx) => getSettlement(tx, settlementId)))?.openExceptionCode).toBe(
      'DRAWDOWN_STATUS_UNKNOWN',
    )
  })

  it('resolves an unknown drawdown by pull, never by resubmitting', async () => {
    const { facilityId, settlementId } = await toDrawdownRequested()
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'sla_elapsed', actor: creator, providerEventVerified: true,
      }),
    )
    // A second request is refused: there is no path from UNKNOWN back to a
    // fresh submission.
    expect(
      await live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator })),
    ).toMatchObject({ ok: false })

    const pulled = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'pull_resolved_confirmed', actor: creator, providerEventVerified: true,
        evidence: { amountMinor: UNIT, currency: 'USDT', facilityId },
      }),
    )
    // The drawdown itself resolves; the settlement stays in EXCEPTION until an
    // attributed operator resolution moves it (T22/T23), which is Stage 3's rule.
    expect(pulled.ok).toBe(false)
    const rows = (await live((tx) => tx.execute(sql`
      SELECT status FROM drawdowns WHERE settlement_id = ${settlementId}`))) as unknown as
      { status: string }[]
    expect(rows[0]!.status).toBe('CONFIRMED')
    const facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility?.position.drawn.minorUnits).toBe(UNIT)
  })
})

describe('INV-22 — cancellation compensates according to where the money got to', () => {
  it('releases the reservation when funding has not moved', async () => {
    const facilityId = await newFacility(10n * UNIT)
    const settlementId = await authorized()
    await reserveForSettlement(h.db, scope, {
      settlementId, facilityId, fundingAmount: FUNDING,
      ttlSeconds: SANDBOX_TTL_SECONDS, actor: creator,
    })
    await live((tx) =>
      cancelSettlement(tx, scope, { settlementId, actor: creator, actorRoles: [...ROLES] }),
    )
    const compensation = await live((tx) =>
      compensateCancellation(tx, scope, { settlementId, actor: creator }),
    )
    expect(compensation).toMatchObject({ ok: true, compensation: 'reservation_released' })
    expect((await live((tx) => readFacility(tx, facilityId)))?.available.minorUnits).toBe(10n * UNIT)
  })

  it('requests a repayment — and does not release — once funding has moved', async () => {
    // The distinction INV-22 exists for. A consumed reservation has nothing to
    // give back; doing both would credit the facility twice.
    const facilityId = await newFacility(10n * UNIT)
    const settlementId = await authorized()
    await reserveForSettlement(h.db, scope, {
      settlementId, facilityId, fundingAmount: FUNDING,
      ttlSeconds: SANDBOX_TTL_SECONDS, actor: creator,
    })
    await live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator }))
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
        evidence: { amountMinor: UNIT, currency: 'USDT', facilityId },
      }),
    )

    const compensation = await live((tx) =>
      compensateCancellation(tx, scope, { settlementId, actor: creator }),
    )
    expect(compensation).toMatchObject({ ok: true, compensation: 'repayment_requested' })

    // INV-46 in the place it matters most: the customer has cancelled, a
    // repayment exists, and availability has not moved a unit.
    const facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility?.position.drawn.minorUnits).toBe(UNIT)
    expect(facility?.available.minorUnits).toBe(9n * UNIT)

    const repayments = (await live((tx) => tx.execute(sql`
      SELECT status, source FROM repayments WHERE settlement_id = ${settlementId}`))) as unknown as
      { status: string; source: string }[]
    expect(repayments[0]).toMatchObject({ status: 'REQUESTED', source: 'CANCELLATION_AFTER_DRAWDOWN' })
  })

  it('owes nothing when there was never a reservation', async () => {
    const settlementId = await authorized()
    expect(
      await live((tx) => compensateCancellation(tx, scope, { settlementId, actor: creator })),
    ).toMatchObject({ ok: true, compensation: 'none' })
  })
})

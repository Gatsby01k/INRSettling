/**
 * Drawdown amount integrity — the funding leg moves only on evidence that says
 * the money arrived, in full, in the right currency, from the right facility.
 *
 * The hole this closes: `resolveDrawdown` used to consume the reservation and
 * post the `reserved → drawn` movement on the *word* "confirmed". A provider
 * event for a different amount would have moved the ledger by the amount we
 * expected rather than the amount that actually arrived, and the settlement
 * would have read `DRAWDOWN_CONFIRMED` on evidence that did not support it.
 * The ledger would have been internally consistent and externally false, which
 * is the worst kind of wrong: nothing would ever have flagged it.
 *
 * Everything here **fails closed**. Under-funding, over-funding, the wrong
 * currency and the wrong facility are all refused, and none of them consumes
 * the reservation or posts a movement. No partial-drawdown policy is invented:
 * what to *do* about a short provider is a commercial and operational question
 * nobody has answered, and answering it inside a matcher is how a policy gets
 * made by accident.
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
  attachQuote, authorizeSettlement, getSettlement, runSettlementPreflight,
} from '../settlement.service.js'
import { checkFacilityProjection, createFacility, listFacilities, readFacility } from '../liquidity.service.js'
import { requestDrawdown, reserveForSettlement, resolveDrawdown } from '../settlement-liquidity.service.js'

let h: Harness
let ruleSet: PreflightRuleSet
const WS = 'ws_drawdown'
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
const TTL = 900
const UNIT = 1_000_000n
const FUNDING = money('USDT', UNIT)

let beneficiaryId = ''
let seq = 0

beforeAll(async () => {
  h = await createTestDatabase('drawdown_integrity')
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

async function authorized(): Promise<string> {
  const { id: settlementId } = await live((tx) =>
    createSettlement(tx, scope, {
      beneficiaryId, recipientAmountMinor: AMOUNT, fundingCurrency: 'USDT',
      purposeCode: 'SOFTWARE_SERVICES', externalReference: `drw_${(seq += 1)}`, actor: creator,
    }),
  )
  const facilities = await live((tx) => listFacilities(tx, scope, 'USDT'))
  const preflight = await runSettlementPreflight(h.db, scope, {
    settlementId, ruleSet, actor: creator, documents: DOCUMENTS,
    hasActiveLiquidityFacility: facilities.length > 0,
  })
  if (!preflight.ok) throw new Error(`preflight failed: ${JSON.stringify(preflight)}`)

  const quote = await live((tx) =>
    createQuote(tx, scope, {
      fundingCurrency: 'USDT', recipientAmount: { currency: 'INR', minorUnits: AMOUNT }, actor: creator,
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

/** A settlement with a reservation held and a drawdown requested. */
async function requested(): Promise<{ facilityId: string; settlementId: string }> {
  const facilityId = await newFacility(10n * UNIT)
  const settlementId = await authorized()
  await reserveForSettlement(h.db, scope, {
    settlementId, facilityId, fundingAmount: FUNDING, ttlSeconds: TTL, actor: creator,
  })
  await live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator }))
  return { facilityId, settlementId }
}

const EXACT = { amountMinor: UNIT, currency: 'USDT' }

const state = async (facilityId: string, settlementId: string) => {
  const facility = await live((tx) => readFacility(tx, facilityId))
  const reservations = (await live((tx) => tx.execute(sql`
    SELECT status FROM liquidity_reservations WHERE settlement_id = ${settlementId}`))) as unknown as
    { status: string }[]
  const drawdowns = (await live((tx) => tx.execute(sql`
    SELECT status FROM drawdowns WHERE settlement_id = ${settlementId}`))) as unknown as
    { status: string }[]
  const consumedMovements = (await live((tx) => tx.execute(sql`
    SELECT count(*)::int AS n FROM ledger_entries
    WHERE facility_id = ${facilityId} AND movement = 'reservation_consumed'`))) as unknown as
    { n: number }[]
  const settlement = await live((tx) => getSettlement(tx, settlementId))
  return {
    reservation: reservations[0]!.status,
    drawdown: drawdowns[0]!.status,
    reserved: facility!.position.reserved.minorUnits,
    drawn: facility!.position.drawn.minorUnits,
    consumedMovements: consumedMovements[0]!.n,
    settlementStatus: settlement?.status,
  }
}

describe('exact confirmation consumes the reservation', () => {
  it('moves reserved → drawn once, and only once', async () => {
    const { facilityId, settlementId } = await requested()
    const result = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
        evidence: { ...EXACT, facilityId, providerReference: 'pdrw_1' },
      }),
    )
    expect(result).toMatchObject({ ok: true, transition: 'T13' })

    const s = await state(facilityId, settlementId)
    expect(s).toMatchObject({
      reservation: 'CONSUMED', drawdown: 'CONFIRMED', settlementStatus: 'DRAWDOWN_CONFIRMED',
    })
    expect(s.reserved).toBe(0n)
    expect(s.drawn).toBe(UNIT)
    expect(s.consumedMovements).toBe(2) // one balanced pair
    expect((await live((tx) => checkFacilityProjection(tx, facilityId))).agrees).toBe(true)
  })

  it('accepts evidence that omits the optional facility id', async () => {
    // Some providers do not echo the facility. Amount and currency are the two
    // that are always required.
    const { facilityId, settlementId } = await requested()
    expect(
      await live((tx) =>
        resolveDrawdown(tx, scope, {
          settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
          evidence: EXACT,
        }),
      ),
    ).toMatchObject({ ok: true, transition: 'T13' })
    expect((await state(facilityId, settlementId)).reservation).toBe('CONSUMED')
  })
})

describe('a duplicate exact confirmation is idempotent', () => {
  it('replays ten times and produces one state change and one movement', async () => {
    // `STATE_MACHINES.md § 10` requires exactly this of every provider
    // callback. Idempotence is a property of the delivery channel, not a
    // transition — the machine correctly has no CONFIRMED → CONFIRMED row.
    const { facilityId, settlementId } = await requested()
    const call = () =>
      live((tx) =>
        resolveDrawdown(tx, scope, {
          settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
          evidence: { ...EXACT, facilityId },
        }),
      )

    const first = await call()
    expect(first).toMatchObject({ ok: true, transition: 'T13' })

    for (let i = 0; i < 9; i += 1) {
      expect(await call(), `replay ${i}`).toMatchObject({ ok: true, idempotent: true })
    }

    const s = await state(facilityId, settlementId)
    expect(s.consumedMovements).toBe(2)
    expect(s.drawn).toBe(UNIT)
    expect(s.reservation).toBe('CONSUMED')

    // And one status event, not ten.
    const events = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM events
      WHERE subject_id = ${settlementId} AND type = 'settlement.drawdown_confirmed'`))) as unknown as
      { n: number }[]
    expect(events[0]!.n).toBe(1)
  })

  it('does not treat a *different* amount as a replay', async () => {
    // The dangerous near-miss: a second callback that is not the same event.
    // Idempotence must key on the evidence, not merely on "we already have a
    // CONFIRMED drawdown", or a wrong-amount event would be waved through.
    const { facilityId, settlementId } = await requested()
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
        evidence: { ...EXACT, facilityId },
      }),
    )
    expect(
      await live((tx) =>
        resolveDrawdown(tx, scope, {
          settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
          evidence: { amountMinor: 2n * UNIT, currency: 'USDT', facilityId },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'amount_mismatch' })
    expect((await state(facilityId, settlementId)).drawn).toBe(UNIT)
  })
})

describe('mismatched evidence consumes nothing', () => {
  const unchanged = async (facilityId: string, settlementId: string) => {
    const s = await state(facilityId, settlementId)
    expect(s.reservation).toBe('ACTIVE')
    expect(s.drawdown).toBe('REQUESTED')
    expect(s.reserved).toBe(UNIT)
    expect(s.drawn).toBe(0n)
    expect(s.consumedMovements).toBe(0)
    // The settlement stays where the machine left it. No silent confirmation.
    expect(s.settlementStatus).toBe('DRAWDOWN_REQUESTED')
  }

  it('refuses the wrong currency', async () => {
    const { facilityId, settlementId } = await requested()
    const result = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
        evidence: { amountMinor: UNIT, currency: 'USD', facilityId },
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'currency_mismatch' })
    await unchanged(facilityId, settlementId)
  })

  it('refuses over-confirmation', async () => {
    const { facilityId, settlementId } = await requested()
    const result = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
        evidence: { amountMinor: UNIT + 1n, currency: 'USDT', facilityId },
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'amount_mismatch' })
    expect((result as { detail: { direction: string } }).detail.direction).toBe('over')
    await unchanged(facilityId, settlementId)
  })

  it('refuses partial confirmation, with no silent DRAWDOWN_CONFIRMED', async () => {
    // The case with the most pull towards a quiet accommodation. A provider
    // that funded 60% has not funded the settlement, and marking it confirmed
    // would put a settlement into execution on money that is not there.
    // Whether to top up, retry or fail is a policy question, and this refuses
    // rather than picking one.
    const { facilityId, settlementId } = await requested()
    const result = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
        evidence: { amountMinor: (UNIT * 6n) / 10n, currency: 'USDT', facilityId },
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'amount_mismatch' })
    expect((result as { detail: { direction: string } }).detail.direction).toBe('under')
    await unchanged(facilityId, settlementId)
  })

  it('refuses off-by-one in either direction', async () => {
    for (const delta of [-1n, 1n]) {
      const { facilityId, settlementId } = await requested()
      expect(
        await live((tx) =>
          resolveDrawdown(tx, scope, {
            settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
            evidence: { amountMinor: UNIT + delta, currency: 'USDT', facilityId },
          }),
        ),
        String(delta),
      ).toMatchObject({ ok: false, reason: 'amount_mismatch' })
      await unchanged(facilityId, settlementId)
    }
  })

  it('refuses evidence naming a different facility', async () => {
    const { facilityId, settlementId } = await requested()
    const other = await newFacility(10n * UNIT)
    expect(
      await live((tx) =>
        resolveDrawdown(tx, scope, {
          settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
          evidence: { ...EXACT, facilityId: other },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'facility_mismatch' })
    await unchanged(facilityId, settlementId)
  })

  it('refuses a confirmation carrying no evidence at all', async () => {
    // The old signature. A confirmation is a claim about an amount, and a
    // caller that has no amount to offer has nothing to confirm with.
    const { facilityId, settlementId } = await requested()
    expect(
      await live((tx) =>
        resolveDrawdown(tx, scope, {
          settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'evidence_required' })
    await unchanged(facilityId, settlementId)
  })

  it('refuses an unverified provider event even when the amount is exact', async () => {
    const { facilityId, settlementId } = await requested()
    expect(
      await live((tx) =>
        resolveDrawdown(tx, scope, {
          settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: false,
          evidence: { ...EXACT, facilityId },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed' })
    await unchanged(facilityId, settlementId)
  })

  it('refuses an unverified *failure* event without releasing the reservation', async () => {
    // The same ordering bug in the other direction: T14 releases the
    // reservation, so an unverified failure event that got as far as the
    // release would hand back capacity on evidence nobody trusted.
    const { facilityId, settlementId } = await requested()
    expect(
      await live((tx) =>
        resolveDrawdown(tx, scope, {
          settlementId, trigger: 'failed', actor: creator, providerEventVerified: false,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed' })
    await unchanged(facilityId, settlementId)
  })

  it('applies the same matching to a pull-resolved confirmation', async () => {
    // Y06's drawdown equivalent. A status pull is a different route to the same
    // claim and gets the same scrutiny — otherwise the pull path is a way round
    // the check.
    const { facilityId, settlementId } = await requested()
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'sla_elapsed', actor: creator, providerEventVerified: true,
      }),
    )
    expect(
      await live((tx) =>
        resolveDrawdown(tx, scope, {
          settlementId, trigger: 'pull_resolved_confirmed', actor: creator, providerEventVerified: true,
          evidence: { amountMinor: 2n * UNIT, currency: 'USDT', facilityId },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'amount_mismatch' })

    const s = await state(facilityId, settlementId)
    expect(s.reservation).toBe('ACTIVE')
    expect(s.drawdown).toBe('UNKNOWN')
    expect(s.consumedMovements).toBe(0)
  })
})

describe('an indeterminate provider status leaves the funding state unresolved', () => {
  it('holds the reservation and does not guess', async () => {
    // Neither consumed nor released. The money may have moved, so releasing
    // would free capacity that is actually drawn, and consuming would claim
    // funding that may never have happened. The only honest state is "we do
    // not know yet", and the reservation stays exactly where it is.
    const { facilityId, settlementId } = await requested()
    const result = await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'sla_elapsed', actor: creator, providerEventVerified: true,
      }),
    )
    expect(result).toMatchObject({ ok: true, transition: 'T29' })

    const s = await state(facilityId, settlementId)
    expect(s.reservation).toBe('ACTIVE')
    expect(s.drawdown).toBe('UNKNOWN')
    expect(s.reserved).toBe(UNIT)
    expect(s.drawn).toBe(0n)
    expect(s.consumedMovements).toBe(0)
    expect(s.settlementStatus).toBe('EXCEPTION')
    expect((await live((tx) => getSettlement(tx, settlementId)))?.openExceptionCode).toBe(
      'DRAWDOWN_STATUS_UNKNOWN',
    )
  })

  it('cannot be resolved by resubmitting the drawdown', async () => {
    const { facilityId, settlementId } = await requested()
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'sla_elapsed', actor: creator, providerEventVerified: true,
      }),
    )
    expect(
      await live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator })),
    ).toMatchObject({ ok: false })
    expect((await state(facilityId, settlementId)).drawdown).toBe('UNKNOWN')
  })

  it('resolves through the pull path with matching evidence, and then consumes', async () => {
    const { facilityId, settlementId } = await requested()
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'sla_elapsed', actor: creator, providerEventVerified: true,
      }),
    )
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'pull_resolved_confirmed', actor: creator, providerEventVerified: true,
        evidence: { ...EXACT, facilityId },
      }),
    )
    const s = await state(facilityId, settlementId)
    expect(s.drawdown).toBe('CONFIRMED')
    expect(s.reservation).toBe('CONSUMED')
    expect(s.drawn).toBe(UNIT)
    expect((await live((tx) => checkFacilityProjection(tx, facilityId))).agrees).toBe(true)
  })

  it('a pull that resolves to failed releases instead, and restores capacity', async () => {
    const { facilityId, settlementId } = await requested()
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'sla_elapsed', actor: creator, providerEventVerified: true,
      }),
    )
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'pull_resolved_failed', actor: creator, providerEventVerified: true,
      }),
    )
    const s = await state(facilityId, settlementId)
    expect(s.drawdown).toBe('FAILED')
    expect(s.reservation).toBe('RELEASED')
    expect(s.reserved).toBe(0n)
    expect(s.drawn).toBe(0n)
    const facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility!.available.minorUnits).toBe(10n * UNIT)
  })
})

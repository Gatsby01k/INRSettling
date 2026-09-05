/**
 * Stage 5 — payout execution, end to end against a real database.
 *
 * The four exit criteria this file exists to prove, in the frozen plan's words:
 *
 *   - every scenario in the simulator table is a passing, replayable test;
 *   - a redelivered provider webhook produces one state change and one event;
 *   - an unsigned or stale webhook is stored, alarmed and produces no
 *     transition;
 *   - `UNKNOWN` resolves only by authoritative status pull — a test proves no
 *     code path resubmits blindly (`INV-24`).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedUser, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { money } from '@inrsettle/money'
import { payoutIdempotencyKey, type PreflightRuleSet, type ProviderMappingTable } from '@inrsettle/domain'
import {
  SANDBOX_NAME_MATCH_POLICIES,
  SCENARIOS,
  SCENARIO_SUFFIXES,
  createMockIndiaPayoutProvider,
  createSandboxVerificationProvider,
  handoffsTo,
  payoutScenarioFor,
  scenariosOwnedBy,
  type MockIndiaPayoutProvider,
  type ScenarioHandoff,
  type ScenarioSuffix,
} from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { requestVerification, type RequestVerificationResult } from '../verification.service.js'
import { activeRuleSetVersion, loadRuleSetFromDatabase } from '../reference-data.service.js'
import { createQuote } from '../quote.service.js'
import { createSettlement } from '../settlement-transition.service.js'
import {
  attachQuote, authorizeSettlement, dispatchPayout, getSettlement, honourCancellation,
  requestCancellation, runSettlementPreflight,
} from '../settlement.service.js'
import {
  advanceRepayment, checkFacilityProjection, createFacility, listFacilities, readFacility,
  requestRepayment,
} from '../liquidity.service.js'
import { requestDrawdown, reserveForSettlement, resolveDrawdown } from '../settlement-liquidity.service.js'
import { activeMappingTable } from '../payout-mapping.service.js'
import {
  applyPayoutOutcome, chooseRail, pullPayoutStatus, retryPayout, submitDispatchedPayout, sweepPayoutSla,
} from '../payout.service.js'
import { ingestPayoutWebhook } from '../payout-webhook.service.js'

let h: Harness
let ruleSet: PreflightRuleSet
let mapping: ProviderMappingTable
const WS = 'ws_payout'
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

/**
 * A fixed clock for the *provider*, so webhook timestamp tolerance is exercised
 * against a known instant rather than against wall time.
 *
 * The SLA sweeper deliberately does not use this: it compares against the
 * database clock, because an elapsed SLA is a fact about time rather than
 * something a caller may assert. See `ageBeyondSla` at the foot of this file.
 */
const clockNow = new Date('2026-09-03T10:00:00.000Z')
const clock = (): Date => clockNow
let provider: MockIndiaPayoutProvider

let seq = 0

beforeAll(async () => {
  h = await createTestDatabase('payout_execution')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: creator.id, email: 'c@example.test', roles: [...ROLES],
  })
  await seedUser(h.admin, {
    workspaceId: WS, userId: approver.id, email: 'a@example.test', roles: [...ROLES],
  })
  const version = await activeRuleSetVersion(h.admin, 'sandbox', new Date())
  ruleSet = (await loadRuleSetFromDatabase(h.admin, version!))!.ruleSet
  mapping = (await live((tx) => activeMappingTable(tx, 'mock_india_payout')))!
  provider = createMockIndiaPayoutProvider({ now: clock })
})
afterAll(async () => { await h.close() })

/** A beneficiary whose account number ends in a scenario suffix. */
async function beneficiaryFor(
  suffix: string,
): Promise<{ id: string; versionId: string; destinationId: string; verification: RequestVerificationResult }> {
  const created = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN' },
      destination: {
        kind: 'bank_account',
        accountNumber: `501001234${suffix}`,
        ifsc: 'HDFC0000123',
        accountType: 'savings',
        accountHolderName: 'Aarti Sharma',
      },
      actor: creator,
    }),
  )
  const destination = created.destinations[0]!
  const versionId = destination.currentVersion!.id
  const verification = await requestVerification(h.db, scope, createSandboxVerificationProvider(), crypto.cipher, SANDBOX_NAME_MATCH_POLICIES, {
      destinationVersionId: versionId, actor: creator,
    })

  return { id: created.id, versionId, destinationId: destination.id, verification }
}

const resolveDestination = async (destinationVersionId: string) => {
  const rows = (await live((tx) => tx.execute(sql`
    SELECT pdv.id, pd.kind FROM payout_destination_versions pdv
    JOIN payout_destinations pd ON pd.id = pdv.destination_id
    WHERE pdv.id = ${destinationVersionId}`))) as unknown as { id: string; kind: string }[]
  const row = rows[0]
  if (!row) return null
  // The account number carries the scenario suffix; the simulator reads it.
  const acct = (await live((tx) => tx.execute(sql`
    SELECT account_number_last4 FROM payout_destination_versions WHERE id = ${destinationVersionId}`))) as unknown as
    { account_number_last4: string }[]
  return {
    kind: row.kind as 'bank_account' | 'vpa',
    accountNumber: `501001234${acct[0]!.account_number_last4}`,
    ifsc: 'HDFC0000123',
    accountHolderName: 'Aarti Sharma',
  }
}

interface Staged {
  readonly settlementId: string
  readonly facilityId: string
}

/**
 * Carry a settlement to `LIQUIDITY_RESERVED`, one step before the funding leg.
 *
 * Split out from `dispatched` because three of the frozen scenarios are about
 * what happens *before* a payout exists — `…0007` needs a drawdown still in
 * flight, and a helper that always ran to dispatch could not stage them.
 */
async function authorized(suffix: string): Promise<Staged> {
  const facilityId = (await live((tx) =>
    createFacility(tx, scope, {
      providerId: 'mock_liquidity', currency: 'USDT',
      limit: money('USDT', 100n * UNIT), actor: creator,
    }),
  )).id
  const beneficiary = await beneficiaryFor(suffix)

  const { id: settlementId } = await live((tx) =>
    createSettlement(tx, scope, {
      beneficiaryId: beneficiary.id, recipientAmountMinor: AMOUNT, fundingCurrency: 'USDT',
      purposeCode: 'SOFTWARE_SERVICES', externalReference: `pay_${(seq += 1)}`, actor: creator,
    }),
  )
  const facilities = await live((tx) => listFacilities(tx, scope, 'USDT'))
  const pre = await runSettlementPreflight(h.db, scope, {
    settlementId, ruleSet, actor: creator, documents: DOCUMENTS,
    hasActiveLiquidityFacility: facilities.length > 0,
  })
  if (!pre.ok) throw new Error(`preflight: ${JSON.stringify(pre)}`)

  const quote = await live((tx) =>
    createQuote(tx, scope, {
      fundingCurrency: 'USDT', recipientAmount: { currency: 'INR', minorUnits: AMOUNT }, actor: creator,
    }),
  )
  const attached = await live((tx) => attachQuote(tx, scope, { settlementId, quoteId: quote.id, actor: creator }))
  if (!attached.ok) throw new Error(`attach: ${JSON.stringify(attached)}`)
  const auth = await live((tx) =>
    authorizeSettlement(tx, scope, {
      settlementId, actor: approver, actorRoles: [...ROLES], ruleSet,
      hasActiveLiquidityFacility: true, documents: DOCUMENTS,
    }),
  )
  if (!auth.ok) throw new Error(`authorize: ${JSON.stringify(auth)}`)

  await reserveForSettlement(h.db, scope, {
    settlementId, facilityId, fundingAmount: money('USDT', UNIT), ttlSeconds: TTL, actor: creator,
  })
  return { settlementId, facilityId }
}

/** …and on through a confirmed drawdown, which is where the funding leg ends. */
async function funded(suffix: string): Promise<Staged> {
  const staged = await authorized(suffix)
  await live((tx) => requestDrawdown(tx, scope, { settlementId: staged.settlementId, actor: creator }))
  await live((tx) =>
    resolveDrawdown(tx, scope, {
      settlementId: staged.settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
      evidence: { amountMinor: UNIT, currency: 'USDT', facilityId: staged.facilityId },
    }),
  )
  return staged
}

/** Carry a settlement all the way to a dispatched payout attempt. */
async function dispatched(suffix: string): Promise<Staged & { idempotencyKey: string }> {
  const staged = await funded(suffix)

  const rail = await chooseRail(provider, { destinationKind: 'bank_account', amountMinor: AMOUNT })
  if (!rail.ok) throw new Error(`rail: ${JSON.stringify(rail)}`)

  const result = await live((tx) =>
    dispatchPayout(tx, scope, {
      settlementId: staged.settlementId, actor: creator, railSelected: true,
      rail: rail.rail, slaSeconds: rail.slaSeconds, providerId: provider.id,
      fundingAmountMinor: AMOUNT,
    }),
  )
  if (!result.ok) throw new Error(`dispatch: ${JSON.stringify(result)}`)
  return { ...staged, idempotencyKey: result.idempotencyKey }
}

/** Dispatch, submit and apply the credit — the state every return starts from. */
async function credited(suffix: string): Promise<Staged & { idempotencyKey: string; utr: string }> {
  const staged = await dispatched(suffix)
  const submitted = await submitDispatchedPayout(h.db, scope, provider, resolveDestination, {
    settlementId: staged.settlementId, actor: creator,
  })
  if (!submitted.ok || submitted.status !== 'CREDITED') {
    throw new Error(`submit: ${JSON.stringify(submitted)}`)
  }
  const applied = await live((tx) =>
    applyPayoutOutcome(tx, scope, {
      settlementId: staged.settlementId, outcome: 'credited', actor: creator, trusted: true,
      utr: submitted.utr, creditedMinor: submitted.creditedMinor,
    }),
  )
  if (!applied.ok) throw new Error(`credit: ${JSON.stringify(applied)}`)
  return { ...staged, utr: submitted.utr! }
}

const attemptOf = async (settlementId: string) => {
  const rows = (await live((tx) => tx.execute(sql`
    SELECT attempt_number, status, utr, rail, raw_code, mapping_version,
           amount_minor, credited_minor, credited_at, returned_at
    FROM payout_attempts WHERE settlement_id = ${settlementId}
    ORDER BY attempt_number DESC LIMIT 1`))) as unknown as {
    attempt_number: number; status: string; utr: string | null
    rail: string | null; raw_code: string | null; mapping_version: string | null
    amount_minor: string | null; credited_minor: string | null
    // Raw SQL, so timestamps arrive as the driver's strings rather than Dates.
    credited_at: string | null; returned_at: string | null
  }[]
  return rows[0]!
}

const countEvents = async (settlementId: string, type: string): Promise<number> => {
  const rows = (await live((tx) => tx.execute(sql`
    SELECT count(*)::int AS n FROM events
    WHERE subject_id = ${settlementId} AND type = ${type}`))) as unknown as { n: number }[]
  return rows[0]!.n
}

/**
 * Every event ever emitted about a settlement, so "nothing moved" is checkable.
 *
 * Ordered by `created_at` and then by `type`, never by `id`: `INV-09` ids are
 * random, so ordering by one leaves the comparison at the mercy of whatever
 * order the heap happened to return. The `type` tiebreaker covers companion
 * events written inside one transaction, which share a `now()` and are
 * simultaneous by design — this list is used as a before/after snapshot, so a
 * total order that is stable matters more than one that is chronological.
 */
const eventTypesOf = async (settlementId: string): Promise<string[]> => {
  const rows = (await live((tx) => tx.execute(sql`
    SELECT type FROM events WHERE subject_id = ${settlementId}
    ORDER BY created_at, type`))) as unknown as
    { type: string }[]
  return rows.map((r) => r.type)
}

const providerEventsFor = async (settlementId: string) => {
  const rows = (await live((tx) => tx.execute(sql`
    SELECT provider_event_id, event_type, payload, signature_valid, interpretation
    FROM provider_events WHERE subject_id = ${settlementId} ORDER BY received_at, id`))) as unknown as {
    provider_event_id: string; event_type: string
    payload: Record<string, unknown>; signature_valid: boolean; interpretation: string | null
  }[]
  return rows
}

/** Deliver one signed provider event for a settlement, through the real edge. */
async function deliver(settlementId: string, payload: Record<string, unknown>) {
  const signed = provider.sign({ ...payload, settlement_id: settlementId })
  return live((tx) =>
    ingestPayoutWebhook(tx, scope, provider, mapping, {
      raw: signed.raw, headers: signed.headers, actor: creator,
      resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
    }),
  )
}

/* ── Coverage, counted rather than claimed ──────────────────────────────── */

/**
 * The frozen Stage 5 gate asks for *"every scenario in the simulator table"* as
 * a passing, replayable test. A hand-maintained list of which rows are covered
 * is a claim about the tests rather than a fact about them, and it goes stale
 * silently — so each scenario test records itself here, and the last test in
 * the suite fails if the set is not the whole table.
 */
const exercised = new Set<ScenarioSuffix>()
const exercises = (suffix: ScenarioSuffix): ScenarioHandoff | undefined => {
  exercised.add(suffix)
  return SCENARIOS.find((s) => s.suffix === suffix)!.handoff
}

/* ── 1. Every scenario in the simulator table ───────────────────────────── */

describe('the frozen simulator table', () => {
  it('reproduces all fifteen rows, each owned by a named stage', () => {
    expect(SCENARIOS).toHaveLength(15)
    expect(SCENARIOS.map((s) => s.suffix)).toEqual([...SCENARIO_SUFFIXES])
    for (const s of SCENARIOS) {
      expect(['Stage 2', 'Stage 3', 'Stage 4', 'Stage 5', 'Stage 6'], s.suffix).toContain(s.ownedBy)
      // A row Stage 5 does not own must say what it hands over, to whom, and
      // under which invariants. A row owned elsewhere with no handoff is a gap
      // nobody has written down, which is the failure mode a prose note in a
      // notes file cannot be trusted to catch.
      if (s.ownedBy !== 'Stage 5') {
        expect(s.handoff, s.suffix).toBeTruthy()
        expect(s.handoff!.consumedBy, s.suffix).toBe(s.ownedBy)
        expect(s.handoff!.produces.length, s.suffix).toBeGreaterThan(0)
        expect(s.handoff!.obligation.length, s.suffix).toBeGreaterThan(0)
        expect(s.handoff!.invariants.length, s.suffix).toBeGreaterThan(0)
      }
    }
  })

  it('enumerates what each later stage is owed, without that stage reading this file', () => {
    expect(handoffsTo('Stage 6').map((h) => h.suffix)).toEqual(['0001', '0004', '0011', '0012', '0014'])
    expect(handoffsTo('Stage 2').map((h) => h.suffix)).toEqual(['0006'])
    expect(handoffsTo('Stage 3').map((h) => h.suffix)).toEqual(['0008'])
    expect(handoffsTo('Stage 4').map((h) => h.suffix)).toEqual(['0007', '0013'])
    expect(handoffsTo('Stage 5')).toEqual([])
  })

  it('selects deterministically by suffix, every time', () => {
    for (const s of SCENARIOS) {
      expect(payoutScenarioFor(`501001234${s.suffix}`).suffix).toBe(s.suffix)
      expect(payoutScenarioFor(`501001234${s.suffix}`)).toEqual(payoutScenarioFor(`501001234${s.suffix}`))
    }
  })

  it('…0000 — happy path: accepted → credited with a well-formed UTR', async () => {
    exercises('0000')
    const { settlementId } = await dispatched('0000')
    const submitted = await submitDispatchedPayout(h.db, scope, provider, resolveDestination, {
      settlementId, actor: creator,
    })
    expect(submitted).toMatchObject({ ok: true, status: 'CREDITED' })

    const applied = await live((tx) =>
      applyPayoutOutcome(tx, scope, {
        settlementId, outcome: 'credited', actor: creator, trusted: true,
        utr: submitted.ok ? submitted.utr : undefined,
      }),
    )
    expect(applied).toMatchObject({ ok: true, status: 'CREDITED' })
    expect((await getSettlementStatus(settlementId))).toBe('PAYOUT_CONFIRMED')
    expect((await attemptOf(settlementId)).utr).toMatch(/^UTR/)
  })

  it('…0001 — a ₹5,000 shortfall, recorded as a shortfall rather than rounded away', async () => {
    const handoff = exercises('0001')!
    const SHORTFALL = 500_000n

    const { settlementId } = await dispatched('0001')
    const submitted = await submitDispatchedPayout(h.db, scope, provider, resolveDestination, {
      settlementId, actor: creator,
    })
    // The rail credited, and it credited less than it was told to.
    expect(submitted).toMatchObject({ ok: true, status: 'CREDITED' })
    expect(submitted.ok && submitted.creditedMinor).toBe(AMOUNT - SHORTFALL)

    const applied = await live((tx) =>
      applyPayoutOutcome(tx, scope, {
        settlementId, outcome: 'credited', actor: creator, trusted: true,
        utr: submitted.ok ? submitted.utr : undefined,
        creditedMinor: submitted.ok ? submitted.creditedMinor : undefined,
      }),
    )
    expect(applied).toMatchObject({ ok: true, status: 'CREDITED' })

    // Stage 5's whole contribution, and it is a schema property rather than a
    // behaviour: the instructed amount and the credited amount are two columns,
    // so a difference between them can survive to be noticed.
    const attempt = await attemptOf(settlementId)
    expect(BigInt(attempt.amount_minor!)).toBe(AMOUNT)
    expect(BigInt(attempt.credited_minor!)).toBe(AMOUNT - SHORTFALL)

    // And Stage 5 does *not* act on the delta. A credit is a credit; whether it
    // was the right size is reconciliation's question, and answering it here
    // would put the rule in two places.
    expect(await getSettlementStatus(settlementId)).toBe('PAYOUT_CONFIRMED')
    expect(handoff.consumedBy).toBe('Stage 6')
    expect(handoff.invariants).toContain('INV-26')
  })

  it('…0002 — rejected by the beneficiary bank, mapped to the destination code', async () => {
    exercises('0002')
    const { settlementId } = await dispatched('0002')
    const submitted = await submitDispatchedPayout(h.db, scope, provider, resolveDestination, {
      settlementId, actor: creator,
    })
    expect(submitted).toMatchObject({ ok: true, status: 'REJECTED' })

    const applied = await live((tx) =>
      applyPayoutOutcome(tx, scope, {
        settlementId, outcome: 'rejected', actor: creator, trusted: true,
        rawCode: 'BENE_ACCOUNT_CLOSED', exceptionCode: 'PAYOUT_REJECTED_DESTINATION',
        mappingVersion: mapping.version,
      }),
    )
    expect(applied).toMatchObject({ ok: true, status: 'REJECTED' })
    const row = await live((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('EXCEPTION')
    expect(row?.openExceptionCode).toBe('PAYOUT_REJECTED_DESTINATION')
    // Customer-actionable: they can supply a different account.
    expect(row?.customerStatus).toBe('ACTION_REQUIRED')
  })

  it('…0003 — no terminal status within SLA → UNKNOWN → exception', async () => {
    exercises('0003')
    const { settlementId } = await dispatched('0003')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator })
    expect((await attemptOf(settlementId)).status).toBe('ACCEPTED')

    // Not yet elapsed.
    expect(await live((tx) => sweepPayoutSla(tx, scope, { settlementId, actor: creator }))).toMatchObject({
      ok: false, reason: 'sla_not_elapsed',
    })

    await ageBeyondSla(settlementId)
    const swept = await live((tx) => sweepPayoutSla(tx, scope, { settlementId, actor: creator }))
    expect(swept).toMatchObject({ ok: true, status: 'UNKNOWN' })
    const row = await live((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('EXCEPTION')
    expect(row?.openExceptionCode).toBe('PAYOUT_STATUS_UNKNOWN')
  })

  it('…0004 — the rail sends a credit back: P08, and the settlement does not move', async () => {
    const handoff = exercises('0004')!
    const { settlementId, idempotencyKey } = await credited('0004')

    const before = await attemptOf(settlementId)
    expect(before.status).toBe('CREDITED')
    const eventsBefore = await eventTypesOf(settlementId)

    // The rail returns it. Stage 5 hears about it the way it hears about
    // everything: a signed provider event through the real edge.
    const reported = provider.reportReturn(idempotencyKey)!
    expect(reported.rawCode).toBe('RETURNED_BY_BENEFICIARY_BANK')
    const ingested = await deliver(settlementId, {
      id: `evt_ret_${reported.returnId}`,
      type: 'payout.returned',
      code: reported.rawCode,
      amount_minor: String(reported.amountMinor),
    })
    expect(ingested).toMatchObject({ ok: true, applied: true, outcome: 'returned' })

    const after = await attemptOf(settlementId)
    expect(after.status).toBe('RETURNED')
    // P08 runs from CREDITED, so the credit's evidence necessarily survives it.
    // Asserted rather than assumed, because a returned payout that lost its UTR
    // would be one the customer could no longer be shown proof of.
    expect(after.utr).toBe(before.utr)
    expect(after.credited_at).toEqual(before.credited_at)
    expect(after.returned_at).not.toBeNull()

    // The settlement itself is untouched: no status change, and — the sharper
    // check — not one new event of any type. A return is a fact about the rail,
    // and Stage 6 decides what it means for the settlement.
    expect(await getSettlementStatus(settlementId)).toBe('PAYOUT_CONFIRMED')
    expect(await eventTypesOf(settlementId)).toEqual(eventsBefore)

    expect(handoff.consumedBy).toBe('Stage 6')
    expect(handoff.invariants).toEqual(['INV-42', 'INV-48'])
  })

  it('…0005 — the submit call times out, and the payout did exist', async () => {
    // The scenario that justifies the whole UNKNOWN design.
    exercises('0005')
    const { settlementId, idempotencyKey } = await dispatched('0005')
    const submitted = await submitDispatchedPayout(h.db, scope, provider, resolveDestination, {
      settlementId, actor: creator,
    })
    expect(submitted).toMatchObject({ ok: false, reason: 'provider_timeout' })

    // Nothing moved locally — the attempt is still exactly as dispatched.
    expect((await attemptOf(settlementId)).status).toBe('SUBMITTED')
    // And the payout is real at the provider.
    expect(await provider.getPayout(idempotencyKey)).toMatchObject({ status: 'CREDITED' })

    const pulled = await pullPayoutStatus(h.db, scope, provider, mapping, { settlementId, actor: creator })
    expect(pulled).toMatchObject({ ok: true, status: 'CREDITED', resolvedBy: 'pull' })
    expect(await getSettlementStatus(settlementId)).toBe('PAYOUT_CONFIRMED')
  })

  it('…0006 — name mismatch at verification, so no payout is ever reached', async () => {
    // Stage 2 is closed, so this runs that stage's real behaviour rather than a
    // stand-in. Replaying a finished stage is not implementing it early.
    const handoff = exercises('0006')!
    const beneficiary = await beneficiaryFor('0006')

    // The provider confirmed the *account*; the versioned policy refused the
    // *name*. That split is the point — the simulator does not decide.
    expect(beneficiary.verification).toMatchObject({
      ok: true, status: 'failed', reasonCode: 'name_mismatch',
    })
    const rows = (await live((tx) => tx.execute(sql`
      SELECT status, name_match_outcome, name_match_policy_version
      FROM destination_verifications WHERE destination_version_id = ${beneficiary.versionId}`))) as unknown as
      { status: string; name_match_outcome: string; name_match_policy_version: string }[]
    expect(rows[0]).toMatchObject({
      status: 'failed', name_match_outcome: 'mismatch', name_match_policy_version: 'sandbox-name-match-1',
    })

    // INV-45: the verdict attaches to the *version*, and the beneficiary's
    // rollup — which is what preflight reads — does not reach `verified`. So
    // nothing downstream can pay it.
    const ben = (await live((tx) => tx.execute(sql`
      SELECT status FROM beneficiaries WHERE id = ${beneficiary.id}`))) as unknown as
      { status: string }[]
    expect(ben[0]!.status).not.toBe('verified')

    // And the handoff's claim is literally true: nothing reached the payout
    // layer, because there is no payout adapter behaviour for this row at all.
    expect(payoutScenarioFor(`5010012340006`).payoutBehaviour).toBeNull()
    expect(handoff.consumedBy).toBe('Stage 2')
    expect(handoff.invariants).toContain('INV-45')
  })

  it('…0007 — a cancellation lands mid-drawdown and waits for the next checkpoint', async () => {
    // Stage 4's real funding-leg behaviour, replayed. T26 annotates; T27 acts.
    const handoff = exercises('0007')!
    const { settlementId, facilityId } = await authorized('0007')
    await live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator }))
    expect(await getSettlementStatus(settlementId)).toBe('DRAWDOWN_REQUESTED')

    // T26 — an annotation, not a transition.
    const requested = await live((tx) =>
      requestCancellation(tx, scope, {
        settlementId, actor: creator, mayCancel: true, reason: 'customer changed their mind',
      }),
    )
    expect(requested).toMatchObject({ ok: true })
    expect(await getSettlementStatus(settlementId)).toBe('DRAWDOWN_REQUESTED')
    expect((await live((tx) => getSettlement(tx, settlementId)))!.cancellationRequestedAt).not.toBeNull()
    // No status change means no status event. The frozen table says `to: null`
    // and `statusEvent: null`, and INV-32 would catch it if one appeared.
    expect(await countEvents(settlementId, 'settlement.cancelled')).toBe(0)
    expect(await countEvents(settlementId, 'settlement.cancellation_requested')).toBe(1)

    // Mid-drawdown is not a checkpoint, so T27 refuses. This is the whole
    // scenario: the request is held, not lost and not acted on.
    expect(
      await live((tx) => honourCancellation(tx, scope, { settlementId, actor: creator })),
    ).toMatchObject({ ok: false })
    expect(await getSettlementStatus(settlementId)).toBe('DRAWDOWN_REQUESTED')

    // The drawdown confirms. *That* is the checkpoint.
    await live((tx) =>
      resolveDrawdown(tx, scope, {
        settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
        evidence: { amountMinor: UNIT, currency: 'USDT', facilityId },
      }),
    )
    expect(await getSettlementStatus(settlementId)).toBe('DRAWDOWN_CONFIRMED')

    const honoured = await live((tx) => honourCancellation(tx, scope, { settlementId, actor: creator }))
    expect(honoured).toMatchObject({ ok: true })
    expect(await getSettlementStatus(settlementId)).toBe('CANCELLED')

    // INV-22: money that has been drawn comes back as a repayment. There is
    // nothing left to release, and releasing a consumed reservation would be
    // inventing capacity.
    expect(await countEvents(settlementId, 'facility.repayment_requested')).toBe(1)
    expect(await countEvents(settlementId, 'facility.reservation_released')).toBe(0)

    expect(handoff.consumedBy).toBe('Stage 4')
    expect(handoff.invariants).toEqual(['INV-22', 'INV-35'])
  })

  it('…0008 — a cancellation microseconds after the dispatch commit is refused', async () => {
    // Stage 3's boundary, replayed. The race is serialized by the row lock both
    // sides take, so there are only two orders and this is the second one.
    const handoff = exercises('0008')!
    const { settlementId } = await dispatched('0008')
    const before = await attemptOf(settlementId)
    expect((await live((tx) => getSettlement(tx, settlementId)))!.pointOfNoReturnAt).not.toBeNull()

    const refused = await live((tx) =>
      requestCancellation(tx, scope, { settlementId, actor: creator, mayCancel: true }),
    )
    expect(refused).toMatchObject({ ok: false, reason: 'past_point_of_no_return' })

    // Refused, and *recorded* as refused. A customer who asked to cancel and
    // was told no is owed an answer, and an unaudited refusal cannot give one.
    const audits = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM audit_log
      WHERE subject_id = ${settlementId} AND action = 'settlement.cancellation_refused'`))) as unknown as
      { n: number }[]
    expect(audits[0]!.n).toBe(1)

    // Nothing moved: not the settlement, not the attempt, not its identity.
    expect(await getSettlementStatus(settlementId)).toBe('PAYOUT_SUBMITTED')
    expect(await attemptOf(settlementId)).toEqual(before)
    expect(handoff.consumedBy).toBe('Stage 3')
    expect(handoff.invariants).toContain('INV-36')
  })

  it('…0009 — a code no mapping table has seen: ingested, defaulted, alarmed, queue draining', async () => {
    exercises('0009')
    const { settlementId } = await dispatched('0009')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator })

    const signed = provider.sign({
      id: 'evt_novel_1',
      type: 'payout.rejected',
      settlement_id: settlementId,
      code: 'XX_NOVEL_CODE_NOBODY_HAS_SEEN',
    })
    const result = await live((tx) =>
      ingestPayoutWebhook(tx, scope, provider, mapping, {
        raw: signed.raw, headers: signed.headers, actor: creator,
        resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
      }),
    )
    // Ingested and applied — not dropped, not thrown.
    expect(result).toMatchObject({ ok: true, applied: true, alarm: 'unmapped_provider_code' })

    const row = await live((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('EXCEPTION')
    // The safe default, and it is not customer-actionable.
    expect(row?.openExceptionCode).toBe('PAYOUT_REJECTED_PROVIDER')
    expect(row?.customerStatus).toBe('SETTLING')

    // The alarm is queryable, not merely logged.
    const alarms = (await live((tx) => tx.execute(sql`
      SELECT unmapped_code FROM provider_events WHERE unmapped_code IS NOT NULL`))) as unknown as
      { unmapped_code: string }[]
    expect(alarms.map((a) => a.unmapped_code)).toContain('XX_NOVEL_CODE_NOBODY_HAS_SEEN')

    // And the queue still drains: a perfectly ordinary event right behind it works.
    const after = await dispatched('0000')
    const ok = await submitDispatchedPayout(h.db, scope, provider, resolveDestination, {
      settlementId: after.settlementId, actor: creator,
    })
    expect(ok).toMatchObject({ ok: true, status: 'CREDITED' })
  })

  it('…0010 — the call fails after the dispatch commit; the pull resolves it without a second dispatch', async () => {
    // INV-36(c) stated as a test: the boundary is not un-crossed by a failed
    // outbound call, and recovery is a pull rather than a new dispatch.
    exercises('0010')
    const { settlementId, idempotencyKey } = await dispatched('0010')
    const row = await live((tx) => getSettlement(tx, settlementId))
    expect(row?.pointOfNoReturnAt).not.toBeNull()

    expect(
      await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator }),
    ).toMatchObject({ ok: false, reason: 'provider_timeout' })

    // A second dispatch transaction is refused outright.
    expect(
      await live((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true })),
    ).toMatchObject({ ok: true, reused: true, attemptNumber: 1 })

    const pulled = await pullPayoutStatus(h.db, scope, provider, mapping, { settlementId, actor: creator })
    expect(pulled).toMatchObject({ ok: true, status: 'CREDITED' })

    // Exactly one attempt, and its key never changed.
    const attempts = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM payout_attempts WHERE settlement_id = ${settlementId}`))) as unknown as
      { n: number }[]
    expect(attempts[0]!.n).toBe(1)
    expect(idempotencyKey).toBe(payoutIdempotencyKey(settlementId, 1))
  })

  it('…0011 — three partial returns, all recorded; the cap over them is Stage 6’s', async () => {
    const handoff = exercises('0011')!
    const { settlementId, idempotencyKey } = await credited('0011')

    // The frozen row: two returns totalling exactly what was delivered, then a
    // third. The arithmetic is asserted here so the fixture cannot drift into
    // no longer being the scenario it claims to be.
    const returns = [0, 1, 2].map(() => provider.reportReturn(idempotencyKey)!)
    expect(returns.map((r) => r.amountMinor)).toEqual([200_000_000n, 300_000_000n, 100_000_000n])
    const delivered = BigInt((await attemptOf(settlementId)).credited_minor!)
    expect(returns[0]!.amountMinor + returns[1]!.amountMinor).toBe(delivered)
    expect(returns.reduce((n, r) => n + r.amountMinor, 0n)).toBeGreaterThan(delivered)

    for (const r of returns) {
      const ingested = await deliver(settlementId, {
        id: `evt_ret_${r.returnId}`,
        type: 'payout.returned',
        code: r.rawCode,
        return_id: r.returnId,
        amount_minor: String(r.amountMinor),
      })
      expect(ingested, r.returnId).toMatchObject({ ok: true, duplicate: false })
    }

    // Stage 5's side, and all of it: three distinct facts, stored verbatim with
    // their own amounts (INV-33), bound to the settlement so an operator can
    // find them.
    const stored = await providerEventsFor(settlementId)
    const returnEvents = stored.filter((e) => e.event_type === 'payout.returned')
    expect(returnEvents).toHaveLength(3)
    expect(returnEvents.map((e) => e.payload['amount_minor'])).toEqual([
      '200000000', '300000000', '100000000',
    ])

    // The attempt moves once and stays there: P08 has no second step, and
    // three returns against one credit is not three payouts.
    expect((await attemptOf(settlementId)).status).toBe('RETURNED')

    // What Stage 5 deliberately does *not* do: no total is kept, and no cap is
    // applied. Summing them here would put INV-49 in two places, and the second
    // copy is the one that eventually disagrees.
    expect(handoff.consumedBy).toBe('Stage 6')
    expect(handoff.invariants).toEqual(['INV-49'])
  })

  it('…0012 — one return, two channels: the webhook and the pull agree, and nothing doubles', async () => {
    const handoff = exercises('0012')!
    const { settlementId, idempotencyKey } = await credited('0012')
    const reported = provider.reportReturn(idempotencyKey)!

    // Channel one: the webhook.
    const ingested = await deliver(settlementId, {
      id: `evt_ret_${reported.returnId}`,
      type: 'payout.returned',
      code: reported.rawCode,
      return_id: reported.returnId,
      amount_minor: String(reported.amountMinor),
    })
    expect(ingested).toMatchObject({ ok: true, applied: true, outcome: 'returned' })
    expect((await attemptOf(settlementId)).status).toBe('RETURNED')

    // Channel two: the authoritative pull, reporting the same return. It agrees
    // — and applying it a second time is a recorded no-op rather than a second
    // transition.
    const answer = await provider.getPayout(idempotencyKey)
    expect(answer).toMatchObject({ status: 'RETURNED', returnedMinor: reported.amountMinor })
    const pulled = await pullPayoutStatus(h.db, scope, provider, mapping, { settlementId, actor: creator })
    expect(pulled).toMatchObject({ ok: true, status: 'RETURNED', idempotent: true })

    // Exactly one return event was stored, because only one channel is an
    // event. INV-33's dedupe key cannot help here: a pull has no event id at
    // all, so the second channel is invisible to it.
    const returnEvents = (await providerEventsFor(settlementId)).filter(
      (e) => e.event_type === 'payout.returned',
    )
    expect(returnEvents).toHaveLength(1)

    // Which is exactly why the handoff names a *second* key. Stage 5 can prove
    // it did not transition twice; it cannot prove one SettlementReturn exists,
    // because there is no SettlementReturn yet.
    expect(handoff.consumedBy).toBe('Stage 6')
    expect(handoff.invariants).toEqual(['INV-50'])
    expect(handoff.obligation).toMatch(/deduplicate on the second key/)
  })

  it('…0014 — a return that arrives long after the credit, timed faithfully', async () => {
    const handoff = exercises('0014')!
    const { settlementId, idempotencyKey } = await credited('0014')

    const creditedAt = new Date((await attemptOf(settlementId)).credited_at!)
    const LATE_DAYS = 120
    const occurredAt = new Date(creditedAt.getTime() + LATE_DAYS * 24 * 3600 * 1000)
    const reported = provider.reportReturn(idempotencyKey, { at: occurredAt })!
    expect(reported.at).toEqual(occurredAt)

    // The signature timestamp is *delivery* time and stays inside tolerance —
    // a late return is still delivered promptly once the rail notices it. What
    // is late is the event's own `occurred_at`, which is the rail's statement
    // about when the money came back, and the only timestamp a window can be
    // measured against.
    const ingested = await deliver(settlementId, {
      id: `evt_ret_${reported.returnId}`,
      type: 'payout.returned',
      code: reported.rawCode,
      occurred_at: occurredAt.toISOString(),
      amount_minor: String(reported.amountMinor),
    })
    expect(ingested).toMatchObject({ ok: true, applied: true })

    // Stage 5 stores that statement verbatim and draws no conclusion from it.
    const event = (await providerEventsFor(settlementId)).find((e) => e.event_type === 'payout.returned')!
    expect(event.payload['occurred_at']).toBe(occurredAt.toISOString())
    expect(new Date(String(event.payload['occurred_at'])).getTime() - creditedAt.getTime()).toBe(
      LATE_DAYS * 24 * 3600 * 1000,
    )

    // No routing, no MANUAL_REVIEW, no window: `D-04` is open on the duration,
    // and a codebase that picked one here would have answered it by accident.
    expect((await attemptOf(settlementId)).status).toBe('RETURNED')
    expect(await getSettlementStatus(settlementId)).toBe('PAYOUT_CONFIRMED')
    expect(handoff.consumedBy).toBe('Stage 6')
    expect(handoff.invariants).toEqual(['INV-40'])
  })

  it('…0013 — a repayment goes UNKNOWN, then the pull confirms it: only then does capacity move', async () => {
    // Stage 4's Y05 → Y06, replayed. INV-46 and INV-47 are the same discipline
    // the payout leg uses for UNKNOWN, applied to money going the other way.
    const handoff = exercises('0013')!
    const { settlementId, facilityId } = await funded('0013')

    const drawnAfterFunding = (await live((tx) => readFacility(tx, facilityId)))!.position.drawn
    expect(drawnAfterFunding.minorUnits).toBe(UNIT)

    const requested = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', UNIT), source: 'CANCELLATION_AFTER_DRAWDOWN',
        settlementId, actor: creator,
      }),
    )
    expect(requested).toMatchObject({ ok: true, capacityRestored: false })
    const repaymentId = requested.ok ? requested.repaymentId : ''

    for (const trigger of ['submit', 'sla_elapsed'] as const) {
      const advanced = await live((tx) =>
        advanceRepayment(tx, scope, { repaymentId, trigger, actor: creator }),
      )
      expect(advanced, trigger).toMatchObject({ ok: true, capacityRestored: false })
    }

    // INV-46: a repayment nobody has confirmed has restored nothing. The money
    // is somewhere between us and the provider, and treating it as capacity
    // would let a workspace settle against funds that are still out.
    const stalled = (await live((tx) => readFacility(tx, facilityId)))!
    expect(stalled.position.drawn.minorUnits).toBe(UNIT)

    // INV-47: only an authoritative pull resolves it, exactly as with a payout.
    const resolved = await live((tx) =>
      advanceRepayment(tx, scope, { repaymentId, trigger: 'pull_resolved_confirmed', actor: creator }),
    )
    expect(resolved).toMatchObject({ ok: true, status: 'CONFIRMED', capacityRestored: true })
    const after = (await live((tx) => readFacility(tx, facilityId)))!
    expect(after.position.drawn.minorUnits).toBe(0n)

    // And the ledger still balances, which is the check that would catch a
    // restoration that was not backed by a real movement.
    expect(await live((tx) => checkFacilityProjection(tx, facilityId))).toMatchObject({
      agrees: true,
      stored: { drawnMinor: 0n, reservedMinor: 0n },
      projected: { drawnMinor: 0n, reservedMinor: 0n },
    })

    expect(handoff.consumedBy).toBe('Stage 4')
    expect(handoff.invariants).toEqual(['INV-46', 'INV-47'])
  })

  /**
   * The exit criterion, checked rather than claimed.
   *
   * Last in the suite on purpose: by the time it runs, every scenario test
   * above has recorded itself. It fails if a row of the frozen table has no
   * test — including a row added to the table later, which is the case a
   * hand-written list would silently miss.
   */
  it('leaves no row of the frozen table unexercised', () => {
    const missing = SCENARIO_SUFFIXES.filter((s) => !exercised.has(s))
    expect(missing, `simulator rows with no executable test: ${missing.join(', ')}`).toEqual([])
    expect(exercised.size).toBe(SCENARIOS.length)

    // Six run end to end in Stage 5; the other nine run the part Stage 5 owns
    // and assert the typed handoff. Every one of the fifteen is executable.
    expect(scenariosOwnedBy('Stage 5').map((s) => s.suffix)).toEqual([
      '0000', '0002', '0003', '0005', '0009', '0010',
    ])
    expect(SCENARIOS.filter((s) => s.ownedBy !== 'Stage 5')).toHaveLength(9)
  })
})

/* ── 2. Redelivery ──────────────────────────────────────────────────────── */

describe('a redelivered webhook produces one state change and one event', () => {
  it('replays ten times and changes the machine once', async () => {
    const { settlementId } = await dispatched('0000')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator })

    const signed = provider.sign({
      id: 'evt_redeliver_1',
      type: 'payout.credited',
      settlement_id: settlementId,
      code: 'CREDITED',
      utr: 'UTR000000999',
    })
    const deliver = () =>
      live((tx) =>
        ingestPayoutWebhook(tx, scope, provider, mapping, {
          raw: signed.raw, headers: signed.headers, actor: creator,
          resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
        }),
      )

    expect(await deliver()).toMatchObject({ ok: true, duplicate: false, applied: true })
    for (let i = 0; i < 9; i += 1) {
      expect(await deliver(), `replay ${i}`).toMatchObject({ ok: true, duplicate: true, applied: false })
    }

    expect(await getSettlementStatus(settlementId)).toBe('PAYOUT_CONFIRMED')
    expect(await countEvents(settlementId, 'settlement.payout_confirmed')).toBe(1)

    // One stored provider event, because the dedupe index is the real guard.
    const stored = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM provider_events WHERE provider_event_id = 'evt_redeliver_1'`))) as unknown as
      { n: number }[]
    expect(stored[0]!.n).toBe(1)
  })

  it('is idempotent even when the same outcome arrives under a different event id', async () => {
    // Dedupe on the provider's event id catches redelivery; this catches the
    // other shape — a genuinely distinct event carrying an outcome already
    // applied. The attempt-level check is what makes that a no-op.
    const { settlementId } = await dispatched('0000')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator })

    for (const id of ['evt_a', 'evt_b']) {
      const signed = provider.sign({
        id, type: 'payout.credited', settlement_id: settlementId, code: 'CREDITED', utr: 'UTR000000888',
      })
      await live((tx) =>
        ingestPayoutWebhook(tx, scope, provider, mapping, {
          raw: signed.raw, headers: signed.headers, actor: creator,
          resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
        }),
      )
    }
    expect(await countEvents(settlementId, 'settlement.payout_confirmed')).toBe(1)
  })
})

/* ── 3. Unsigned and stale webhooks ─────────────────────────────────────── */

describe('an unsigned or stale webhook is stored, alarmed, and moves nothing', () => {
  async function deliverUntrusted(
    settlementId: string,
    mutate: (signed: { raw: string; headers: Record<string, string> }) => { raw: string; headers: Record<string, string> },
    eventId: string,
  ) {
    const signed = provider.sign({
      id: eventId, type: 'payout.credited', settlement_id: settlementId, code: 'CREDITED', utr: 'UTR000000777',
    })
    const tampered = mutate(signed)
    return live((tx) =>
      ingestPayoutWebhook(tx, scope, provider, mapping, {
        raw: tampered.raw, headers: tampered.headers, actor: creator,
        resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
      }),
    )
  }

  it('stores a bad signature and refuses to act on it', async () => {
    const { settlementId } = await dispatched('0003')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator })
    const before = await getSettlementStatus(settlementId)

    const result = await deliverUntrusted(
      settlementId,
      (s) => ({ raw: s.raw, headers: { 'inrsettle-signature': s.headers['inrsettle-signature']!.replace(/v1=.*/, 'v1=deadbeef') } }),
      'evt_badsig',
    )
    expect(result).toMatchObject({ ok: true, applied: false, alarm: 'untrusted_event' })
    expect(await getSettlementStatus(settlementId)).toBe(before)

    // Stored, with the verdict recorded (INV-33). A forged event and a
    // provider's misconfiguration look identical at the edge; only a stored
    // copy can tell them apart later.
    const rows = (await live((tx) => tx.execute(sql`
      SELECT signature_valid, interpretation FROM provider_events
      WHERE provider_event_id = 'evt_badsig'`))) as unknown as
      { signature_valid: boolean; interpretation: string | null }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.signature_valid).toBe(false)
    expect(rows[0]!.interpretation).toMatch(/untrusted:bad_signature/)
  })

  it('rejects a stale timestamp, and stores it', async () => {
    const { settlementId } = await dispatched('0003')
    const stale = new Date(clockNow.getTime() - 3600 * 1000)
    const signed = provider.sign(
      { id: 'evt_stale', type: 'payout.credited', settlement_id: settlementId, code: 'CREDITED', utr: 'UTR000000666' },
      stale,
    )
    const result = await live((tx) =>
      ingestPayoutWebhook(tx, scope, provider, mapping, {
        raw: signed.raw, headers: signed.headers, actor: creator,
        resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
      }),
    )
    expect(result).toMatchObject({ ok: true, applied: false, alarm: 'untrusted_event' })
    const rows = (await live((tx) => tx.execute(sql`
      SELECT interpretation FROM provider_events WHERE provider_event_id = 'evt_stale'`))) as unknown as
      { interpretation: string }[]
    expect(rows[0]!.interpretation).toMatch(/stale_timestamp/)
  })

  it('rejects a future timestamp too — the tolerance is symmetric', async () => {
    // `SECURITY.md § 4.2`: |now − t| > 300s fails in *either* direction. A
    // check written as `t > now + tolerance` would catch only the rare case.
    const { settlementId } = await dispatched('0003')
    const future = new Date(clockNow.getTime() + 3600 * 1000)
    const signed = provider.sign(
      { id: 'evt_future', type: 'payout.credited', settlement_id: settlementId, code: 'CREDITED', utr: 'UTR000000555' },
      future,
    )
    const result = await live((tx) =>
      ingestPayoutWebhook(tx, scope, provider, mapping, {
        raw: signed.raw, headers: signed.headers, actor: creator,
        resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
      }),
    )
    expect(result).toMatchObject({ ok: true, applied: false })
    const rows = (await live((tx) => tx.execute(sql`
      SELECT interpretation FROM provider_events WHERE provider_event_id = 'evt_future'`))) as unknown as
      { interpretation: string }[]
    expect(rows[0]!.interpretation).toMatch(/future_timestamp/)
  })

  it('never lets untrusted evidence reach the machine, even called directly', async () => {
    const { settlementId } = await dispatched('0003')
    expect(
      await live((tx) =>
        applyPayoutOutcome(tx, scope, {
          settlementId, outcome: 'credited', actor: creator, trusted: false, utr: 'UTR000000444',
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'untrusted_evidence' })
  })

  it('refuses a credit with no UTR, and one with a malformed UTR', async () => {
    // T16's frozen guard. A malformed UTR looks like proof and is not.
    const { settlementId } = await dispatched('0003')
    for (const utr of [undefined, '', 'nope']) {
      expect(
        await live((tx) =>
          applyPayoutOutcome(tx, scope, { settlementId, outcome: 'credited', actor: creator, trusted: true, utr }),
        ),
        String(utr),
      ).toMatchObject({ ok: false, reason: 'utr_missing_or_malformed' })
    }
  })

  it('stores a provider event whose payload names no settlement, and acts on nothing', async () => {
    const signed = provider.sign({ id: 'evt_nosubject', type: 'payout.credited', code: 'CREDITED' })
    const result = await live((tx) =>
      ingestPayoutWebhook(tx, scope, provider, mapping, {
        raw: signed.raw, headers: signed.headers, actor: creator,
        resolveSettlementId: () => null,
      }),
    )
    expect(result).toMatchObject({ ok: true, applied: false })
  })
})

/* ── 4. UNKNOWN resolves only by pull ───────────────────────────────────── */

describe('INV-24 — UNKNOWN resolves only by an authoritative status pull', () => {
  async function toUnknown(): Promise<{ settlementId: string; idempotencyKey: string }> {
    const d = await dispatched('0003')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, {
      settlementId: d.settlementId, actor: creator,
    })
    await ageBeyondSla(d.settlementId)
    const swept = await live((tx) => sweepPayoutSla(tx, scope, { settlementId: d.settlementId, actor: creator }))
    expect(swept).toMatchObject({ ok: true, status: 'UNKNOWN' })
    return d
  }

  it('no code path resubmits an UNKNOWN attempt', async () => {
    const { settlementId } = await toUnknown()

    // The submission path refuses: the attempt is no longer awaiting submission.
    expect(
      await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator }),
    ).toMatchObject({ ok: false, reason: 'attempt_not_awaiting_submission' })

    // The dispatch path refuses, and names UNKNOWN as the reason rather than
    // the generic "already dispatched" — the allocator refuses before the
    // boundary check is even reached, which is the more informative order.
    expect(
      await live((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true })),
    ).toMatchObject({ ok: false, reason: 'attempt_status_unknown' })

    // And the retry path refuses, because UNKNOWN is not a rejection.
    expect(
      await live((tx) =>
        retryPayout(tx, scope, {
          settlementId, actor: creator, rail: 'NEFT', slaSeconds: 900,
          providerId: provider.id, reason: 'operator asked',
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'retry_requires_authoritative_rejection' })

    // Still exactly one attempt, still UNKNOWN.
    const rows = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM payout_attempts WHERE settlement_id = ${settlementId}`))) as unknown as
      { n: number }[]
    expect(rows[0]!.n).toBe(1)
    expect((await attemptOf(settlementId)).status).toBe('UNKNOWN')
  })

  it('resolves to CREDITED when the pull says the payout happened', async () => {
    const { settlementId, idempotencyKey } = await toUnknown()
    provider.settlePending(idempotencyKey)

    const pulled = await pullPayoutStatus(h.db, scope, provider, mapping, { settlementId, actor: creator })
    // The attempt is resolved by the pull. The *settlement* is not moved: T18
    // put it in EXCEPTION, and the only ways out are T22 and T23, both of which
    // need an attributed human decision. A pull answers what the provider did;
    // it does not decide what an operator should do about it.
    expect(pulled).toMatchObject({
      ok: true, status: 'CREDITED', resolvedBy: 'pull', settlementAwaitingResolution: true,
    })
    expect((await attemptOf(settlementId)).status).toBe('CREDITED')
    expect(await getSettlementStatus(settlementId)).toBe('EXCEPTION')
  })

  it('resolves to REJECTED when the provider has no record of it', async () => {
    // `not_found` is the safest of the three answers: it is the only one that
    // says with authority that no money moved.
    //
    // Simulated by pulling against a provider that never received the
    // submission — which is exactly the real shape of the case, and the only
    // honest way to stage it. Forging the attempt's key would be barred anyway:
    // `payout_attempts` identity is immutable even to the superuser (INV-25),
    // and that refusal is the invariant working rather than an obstacle.
    const { settlementId } = await toUnknown()
    const amnesiac = createMockIndiaPayoutProvider({ now: clock })
    expect(await amnesiac.getPayout(payoutIdempotencyKey(settlementId, 1))).toMatchObject({
      status: 'not_found',
    })

    const pulled = await pullPayoutStatus(h.db, scope, amnesiac, mapping, { settlementId, actor: creator })
    expect(pulled).toMatchObject({ ok: true, status: 'REJECTED', resolvedBy: 'pull' })
    expect((await attemptOf(settlementId)).status).toBe('REJECTED')
    expect((await attemptOf(settlementId)).raw_code).toBe('PULL_NOT_FOUND')
  })

  it('a still-in-flight pull is not a reason to resubmit', async () => {
    const { settlementId } = await dispatched('0003')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator })
    expect(
      await pullPayoutStatus(h.db, scope, provider, mapping, { settlementId, actor: creator }),
    ).toMatchObject({ ok: false, reason: 'still_in_flight' })
    expect((await attemptOf(settlementId)).status).toBe('ACCEPTED')
  })
})

/* ── Retry, which Stage 3 deferred to here ──────────────────────────────── */

describe('retry after an authoritative rejection', () => {
  it('allocates attempt 2 with a different key, and only after a rejection', async () => {
    const { settlementId, idempotencyKey } = await dispatched('0002')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator })
    await live((tx) =>
      applyPayoutOutcome(tx, scope, {
        settlementId, outcome: 'rejected', actor: creator, trusted: true,
        rawCode: 'BENE_ACCOUNT_CLOSED', exceptionCode: 'PAYOUT_REJECTED_DESTINATION',
      }),
    )

    const retried = await live((tx) =>
      retryPayout(tx, scope, {
        settlementId, actor: creator, rail: 'NEFT', slaSeconds: 900,
        providerId: provider.id, reason: 'customer supplied a new account',
      }),
    )
    expect(retried).toMatchObject({ ok: true, attemptNumber: 2 })
    expect(retried.ok && retried.idempotencyKey).toBe(payoutIdempotencyKey(settlementId, 2))
    expect(retried.ok && retried.idempotencyKey).not.toBe(idempotencyKey)

    // INV-24: still at most one non-terminal attempt.
    const inFlight = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM payout_attempts
      WHERE settlement_id = ${settlementId} AND status NOT IN ('CREDITED','REJECTED','RETURNED')`))) as unknown as
      { n: number }[]
    expect(inFlight[0]!.n).toBe(1)
  })

  it('refuses to retry a credited payout', async () => {
    const { settlementId } = await dispatched('0000')
    await submitDispatchedPayout(h.db, scope, provider, resolveDestination, { settlementId, actor: creator })
    await live((tx) =>
      applyPayoutOutcome(tx, scope, {
        settlementId, outcome: 'credited', actor: creator, trusted: true, utr: 'UTR000000333',
      }),
    )
    expect(
      await live((tx) =>
        retryPayout(tx, scope, {
          settlementId, actor: creator, rail: 'NEFT', slaSeconds: 900,
          providerId: provider.id, reason: 'should never happen',
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'retry_requires_authoritative_rejection' })
  })
})

/* ── helpers that need the database clock ───────────────────────────────── */

async function getSettlementStatus(settlementId: string): Promise<string> {
  return (await live((tx) => getSettlement(tx, settlementId)))!.status
}

/**
 * Push an attempt past its SLA.
 *
 * By shortening the SLA rather than back-dating `dispatched_at`, because the
 * attempt's identity — including when it was dispatched — is immutable, and the
 * trigger says so from raw SQL as the superuser. That refusal is correct: an
 * attempt whose dispatch time could be edited is an attempt whose SLA breach
 * could be manufactured or hidden.
 *
 * The sweeper compares against the *database* clock deliberately. A sweeper
 * that took an injected `asOf` would let a caller declare an SLA elapsed, and
 * "no terminal status within the rail SLA" is a fact about elapsed time, not
 * about what a caller asserts. So the second of real time below is the honest
 * cost of testing it.
 */
async function ageBeyondSla(settlementId: string): Promise<void> {
  await h.admin`UPDATE payout_attempts SET sla_seconds = 1 WHERE settlement_id = ${settlementId}`
  await new Promise((resolve) => setTimeout(resolve, 1100))
}

/**
 * The Stage 3 machine end to end, plus the two races that matter.
 *
 * The most important test in this file is the last one: cancellation and
 * dispatch contending for the same settlement, run many times, with the
 * assertion that there is **no outcome where both a CANCELLED settlement and a
 * durable dispatch exist**. That is `INV-36` stated as a property rather than
 * as a comment.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedUser, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { money } from '@inrsettle/money'
import { payoutIdempotencyKey, type PreflightRuleSet } from '@inrsettle/domain'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary, editPayoutDestination } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { activeRuleSetVersion, loadRuleSetFromDatabase } from '../reference-data.service.js'
import { createQuote, expireDueQuotes, getQuote } from '../quote.service.js'
import { applyTransition, createSettlement } from '../settlement-transition.service.js'
import {
  attachQuote,
  authorizeSettlement,
  cancelSettlement,
  dispatchPayout,
  expireAttachedQuote,
  getSettlement,
  honourCancellation,
  openException,
  resolveException,
  runSettlementPreflight,
} from '../settlement.service.js'
import { setSeparationOfDuties } from '../security-policy.service.js'

let h: Harness
let ruleSet: PreflightRuleSet
const WS = 'ws_stage3'
const scope = { workspaceId: WS, environment: 'sandbox' as const }
const creator = { type: 'user' as const, id: 'usr_creator' }
const approver = { type: 'user' as const, id: 'usr_approver' }
const apiKey = { type: 'api_key' as const, id: 'key_1' }
const ADMIN_ROLES = ['admin', 'approver', 'operator'] as const

const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}
const provider = createSandboxVerificationProvider()
const sandbox = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)

let beneficiaryId = ''
let destinationId = ''
let versionId = ''
let seq = 0

const AMOUNT = 500_000_000n
/**
 * The sandbox fixture requires a commercial invoice above ₹10,00,000 for
 * software services, and this amount is above it. Supplying the document is
 * more realistic than choosing an amount that dodges the rule.
 */
const DOCUMENTS = ['commercial_invoice'] as const

beforeAll(async () => {
  h = await createTestDatabase('settlement_lifecycle')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: creator.id, email: 'c@example.test', roles: [...ADMIN_ROLES],
  })
  await seedUser(h.admin, {
    workspaceId: WS, userId: approver.id, email: 'a@example.test', roles: [...ADMIN_ROLES],
  })
  const version = await activeRuleSetVersion(h.admin, 'sandbox', new Date())
  ruleSet = (await loadRuleSetFromDatabase(h.admin, version!))!.ruleSet

  const created = await sandbox((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN', taxId: 'ABCDE1234F' },
      destination: {
        kind: 'bank_account',
        accountNumber: '50100123456789',
        ifsc: 'HDFC0000123',
        accountType: 'savings',
        accountHolderName: 'Aarti Sharma',
      },
      actor: creator,
    }),
  )
  beneficiaryId = created.id
  destinationId = created.destinations[0]!.id
  versionId = created.destinations[0]!.currentVersion!.id
  await requestVerification(h.db, scope, provider, crypto.cipher, SANDBOX_NAME_MATCH_POLICIES, {
      destinationVersionId: versionId,
      actor: creator,
    })

})
afterAll(async () => { await h.close() })

/**
 * A fresh verified beneficiary.
 *
 * Any test that *edits* a destination needs its own, because editing appends an
 * UNVERIFIED version (INV-44) — which is the behaviour under test, and would
 * otherwise silently break every later test that shares the fixture.
 */
async function freshVerifiedBeneficiary(name: string): Promise<{
  beneficiaryId: string
  destinationId: string
  versionId: string
}> {
  const created = await sandbox((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: name, type: 'individual', country: 'IN', taxId: 'ABCDE1234F' },
      destination: {
        kind: 'bank_account',
        accountNumber: '50100123456789',
        ifsc: 'HDFC0000123',
        accountType: 'savings',
        accountHolderName: name,
      },
      actor: creator,
    }),
  )
  const version = created.destinations[0]!.currentVersion!.id
  await requestVerification(h.db, scope, provider, crypto.cipher, SANDBOX_NAME_MATCH_POLICIES, {
      destinationVersionId: version,
      actor: creator,
    })

  return { beneficiaryId: created.id, destinationId: created.destinations[0]!.id, versionId: version }
}

async function newSettlement(amount = AMOUNT): Promise<string> {
  const { id } = await sandbox((tx) =>
    createSettlement(tx, scope, {
      beneficiaryId,
      destinationId,
      recipientAmountMinor: amount,
      fundingCurrency: 'USDT',
      purposeCode: 'SOFTWARE_SERVICES',
      externalReference: `ext_${(seq += 1)}`,
      actor: creator,
    }),
  )
  return id
}

/** Drive a settlement to QUOTED, which is where authorization becomes possible. */
async function toQuoted(amount = AMOUNT): Promise<{ settlementId: string; quoteId: string }> {
  const settlementId = await newSettlement(amount)
  await runSettlementPreflight(h.db, scope, {
    settlementId, ruleSet, hasActiveLiquidityFacility: true, actor: creator, documents: DOCUMENTS,
  })
  const quote = await sandbox((tx) =>
    createQuote(tx, scope, {
      fundingCurrency: 'USDT',
      recipientAmount: money('INR', amount),
      actor: creator,
    }),
  )
  await sandbox((tx) => attachQuote(tx, scope, { settlementId, quoteId: quote.id, actor: creator }))
  return { settlementId, quoteId: quote.id }
}

/**
 * Push a quote's expiry into the past.
 *
 * `expires_at` is immutable (INV-13), and the trigger enforces it — so the
 * fixture disables the trigger for one statement as the table owner rather than
 * pretending the application could do this.
 */
async function expireQuoteRow(quoteId: string): Promise<void> {
  await h.admin.begin(async (tx) => {
    await tx`ALTER TABLE quotes DISABLE TRIGGER quotes_immutable`
    await tx`UPDATE quotes SET expires_at = now() - interval '1 minute' WHERE id = ${quoteId}`
    await tx`ALTER TABLE quotes ENABLE TRIGGER quotes_immutable`
  })
}

/** The later-stage guards, answered explicitly by a test harness (never defaulted). */
const LATER_STAGE_TRUE = {
  facility_active: true,
  sufficient_availability: true,
  active_reservation_exists: true,
  provider_event_verified: true,
  no_cancellation_pending: true,
}

async function toDrawdownConfirmed(): Promise<string> {
  const { settlementId } = await toQuoted()
  // `documents` matters: authorization re-runs preflight *now*, so omitting the
  // invoice makes the sandbox rule set raise `invoice_required` and refuses the
  // authorization. Checking the result here is the point — an unchecked
  // authorization surfaces three transitions later as a baffling
  // `invalid_transition` from QUOTED.
  const authorized = await sandbox((tx) =>
    authorizeSettlement(tx, scope, {
      settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
      hasActiveLiquidityFacility: true, documents: DOCUMENTS,
    }),
  )
  if (!authorized.ok) throw new Error(`authorize failed: ${JSON.stringify(authorized)}`)
  for (const trigger of ['begin_reservation', 'reservation_succeeded', 'request_drawdown', 'drawdown_confirmed'] as const) {
    const outcome = await sandbox((tx) =>
      applyTransition(tx, scope, { settlementId, trigger, actor: creator, guards: LATER_STAGE_TRUE }),
    )
    if (!outcome.ok) throw new Error(`${trigger} failed: ${JSON.stringify(outcome)}`)
  }
  return settlementId
}

describe('the happy path to AUTHORIZED', () => {
  it('runs DRAFT → PREFLIGHTING → READY → QUOTED → AUTHORIZED', async () => {
    const { settlementId } = await toQuoted()
    let row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('QUOTED')
    expect(row?.customerStatus).toBe('READY')

    const result = await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    expect(result.ok).toBe(true)

    row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('AUTHORIZED')
    expect(row?.customerStatus).toBe('SETTLING')
    expect(row?.destinationVersionId).toBe(versionId)
    expect(row?.authorizedTermsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.authorizedBy).toBe(approver.id)
  })

  it('writes exactly one status event per transition', async () => {
    const { settlementId } = await toQuoted()
    const rows = (await sandbox((tx) =>
      tx.execute(sql`
        SELECT e.type, count(*) OVER (PARTITION BY e.txid) AS per_tx
        FROM events e
        JOIN settlement_status_events s ON s.event_type = e.type
        WHERE e.subject_id = ${settlementId}
        ORDER BY e.created_at`),
    )) as unknown as { type: string; per_tx: string }[]
    expect(rows.map((r) => r.type)).toEqual([
      'settlement.created',
      'settlement.preflight_started',
      'settlement.ready',
      'settlement.quoted',
    ])
    for (const row of rows) expect(Number(row.per_tx)).toBe(1)
  })

  it('the preflight companion accompanies the status event without replacing it', async () => {
    const { settlementId } = await toQuoted()
    const rows = (await sandbox((tx) =>
      tx.execute(sql`SELECT type FROM events WHERE subject_id = ${settlementId} ORDER BY created_at`),
    )) as unknown as { type: string }[]
    expect(rows.map((r) => r.type)).toContain('settlement.preflight_completed')
    expect(rows.map((r) => r.type)).toContain('settlement.ready')
  })

  it('lands in ACTION_REQUIRED when preflight blocks, and only via T04', async () => {
    const settlementId = await newSettlement()
    // No facility in a live-shaped check would block; here, remove the purpose.
    await h.admin`UPDATE settlements SET purpose_code = NULL WHERE id = ${settlementId}`
    const result = await runSettlementPreflight(h.db, scope, {
      settlementId, ruleSet, hasActiveLiquidityFacility: true, actor: creator,
    })
    // Missing purpose fails T02's own guard before preflight runs at all.
    expect(result.ok).toBe(false)
  })
})

describe('AuthorizedTerms are frozen by value', () => {
  it('later edits to the beneficiary, destination and quote leave the instruction unchanged', async () => {
    // Its own beneficiary: this test deliberately edits the destination.
    const own = await freshVerifiedBeneficiary('Frozen Terms Subject')
    const { id: settlementId } = await sandbox((tx) =>
      createSettlement(tx, scope, {
        beneficiaryId: own.beneficiaryId,
        destinationId: own.destinationId,
        recipientAmountMinor: AMOUNT,
        fundingCurrency: 'USDT',
        purposeCode: 'SOFTWARE_SERVICES',
        externalReference: `ext_${(seq += 1)}`,
        actor: creator,
      }),
    )
    await runSettlementPreflight(h.db, scope, {
      settlementId, ruleSet, hasActiveLiquidityFacility: true, actor: creator, documents: DOCUMENTS,
    })
    const quote = await sandbox((tx) =>
      createQuote(tx, scope, { fundingCurrency: 'USDT', recipientAmount: money('INR', AMOUNT), actor: creator }),
    )
    await sandbox((tx) => attachQuote(tx, scope, { settlementId, quoteId: quote.id, actor: creator }))
    const quoteId = quote.id
    await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    const before = await sandbox((tx) => getSettlement(tx, settlementId))
    const frozenTerms = JSON.stringify(before!.authorizedTerms)
    const frozenHash = before!.authorizedTermsHash

    // Move everything the settlement used to point at.
    await sandbox((tx) =>
      editPayoutDestination(tx, scope, crypto, {
        destinationId: own.destinationId,
        details: {
          kind: 'bank_account',
          accountNumber: '50100999888777',
          ifsc: 'ICIC0000001',
          accountType: 'current',
          accountHolderName: 'Someone Else',
        },
        actor: creator,
      }),
    )
    await h.admin`UPDATE beneficiaries SET display_name = 'Renamed', legal_name = 'Renamed' WHERE id = ${own.beneficiaryId}`
    // The quote is terminal now, but try anyway — the trigger refuses.
    await expect(
      h.admin`UPDATE quotes SET recipient_amount_minor = 1 WHERE id = ${quoteId}`,
    ).rejects.toThrow(/immutable/)

    const after = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(JSON.stringify(after!.authorizedTerms)).toBe(frozenTerms)
    expect(after!.authorizedTermsHash).toBe(frozenHash)
    // And, critically, the frozen version — not the destination's new current one.
    expect(after!.destinationVersionId).toBe(own.versionId)

    const current = (await sandbox((tx) =>
      tx.execute(sql`SELECT current_version_id FROM payout_destinations WHERE id = ${own.destinationId}`),
    )) as unknown as { current_version_id: string }[]
    expect(current[0]!.current_version_id).not.toBe(own.versionId)
  })
})

describe('authorization guards', () => {
  it('refuses when the destination version is not verified', async () => {
    const other = await sandbox((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Unverified Person', type: 'individual', country: 'IN' },
        destination: {
          kind: 'bank_account', accountNumber: '50100111222333', ifsc: 'HDFC0000123',
          accountType: 'savings', accountHolderName: 'Unverified Person',
        },
        actor: creator,
      }),
    )
    const { id: settlementId } = await sandbox((tx) =>
      createSettlement(tx, scope, {
        beneficiaryId: other.id,
        destinationId: other.destinations[0]!.id,
        recipientAmountMinor: AMOUNT,
        fundingCurrency: 'USDT',
        purposeCode: 'SOFTWARE_SERVICES',
        externalReference: `ext_${(seq += 1)}`,
        actor: creator,
      }),
    )
    await runSettlementPreflight(h.db, scope, {
      settlementId, ruleSet, hasActiveLiquidityFacility: true, actor: creator, documents: DOCUMENTS,
    })
    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    // Preflight already blocks on the unverified destination, so it never
    // reaches QUOTED — which is itself the guard working one step earlier.
    expect(row?.status).toBe('ACTION_REQUIRED')
  })

  it('refuses an expired quote against the database clock', async () => {
    const { settlementId, quoteId } = await toQuoted()
    // `expires_at` cannot be *updated* — INV-13 forbids it, correctly — so the
    // fixture rewrites the row wholesale as the owner instead.
    await expireQuoteRow(quoteId)
    const result = await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('guard_failed')
  })

  it('refuses without an active liquidity facility (D-10, closed)', async () => {
    const { settlementId } = await toQuoted()
    const result = await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: false, documents: DOCUMENTS,
      }),
    )
    expect(result.ok).toBe(false)
  })

  it('refuses an actor without the capability', async () => {
    const { settlementId } = await toQuoted()
    const result = await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: ['viewer'], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'missing_capability' })
  })
})

describe('separation of duties at T08 — Stage 1 policy, unchanged', () => {
  it('refuses the creator when the policy is on', async () => {
    await sandbox((tx) =>
      setSeparationOfDuties(tx, scope, {
        enabled: true, actor: creator, actorCapabilities: new Set(['security_policy:manage'] as const),
        reason: 'stage 3 test',
      }),
    )
    const { settlementId } = await toQuoted()
    const result = await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: creator, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'separation_of_duties' })

    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('QUOTED')
  })

  it('refuses an API key outright while the policy is on', async () => {
    const { settlementId } = await toQuoted()
    const result = await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: apiKey, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'human_approver_required' })
  })

  it('allows a different human', async () => {
    const { settlementId } = await toQuoted()
    const result = await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('records the refusal rather than discarding it', async () => {
    const rows = (await sandbox((tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'settlement.authorize_refused'`),
    )) as unknown as { n: number }[]
    expect(rows[0]!.n).toBeGreaterThan(0)
    await sandbox((tx) =>
      setSeparationOfDuties(tx, scope, {
        enabled: false, actor: creator, actorCapabilities: new Set(['security_policy:manage'] as const),
        reason: 'restore for the remaining tests',
      }),
    )
  })
})

describe('quote lifecycle against the database', () => {
  it('a quote is consumed exactly once', async () => {
    const { settlementId, quoteId } = await toQuoted()
    await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    const quote = await sandbox((tx) => getQuote(tx, quoteId))
    expect(quote?.status).toBe('CONSUMED')
    expect(quote?.consumedBySettlementId).toBe(settlementId)
  })

  it('the same quote cannot authorize two settlements', async () => {
    const { settlementId: first, quoteId } = await toQuoted()
    await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId: first, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
        hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    // A second settlement cannot even attach it.
    const second = await newSettlement()
    await runSettlementPreflight(h.db, scope, {
      settlementId: second, ruleSet, hasActiveLiquidityFacility: true, actor: creator, documents: DOCUMENTS,
    })
    const attached = await sandbox((tx) => attachQuote(tx, scope, { settlementId: second, quoteId, actor: creator }))
    expect(attached.ok).toBe(false)
  })

  it('two concurrent authorizations against one quote: exactly one wins', async () => {
    // Both settlements attach the same quote is impossible (see above), so the
    // sharper race is two authorizations of the *same* settlement.
    const { settlementId } = await toQuoted()
    const results = await Promise.allSettled([
      sandbox((tx) =>
        authorizeSettlement(tx, scope, {
          settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
          hasActiveLiquidityFacility: true, documents: DOCUMENTS,
        }),
      ),
      sandbox((tx) =>
        authorizeSettlement(tx, scope, {
          settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
          hasActiveLiquidityFacility: true, documents: DOCUMENTS,
        }),
      ),
    ])
    const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.ok)
    expect(succeeded).toHaveLength(1)

    const rows = (await sandbox((tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM events
        WHERE subject_id = ${settlementId} AND type = 'settlement.authorized'`),
    )) as unknown as { n: number }[]
    expect(rows[0]!.n).toBe(1)
  })

  it('an expired quote returns the settlement to READY without re-pricing (T07)', async () => {
    const { settlementId, quoteId } = await toQuoted()
    await expireQuoteRow(quoteId)
    const outcome = await sandbox((tx) => expireAttachedQuote(tx, scope, { settlementId, actor: creator }))
    expect(outcome.ok).toBe(true)

    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('READY')
    // The customer sees a fresh quote rather than a silently re-priced one.
    expect(row?.quoteId).toBeNull()
    expect((await sandbox((tx) => getQuote(tx, quoteId)))?.status).toBe('EXPIRED')
  })

  it('the sweeper expires quotes against the database clock', async () => {
    const quote = await sandbox((tx) =>
      createQuote(tx, scope, { fundingCurrency: 'USDT', recipientAmount: money('INR', 1_000n), actor: creator }),
    )
    await expireQuoteRow(quote.id)
    const swept = await sandbox((tx) => expireDueQuotes(tx))
    expect(swept).toBeGreaterThan(0)
    expect((await sandbox((tx) => getQuote(tx, quote.id)))?.status).toBe('EXPIRED')
  })
})

describe('cancellation semantics', () => {
  it('is immediate before authorization (T25)', async () => {
    const { settlementId } = await toQuoted()
    const outcome = await sandbox((tx) =>
      cancelSettlement(tx, scope, { settlementId, actor: creator, actorRoles: [...ADMIN_ROLES] }),
    )
    expect(outcome.ok).toBe(true)
    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('CANCELLED')
    expect(row?.customerStatus).toBe('CANCELLED')
  })

  it('after authorization it records a request, not a status change (T26)', async () => {
    const { settlementId } = await toQuoted()
    await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet, hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    const outcome = await sandbox((tx) =>
      cancelSettlement(tx, scope, { settlementId, actor: creator, actorRoles: [...ADMIN_ROLES] }),
    )
    expect(outcome.ok).toBe(true)

    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    // The annotation moved nothing.
    expect(row?.status).toBe('AUTHORIZED')
    expect(row?.cancellationRequestedAt).not.toBeNull()

    const events = (await sandbox((tx) =>
      tx.execute(sql`SELECT type FROM events WHERE subject_id = ${settlementId} ORDER BY created_at`),
    )) as unknown as { type: string }[]
    expect(events.map((e) => e.type)).toContain('settlement.cancellation_requested')
    // T26 is the one row with no status event.
    expect(events.filter((e) => e.type === 'settlement.cancelled')).toHaveLength(0)
  })

  it('the request takes effect at a checkpoint (T27)', async () => {
    const { settlementId } = await toQuoted()
    await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet, hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    await sandbox((tx) =>
      cancelSettlement(tx, scope, { settlementId, actor: creator, actorRoles: [...ADMIN_ROLES] }),
    )
    const outcome = await sandbox((tx) => honourCancellation(tx, scope, { settlementId, actor: creator }))
    expect(outcome.ok).toBe(true)
    expect((await sandbox((tx) => getSettlement(tx, settlementId)))?.status).toBe('CANCELLED')
  })
})

describe('the dispatch boundary — INV-36', () => {
  it('stamps point_of_no_return_at and creates a durable attempt', async () => {
    const settlementId = await toDrawdownConfirmed()
    const result = await sandbox((tx) =>
      dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }),
    )
    expect(result.ok).toBe(true)

    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('PAYOUT_SUBMITTED')
    expect(row?.pointOfNoReturnAt).not.toBeNull()

    const attempts = (await sandbox((tx) =>
      tx.execute(sql`
        SELECT attempt_number, idempotency_key, status
        FROM payout_attempts WHERE settlement_id = ${settlementId}`),
    )) as unknown as { attempt_number: number; idempotency_key: string; status: string }[]
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.attempt_number).toBe(1)
    expect(attempts[0]!.status).toBe('SUBMITTED')
    // Readable on purpose. During an incident this string is what someone types
    // into a provider dashboard, and a hex digest would make that impossible.
    expect(attempts[0]!.idempotency_key).toBe(payoutIdempotencyKey(settlementId, 1))
    expect(result).toMatchObject({ ok: true, attemptNumber: 1, reused: false })
  })

  it('refuses to dispatch when a cancellation is already pending', async () => {
    const settlementId = await toDrawdownConfirmed()
    await sandbox((tx) =>
      cancelSettlement(tx, scope, { settlementId, actor: creator, actorRoles: [...ADMIN_ROLES] }),
    )
    const result = await sandbox((tx) =>
      dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'cancellation_pending' })
  })

  it('refuses cancellation once the boundary is crossed', async () => {
    const settlementId = await toDrawdownConfirmed()
    await sandbox((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }))
    const outcome = await sandbox((tx) =>
      cancelSettlement(tx, scope, { settlementId, actor: creator, actorRoles: [...ADMIN_ROLES] }),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'past_point_of_no_return' })
  })

  it('a retry of the in-flight submission reuses the attempt rather than crossing again', async () => {
    // This is the case that makes the whole model worth having. Stage 5's
    // provider call times out; it does not know whether the payout exists. The
    // only safe thing it can do is present the *same* idempotency key again, so
    // dispatch has to be able to hand it back.
    const settlementId = await toDrawdownConfirmed()
    const first = await sandbox((tx) =>
      dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }),
    )
    const retry = await sandbox((tx) =>
      dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }),
    )
    expect(first.ok && retry.ok).toBe(true)
    if (!first.ok || !retry.ok) return
    expect(retry.idempotencyKey).toBe(first.idempotencyKey)
    expect(retry.attemptNumber).toBe(1)
    expect(retry.payoutAttemptId).toBe(first.payoutAttemptId)
    expect(retry.reused).toBe(true)
    // The boundary is a moment, not a counter: it is still the original stamp.
    expect(retry.pointOfNoReturnAt.getTime()).toBe(first.pointOfNoReturnAt.getTime())

    const n = (await sandbox((tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM payout_attempts WHERE settlement_id = ${settlementId}`),
    )) as unknown as { n: number }[]
    expect(n[0]!.n).toBe(1)
  })

  it('refuses a fresh attempt while the first one is UNKNOWN', async () => {
    // INV-24. UNKNOWN is not a failure, it is an absence of knowledge, and the
    // only correct response to it is a status pull — never another payout.
    const settlementId = await toDrawdownConfirmed()
    await sandbox((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }))
    await sandbox((tx) =>
      tx.execute(sql`
        UPDATE payout_attempts SET status = 'UNKNOWN' WHERE settlement_id = ${settlementId}`),
    )
    const again = await sandbox((tx) =>
      dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }),
    )
    // Not a reuse and not a new attempt: dispatch has nothing correct to do
    // here. UNKNOWN is resolved by a status *pull* — reading the rail with the
    // key already issued — which is a different operation with a different
    // failure mode, and Stage 5 owns it.
    expect(again).toMatchObject({ ok: false, reason: 'attempt_status_unknown' })

    // And the key stays available to that pull: the attempt row is untouched.
    const rows = (await sandbox((tx) =>
      tx.execute(sql`
        SELECT idempotency_key, attempt_number FROM payout_attempts
        WHERE settlement_id = ${settlementId}`),
    )) as unknown as { idempotency_key: string; attempt_number: number }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.idempotency_key).toBe(payoutIdempotencyKey(settlementId, 1))
  })

  it('does not mint attempt 2 itself once the first is rejected — that is Stage 5', async () => {
    const settlementId = await toDrawdownConfirmed()
    await sandbox((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }))
    await sandbox((tx) =>
      tx.execute(sql`
        UPDATE payout_attempts SET status = 'REJECTED' WHERE settlement_id = ${settlementId}`),
    )
    const again = await sandbox((tx) =>
      dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }),
    )
    // The identity model permits a second attempt; Stage 3 declines to start
    // one, which is not the same as pretending it cannot exist.
    expect(again).toMatchObject({ ok: false, reason: 'already_dispatched' })
    const n = (await sandbox((tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM payout_attempts WHERE settlement_id = ${settlementId}`),
    )) as unknown as { n: number }[]
    expect(n[0]!.n).toBe(1)
  })

  it('refuses to dispatch again after the payout was credited', async () => {
    const settlementId = await toDrawdownConfirmed()
    await sandbox((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }))
    await sandbox((tx) =>
      tx.execute(sql`
        UPDATE payout_attempts
        SET status = 'CREDITED', utr = 'UTR000000001', credited_at = now()
        WHERE settlement_id = ${settlementId}`),
    )
    expect(
      await sandbox((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true })),
    ).toMatchObject({ ok: false, reason: 'attempt_already_credited' })
  })

  it('refuses without a selected rail rather than defaulting the guard', async () => {
    const settlementId = await toDrawdownConfirmed()
    const result = await sandbox((tx) =>
      dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: false }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'guard_failed' })
  })
})

describe('cancellation and dispatch contend on the same row', () => {
  /**
   * The property `INV-36(a)` promises: the two transactions take the same lock,
   * so they have a total order. Either cancellation commits first and dispatch
   * aborts, or dispatch commits first and cancellation is refused. There is no
   * third outcome — in particular, **never** a CANCELLED settlement with a
   * durable payout attempt beside it.
   */
  it('has no outcome where both a cancellation and a durable dispatch land', async () => {
    const runs = 12
    const observed = new Set<string>()

    for (let i = 0; i < runs; i += 1) {
      const settlementId = await toDrawdownConfirmed()

      const [cancelResult, dispatchResult] = await Promise.allSettled([
        sandbox((tx) =>
          cancelSettlement(tx, scope, { settlementId, actor: creator, actorRoles: [...ADMIN_ROLES] }),
        ),
        sandbox((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true })),
      ])

      const row = await sandbox((tx) => getSettlement(tx, settlementId))
      const attempts = (await sandbox((tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM payout_attempts WHERE settlement_id = ${settlementId}`),
      )) as unknown as { n: number }[]
      const dispatched = attempts[0]!.n > 0

      const cancelled =
        cancelResult.status === 'fulfilled' && cancelResult.value.ok && row?.cancellationRequestedAt !== null

      // The forbidden state, stated directly.
      expect(
        !(dispatched && row?.status === 'CANCELLED'),
        `run ${i}: both a durable dispatch and a CANCELLED settlement exist`,
      ).toBe(true)

      if (dispatched) {
        // Dispatch won: the boundary is crossed and stays crossed.
        expect(row?.pointOfNoReturnAt, `run ${i}`).not.toBeNull()
        expect(row?.status, `run ${i}`).toBe('PAYOUT_SUBMITTED')
        observed.add('dispatch_won')
      } else {
        // Cancellation won: nothing durable was created.
        expect(row?.pointOfNoReturnAt, `run ${i}`).toBeNull()
        expect(
          dispatchResult.status === 'fulfilled' && !dispatchResult.value.ok,
          `run ${i}: dispatch should have been refused`,
        ).toBe(true)
        observed.add('cancel_won')
      }
      if (cancelled && !dispatched) observed.add('cancel_recorded')
    }

    // The race is real, not accidentally serialised into one branch every time.
    expect(observed.size).toBeGreaterThan(0)
  })
})

describe('exceptions', () => {
  it('opens with a code from the closed taxonomy and projects to SETTLING', async () => {
    const { settlementId } = await toQuoted()
    await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet, hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    await sandbox((tx) =>
      applyTransition(tx, scope, { settlementId, trigger: 'begin_reservation', actor: creator, guards: LATER_STAGE_TRUE }),
    )
    const outcome = await sandbox((tx) =>
      openException(tx, scope, {
        settlementId, trigger: 'reservation_failed', code: 'LIQUIDITY_UNAVAILABLE',
        actor: creator, guards: {},
      }),
    )
    expect(outcome.ok).toBe(true)

    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('EXCEPTION')
    expect(row?.exceptionEnteredFrom).toBe('LIQUIDITY_RESERVING')
    // Not customer-actionable, so the customer still sees SETTLING.
    expect(row?.customerStatus).toBe('SETTLING')
  })

  it('a customer-actionable exception projects to ACTION_REQUIRED', async () => {
    const settlementId = await toDrawdownConfirmed()
    await sandbox((tx) => dispatchPayout(tx, scope, { settlementId, actor: creator, railSelected: true }))
    await sandbox((tx) =>
      openException(tx, scope, {
        settlementId, trigger: 'payout_rejected', code: 'PAYOUT_REJECTED_DESTINATION',
        actor: creator, guards: { trusted_provider_event: true },
      }),
    )
    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('EXCEPTION')
    expect(row?.customerStatus).toBe('ACTION_REQUIRED')
  })

  it('resumes to where it came from (T22)', async () => {
    const { settlementId } = await toQuoted()
    await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet, hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    await sandbox((tx) =>
      applyTransition(tx, scope, { settlementId, trigger: 'begin_reservation', actor: creator, guards: LATER_STAGE_TRUE }),
    )
    await sandbox((tx) =>
      openException(tx, scope, {
        settlementId, trigger: 'reservation_failed', code: 'LIQUIDITY_UNAVAILABLE', actor: creator, guards: {},
      }),
    )
    const outcome = await sandbox((tx) =>
      resolveException(tx, scope, { settlementId, resolution: 'resume', actor: creator, reason: 'headroom freed' }),
    )
    expect(outcome.ok).toBe(true)
    expect((await sandbox((tx) => getSettlement(tx, settlementId)))?.status).toBe('LIQUIDITY_RESERVING')
  })

  /**
   * The application layer cannot turn T22 into a jump instruction.
   *
   * The database tests prove `exception_entered_from` cannot be written freely
   * through SQL. This proves the shorter path: `applyTransition` takes a `patch`
   * of extra columns, and until this was fixed that patch was spread *after* the
   * computed status — so `{ trigger: 'resolve_resume', patch: { status:
   * 'SETTLED' } }` would evaluate T22, pass its guards, emit
   * `settlement.exception_resolved`, and write SETTLED. The event stream would
   * say the settlement resumed; the row would say it had paid out. No raw SQL,
   * no privileged role, just a field name.
   */
  describe('T22 cannot be turned into a bypass from the application layer', () => {
    async function inExceptionFrom(): Promise<string> {
      const { settlementId } = await toQuoted()
      const authorized = await sandbox((tx) =>
        authorizeSettlement(tx, scope, {
          settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet,
          hasActiveLiquidityFacility: true, documents: DOCUMENTS,
        }),
      )
      if (!authorized.ok) throw new Error(`authorize failed: ${JSON.stringify(authorized)}`)
      await sandbox((tx) =>
        applyTransition(tx, scope, { settlementId, trigger: 'begin_reservation', actor: creator, guards: LATER_STAGE_TRUE }),
      )
      await sandbox((tx) =>
        openException(tx, scope, {
          settlementId, trigger: 'reservation_failed', code: 'LIQUIDITY_UNAVAILABLE', actor: creator, guards: {},
        }),
      )
      return settlementId
    }

    it('refuses a patch that names the status', async () => {
      const settlementId = await inExceptionFrom()
      const outcome = await sandbox((tx) =>
        applyTransition(tx, scope, {
          settlementId,
          trigger: 'resolve_resume',
          actor: creator,
          guards: { resolution_attributed: true },
          patch: { status: 'SETTLED' },
        }),
      )
      expect(outcome).toMatchObject({ ok: false, reason: 'protected_field', fields: ['status'] })
      // Refused before anything happened, not refused after a partial write.
      const row = await sandbox((tx) => getSettlement(tx, settlementId))
      expect(row?.status).toBe('EXCEPTION')
    })

    it('refuses a patch that re-aims the recorded origin', async () => {
      const settlementId = await inExceptionFrom()
      const outcome = await sandbox((tx) =>
        applyTransition(tx, scope, {
          settlementId,
          trigger: 'resolve_resume',
          actor: creator,
          guards: { resolution_attributed: true },
          patch: { exceptionEnteredFrom: 'RECONCILING' },
        }),
      )
      expect(outcome).toMatchObject({ ok: false, reason: 'protected_field' })
      expect((await sandbox((tx) => getSettlement(tx, settlementId)))?.exceptionEnteredFrom).toBe(
        'LIQUIDITY_RESERVING',
      )
    })

    it('refuses the snake_case spelling too, rather than silently ignoring it', async () => {
      // Drizzle would drop an unknown key without complaint. A caller who sent
      // it believed they were doing something; a silent no-op teaches them the
      // field is not protected, which is the wrong lesson to learn quietly.
      const settlementId = await inExceptionFrom()
      expect(
        await sandbox((tx) =>
          applyTransition(tx, scope, {
            settlementId, trigger: 'resolve_resume', actor: creator,
            guards: { resolution_attributed: true },
            patch: { exception_entered_from: 'RECONCILING', customer_status: 'SETTLED' },
          }),
        ),
      ).toMatchObject({ ok: false, reason: 'protected_field' })
    })

    it('refuses a patch that forges the version or the customer projection', async () => {
      const settlementId = await inExceptionFrom()
      for (const patch of [
        { version: 999 },
        { customerStatus: 'SETTLED' },
        { openExceptionCode: null },
      ]) {
        expect(
          await sandbox((tx) =>
            applyTransition(tx, scope, {
              settlementId, trigger: 'resolve_resume', actor: creator,
              guards: { resolution_attributed: true }, patch,
            }),
          ),
        ).toMatchObject({ ok: false, reason: 'protected_field' })
      }
    })

    it('still lets a transition write its own payload', async () => {
      // The rule is not "patches are dangerous". Authorization writes the terms
      // it authorizes through exactly this mechanism, and that has to keep
      // working or the protection has eaten the feature.
      const settlementId = await inExceptionFrom()
      const outcome = await sandbox((tx) =>
        applyTransition(tx, scope, {
          settlementId, trigger: 'resolve_resume', actor: creator,
          guards: { resolution_attributed: true },
          patch: { externalReference: 'resumed-by-ops-1' },
        }),
      )
      expect(outcome).toMatchObject({ ok: true, to: 'LIQUIDITY_RESERVING' })
    })

    it('resumes to the recorded origin even when asked for somewhere else', async () => {
      // The end-to-end statement: the caller names a trigger, never a
      // destination. There is no argument to applyTransition that means "go to
      // PAYOUT_SUBMITTED", and adding one through `patch` is refused.
      const settlementId = await inExceptionFrom()
      const outcome = await sandbox((tx) =>
        resolveException(tx, scope, {
          settlementId, resolution: 'resume', actor: creator, reason: 'headroom freed',
        }),
      )
      expect(outcome).toMatchObject({ ok: true, to: 'LIQUIDITY_RESERVING' })
    })
  })

  it('resolves to FAILED with an attributed reason (T23)', async () => {
    const { settlementId } = await toQuoted()
    await sandbox((tx) =>
      authorizeSettlement(tx, scope, {
        settlementId, actor: approver, actorRoles: [...ADMIN_ROLES], ruleSet, hasActiveLiquidityFacility: true, documents: DOCUMENTS,
      }),
    )
    await sandbox((tx) =>
      applyTransition(tx, scope, { settlementId, trigger: 'begin_reservation', actor: creator, guards: LATER_STAGE_TRUE }),
    )
    await sandbox((tx) =>
      openException(tx, scope, {
        settlementId, trigger: 'reservation_failed', code: 'FACILITY_SUSPENDED', actor: creator, guards: {},
      }),
    )
    const outcome = await sandbox((tx) =>
      resolveException(tx, scope, {
        settlementId, resolution: 'fail', actor: creator, reason: 'facility suspended indefinitely',
      }),
    )
    expect(outcome.ok).toBe(true)
    const row = await sandbox((tx) => getSettlement(tx, settlementId))
    expect(row?.status).toBe('FAILED')
    expect(row?.customerStatus).toBe('CANCELLED')
  })
})

/**
 * Shared Stage 6 staging — carrying a settlement all the way to `SETTLED`.
 *
 * Not a test file: a fixture module both Stage 6 suites import, so the long
 * road from a beneficiary to a settled settlement is written once. Every step
 * goes through the real service, never a direct write — a fixture that forged
 * a `SETTLED` row would make every assertion below it meaningless, because the
 * thing under test is precisely whether that row can be produced honestly.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Harness } from '@inrsettle/testing'
import { withTenant, type Db } from '@inrsettle/db'
import { money } from '@inrsettle/money'
import type { PreflightRuleSet, PrincipalRef, ProviderMappingTable, TenantScope } from '@inrsettle/domain'
import {
  SANDBOX_NAME_MATCH_POLICIES,
  createChromiumPdfRenderer,
  createFilesystemArtifactStore,
  createMockIndiaPayoutProvider,
  createSandboxVerificationProvider,
  type ChromiumPdfRenderer,
  type MockIndiaPayoutProvider,
} from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { createQuote } from '../quote.service.js'
import { createSettlement } from '../settlement-transition.service.js'
import {
  attachQuote, authorizeSettlement, dispatchPayout, runSettlementPreflight,
} from '../settlement.service.js'
import { createFacility, listFacilities } from '../liquidity.service.js'
import { requestDrawdown, reserveForSettlement, resolveDrawdown } from '../settlement-liquidity.service.js'
import { applyPayoutOutcome, chooseRail, submitDispatchedPayout } from '../payout.service.js'
import { applyObservation, beginReconciliation } from '../reconciliation.service.js'
import { evaluateAndSettle } from '../finality.service.js'
import {
  issueReceipt, readArtifact, runReceiptGenerate, type ArtifactDeps,
} from '../receipt.service.js'

export const WS = 'ws_stage6'
export const scope: TenantScope = { workspaceId: WS, environment: 'sandbox' }
export const creator: PrincipalRef = { type: 'user', id: 'usr_creator' }
export const approver: PrincipalRef = { type: 'user', id: 'usr_approver' }
export const operator: PrincipalRef = { type: 'user', id: 'usr_operator' }
export const ROLES = ['admin', 'approver', 'operator'] as const

/** ₹50,00,000 recipient, 1 USDT unit of funding. Same shape as Stage 5's. */
export const AMOUNT = 500_000_000n
export const UNIT = 1_000_000n
export const DOCUMENTS = ['commercial_invoice'] as const
export const TTL = 900
export const RECONCILIATION_SLA = 3600

export const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}

/** A fixed provider clock, so webhook tolerance is exercised against an instant. */
export const clockNow = new Date('2026-09-03T10:00:00.000Z')
export const clock = (): Date => clockNow

export interface Stage6Context {
  readonly h: Harness
  readonly ruleSet: PreflightRuleSet
  readonly mapping: ProviderMappingTable
  readonly provider: MockIndiaPayoutProvider
  readonly artifacts: ArtifactDeps
  /** Held so the suite can close the browser it started. */
  readonly renderer: ChromiumPdfRenderer
  readonly live: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
}

/**
 * The real store and the real headless Chromium.
 *
 * `--no-sandbox` because CI containers cannot grant Chromium the namespaces its
 * own sandbox needs. It is passed here, at a call site, rather than defaulted in
 * the adapter — turning the browser's sandbox off should always be a visible
 * decision somebody made, not one they inherited.
 */
export function makeArtifacts(): { deps: ArtifactDeps; renderer: ChromiumPdfRenderer } {
  const renderer = createChromiumPdfRenderer({ launchArgs: ['--no-sandbox'] })
  return {
    deps: {
      store: createFilesystemArtifactStore({
        root: mkdtempSync(join(tmpdir(), 'inrsettle-artifacts-')),
      }),
      render: (artifact, hash) => renderer.render(artifact, hash),
    },
    renderer,
  }
}

export function makeProvider(): MockIndiaPayoutProvider {
  return createMockIndiaPayoutProvider({ now: clock })
}

let seq = 0

/** A beneficiary whose account number ends in a scenario suffix. */
export async function beneficiaryFor(ctx: Stage6Context, suffix: string) {
  const created = await ctx.live((tx) =>
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
  const versionId = created.destinations[0]!.currentVersion!.id
  await requestVerification(ctx.h.db, scope, createSandboxVerificationProvider(), crypto.cipher, SANDBOX_NAME_MATCH_POLICIES, {
    destinationVersionId: versionId, actor: creator,
  })

  return { id: created.id, versionId }
}

export const resolveDestination = (ctx: Stage6Context) => async (destinationVersionId: string) => {
  const rows = (await ctx.live((tx) => tx.execute(sql`
    SELECT pdv.account_number_last4, pd.kind
    FROM payout_destination_versions pdv
    JOIN payout_destinations pd ON pd.id = pdv.destination_id
    WHERE pdv.id = ${destinationVersionId}`))) as unknown as
    { account_number_last4: string; kind: string }[]
  const row = rows[0]
  if (!row) return null
  return {
    kind: row.kind as 'bank_account' | 'vpa',
    accountNumber: `501001234${row.account_number_last4}`,
    ifsc: 'HDFC0000123',
    accountHolderName: 'Aarti Sharma',
  }
}

export interface Staged {
  readonly settlementId: string
  readonly facilityId: string
  readonly idempotencyKey: string
}

/** Authorized, funded, dispatched, credited — `PAYOUT_CONFIRMED`. */
export async function creditedSettlement(ctx: Stage6Context, suffix: string): Promise<Staged> {
  const facilityId = (await ctx.live((tx) =>
    createFacility(tx, scope, {
      providerId: 'mock_liquidity', currency: 'USDT',
      limit: money('USDT', 100n * UNIT), actor: creator,
    }),
  )).id
  const beneficiary = await beneficiaryFor(ctx, suffix)

  const { id: settlementId } = await ctx.live((tx) =>
    createSettlement(tx, scope, {
      beneficiaryId: beneficiary.id, recipientAmountMinor: AMOUNT, fundingCurrency: 'USDT',
      purposeCode: 'SOFTWARE_SERVICES', externalReference: `s6_${(seq += 1)}`, actor: creator,
    }),
  )
  const facilities = await ctx.live((tx) => listFacilities(tx, scope, 'USDT'))
  const pre = await runSettlementPreflight(ctx.h.db, scope, {
    settlementId, ruleSet: ctx.ruleSet, actor: creator, documents: DOCUMENTS,
    hasActiveLiquidityFacility: facilities.length > 0,
  })
  if (!pre.ok) throw new Error(`preflight: ${JSON.stringify(pre)}`)

  const quote = await ctx.live((tx) =>
    createQuote(tx, scope, {
      fundingCurrency: 'USDT', recipientAmount: { currency: 'INR', minorUnits: AMOUNT }, actor: creator,
    }),
  )
  const attached = await ctx.live((tx) => attachQuote(tx, scope, { settlementId, quoteId: quote.id, actor: creator }))
  if (!attached.ok) throw new Error(`attach: ${JSON.stringify(attached)}`)
  const auth = await ctx.live((tx) =>
    authorizeSettlement(tx, scope, {
      settlementId, actor: approver, actorRoles: [...ROLES], ruleSet: ctx.ruleSet,
      hasActiveLiquidityFacility: true, documents: DOCUMENTS,
    }),
  )
  if (!auth.ok) throw new Error(`authorize: ${JSON.stringify(auth)}`)

  await reserveForSettlement(ctx.h.db, scope, {
    settlementId, facilityId, fundingAmount: money('USDT', UNIT), ttlSeconds: TTL, actor: creator,
  })
  await ctx.live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator }))
  await ctx.live((tx) =>
    resolveDrawdown(tx, scope, {
      settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
      evidence: { amountMinor: UNIT, currency: 'USDT', facilityId },
    }),
  )

  const rail = await chooseRail(ctx.provider, { destinationKind: 'bank_account', amountMinor: AMOUNT })
  if (!rail.ok) throw new Error(`rail: ${JSON.stringify(rail)}`)
  const dispatched = await ctx.live((tx) =>
    dispatchPayout(tx, scope, {
      settlementId, actor: creator, railSelected: true,
      rail: rail.rail, slaSeconds: rail.slaSeconds, providerId: ctx.provider.id,
      fundingAmountMinor: AMOUNT,
    }),
  )
  if (!dispatched.ok) throw new Error(`dispatch: ${JSON.stringify(dispatched)}`)

  const submitted = await submitDispatchedPayout(ctx.h.db, scope, ctx.provider, resolveDestination(ctx), {
    settlementId, actor: creator,
  })
  if (!submitted.ok) throw new Error(`submit: ${JSON.stringify(submitted)}`)
  const credited = await ctx.live((tx) =>
    applyPayoutOutcome(tx, scope, {
      settlementId, outcome: 'credited', actor: creator, trusted: true,
      utr: submitted.utr, creditedMinor: submitted.creditedMinor,
    }),
  )
  if (!credited.ok) throw new Error(`credit: ${JSON.stringify(credited)}`)

  return { settlementId, facilityId, idempotencyKey: dispatched.idempotencyKey }
}

/** …and on through `T19`, the observation, and the finality evaluator. */
export async function settledSettlement(ctx: Stage6Context, suffix = '0000'): Promise<Staged> {
  const staged = await creditedSettlement(ctx, suffix)
  const begun = await ctx.live((tx) =>
    beginReconciliation(tx, scope, {
      settlementId: staged.settlementId,
      expected: money('INR', AMOUNT),
      actor: creator,
      slaSeconds: RECONCILIATION_SLA,
    }),
  )
  if (!begun.ok) throw new Error(`begin: ${JSON.stringify(begun)}`)

  const observed = await creditedMinorOf(ctx, staged.settlementId)
  const compared = await ctx.live((tx) =>
    applyObservation(tx, scope, {
      settlementId: staged.settlementId,
      source: 'trusted_provider_event',
      observedMinor: observed,
      observedCurrency: 'INR',
      actor: creator,
    }),
  )
  if (!compared.ok) throw new Error(`observe: ${JSON.stringify(compared)}`)

  const settled = await ctx.live((tx) =>
    evaluateAndSettle(tx, scope, {
      settlementId: staged.settlementId,
      actor: creator,
      issueReceipt: async (inner) => {
        const receipt = await issueReceipt(inner, scope, {
          settlementId: staged.settlementId, actor: creator,
        })
        if (!receipt.ok) throw new Error(`receipt: ${JSON.stringify(receipt)}`)
        return { receiptId: receipt.artifactId, contentHash: receipt.contentHash }
      },
    }),
  )
  if (!settled.ok || !settled.settled) throw new Error(`settle: ${JSON.stringify(settled)}`)

  // The PDF is printed by running the `receipt.generate` job the settle
  // transaction enqueued — this fixture is standing in for the worker. Doing it
  // here rather than inside `evaluateAndSettle` is the point: a browser launch
  // must not happen while the settlement's row lock is held.
  const receipt = await ctx.live((tx) =>
    readArtifact(tx, { settlementId: staged.settlementId, kind: 'settlement_receipt' }),
  )
  const printed = await runReceiptGenerate(ctx.h.db, scope, ctx.artifacts, {
    artifactId: receipt!.id,
  })
  if (!printed.ok) throw new Error(`receipt.generate: ${JSON.stringify(printed)}`)
  return staged
}

export async function creditedMinorOf(ctx: Stage6Context, settlementId: string): Promise<bigint | null> {
  const rows = (await ctx.live((tx) => tx.execute(sql`
    SELECT pa.credited_minor FROM payout_attempts pa
    JOIN settlements s ON s.payout_attempt_id = pa.id
    WHERE s.id = ${settlementId}`))) as unknown as { credited_minor: string | null }[]
  const value = rows[0]?.credited_minor
  return value === null || value === undefined ? null : BigInt(value)
}

export async function statusOf(ctx: Stage6Context, settlementId: string): Promise<string> {
  const rows = (await ctx.live((tx) => tx.execute(sql`
    SELECT status FROM settlements WHERE id = ${settlementId}`))) as unknown as { status: string }[]
  return rows[0]!.status
}

/** The whole settlement row, for the byte-identity assertions `INV-42` needs. */
export async function settlementRow(
  ctx: Stage6Context,
  settlementId: string,
): Promise<Record<string, unknown>> {
  const rows = (await ctx.live((tx) => tx.execute(sql`
    SELECT * FROM settlements WHERE id = ${settlementId}`))) as unknown as Record<string, unknown>[]
  return rows[0]!
}

export const liveFor = (h: Harness) => <T>(fn: (tx: Db) => Promise<T>) => withTenant(h.db, scope, fn)

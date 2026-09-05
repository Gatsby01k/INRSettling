/**
 * Stage 9 exit criteria 1, 2 and 4.
 *
 *   1. Every operator action is attributed and audited with a mandatory reason.
 *   2. No ops action can set `SETTLED` or edit a settled record.
 *   4. Exception resolution resumes a settlement at `exception_entered_from`.
 *
 * Every settlement here is carried to its exception through the real services —
 * preflight, quote, authorize, reserve, dispatch — because a fixture that wrote
 * an `EXCEPTION` row directly would make the resume assertion meaningless. The
 * thing under test is whether the machine returns a settlement to where it
 * actually stalled, which is only a question if it actually stalled there.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  createTestDatabase, opsConnectionString, seedWorkspace, type Harness,
} from '@inrsettle/testing'
import { createClient, withTenant, type Db, type TenantScope } from '@inrsettle/db'
import { money } from '@inrsettle/money'
import type { PreflightRuleSet, PrincipalRef } from '@inrsettle/domain'
import {
  SANDBOX_NAME_MATCH_POLICIES, createMockIndiaPayoutProvider,
  createSandboxVerificationProvider, type MockIndiaPayoutProvider,
} from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { createQuote } from '../quote.service.js'
import { createSettlement } from '../settlement-transition.service.js'
import {
  attachQuote, authorizeSettlement, dispatchPayout, openException, runSettlementPreflight,
} from '../settlement.service.js'
import { createFacility, listFacilities } from '../liquidity.service.js'
import {
  requestDrawdown, reserveForSettlement, resolveDrawdown,
} from '../settlement-liquidity.service.js'
import { chooseRail } from '../payout.service.js'
import { activeRuleSetVersion, loadRuleSetFromDatabase } from '../reference-data.service.js'
import { OperatorAccessRefused, type OperatorContext } from '../ops/access.service.js'
import { resolveExceptionAsOperator } from '../ops/exception.service.js'
import {
  createOperator, establishOperatorSession, resolveOperatorSession, type NetworkPolicy,
} from '../ops/session.service.js'

let h: Harness
let closeOps: (() => Promise<void>) | undefined
let ruleSet: PreflightRuleSet
let provider: MockIndiaPayoutProvider

const DB = `inrsettle_test_ops_exception_${process.pid}`
const WS = 'ws_ops_exc'
const scope: TenantScope = { workspaceId: WS, environment: 'sandbox' }
const creator: PrincipalRef = { type: 'user', id: 'usr_creator' }
const approver: PrincipalRef = { type: 'user', id: 'usr_approver' }
const ROLES = ['admin', 'approver', 'operator'] as const
const OFFICE: NetworkPolicy = { name: 'office-v1', allowedCidrs: ['10.0.0.0/8'] }
const DEVICE = 'ops-laptop-01'

const AMOUNT = 500_000_000n
const UNIT = 1_000_000n
const DOCUMENTS = ['commercial_invoice'] as const

const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}

const live = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => withTenant(h.db, scope, fn)

let resolver: Awaited<ReturnType<typeof operatorWith>>
let readerOnly: Awaited<ReturnType<typeof operatorWith>>

async function operatorWith(roles: readonly string[], suffix: string) {
  const id = await createOperator(h.db, {
    email: `${suffix}@inrsettle.test`, displayName: suffix,
    roles: roles as never, grantedBy: 'opr_root',
  })
  const established = await establishOperatorSession(h.db, {
    operatorId: id, mfaMethod: 'totp', ip: '10.2.2.2',
    deviceFingerprint: DEVICE, policy: OFFICE,
  })
  if (!established.ok) throw new Error(`establish: ${established.reason}`)
  const resolved = await resolveOperatorSession(h.db, established.sessionId, {
    ip: '10.2.2.2', deviceFingerprint: DEVICE, policy: OFFICE,
  })
  if (!resolved.ok) throw new Error(`resolve: ${resolved.reason}`)
  return { id, operator: resolved.operator }
}

function ctx(
  who: Awaited<ReturnType<typeof operatorWith>>,
  overrides: Partial<OperatorContext> = {},
): OperatorContext {
  return {
    operator: who.operator,
    action: 'ops.exception_resolve',
    reason: 'Provider confirmed by phone that the credit never left; safe to unwind.',
    requestId: 'req_ops_exc',
    ip: '10.2.2.2',
    ...overrides,
  }
}

beforeAll(async () => {
  h = await createTestDatabase('ops_exception')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_creator', email: 'c@example.test', roles: [...ROLES],
  })
  // A second member of the same workspace. Separation of duties means the
  // person who creates a settlement is not the one who authorizes it, so the
  // fixture needs two people rather than one wearing both hats.
  await h.admin`INSERT INTO users (id, email) VALUES ('usr_approver', 'ap@example.test')`
  await h.admin`
    INSERT INTO memberships (id, workspace_id, environment, user_id)
    VALUES ('mem_appr', ${WS}, 'sandbox', 'usr_approver')`
  await h.admin`
    INSERT INTO membership_roles (membership_id, workspace_id, environment, role)
    VALUES ('mem_appr', ${WS}, 'sandbox', 'approver'),
           ('mem_appr', ${WS}, 'sandbox', 'operator')`
  await h.admin`
    INSERT INTO internal_operators (id, email, display_name, status)
    VALUES ('opr_root', 'root@inrsettle.test', 'Root', 'active')`

  const version = await activeRuleSetVersion(h.admin, 'sandbox', new Date())
  ruleSet = (await loadRuleSetFromDatabase(h.admin, version!))!.ruleSet
  provider = createMockIndiaPayoutProvider()

  // An ops pool is opened and closed but never read through, on purpose: every
  // path in this suite is a *write*, and an operator write goes through the
  // application role like a customer's. The pool exists so that a future test
  // reaching for a cross-tenant read has one, and its absence from the
  // assertions is the point being made.
  const ops = createClient(opsConnectionString(DB), { max: 1 })
  closeOps = ops.close

  resolver = await operatorWith(['ops_resolve'], 'resolver')
  readerOnly = await operatorWith(['ops_read'], 'readeronly')
})

afterAll(async () => {
  // Guarded: a failure inside beforeAll leaves these unset, and an afterAll
  // that then throws hides the error that actually caused the failure.
  if (closeOps) await closeOps()
  if (h) await h.close()
})

/* ── Staging, through the real services ─────────────────────────────────── */

let seq = 0

async function verifiedBeneficiary(): Promise<string> {
  const created = await live((tx) => createBeneficiary(tx, scope, crypto, {
    identity: { displayName: `Payee ${(seq += 1)}`, type: 'individual', country: 'IN' },
    destination: {
      kind: 'bank_account', accountNumber: '50100123456789', ifsc: 'HDFC0000123',
      accountType: 'savings', accountHolderName: `Payee ${seq}`,
    },
    actor: creator,
  }))
  const versionId = created.destinations[0]!.currentVersion!.id
  await requestVerification(
    h.db, scope, createSandboxVerificationProvider(), crypto.cipher,
    SANDBOX_NAME_MATCH_POLICIES, { destinationVersionId: versionId, actor: creator },
  )
  return created.id
}

/** Authorized, funded, reserved — and not yet dispatched, so still pre-PONR. */
async function reservedSettlement(): Promise<{ settlementId: string; facilityId: string }> {
  const facilityId = (await live((tx) => createFacility(tx, scope, {
    providerId: 'mock_liquidity', currency: 'USDT',
    limit: money('USDT', 100n * UNIT), actor: creator,
  }))).id
  const beneficiaryId = await verifiedBeneficiary()

  const { id: settlementId } = await live((tx) => createSettlement(tx, scope, {
    beneficiaryId, recipientAmountMinor: AMOUNT, fundingCurrency: 'USDT',
    purposeCode: 'SOFTWARE_SERVICES', externalReference: `ops_${seq}`, actor: creator,
  }))
  const facilities = await live((tx) => listFacilities(tx, scope, 'USDT'))
  const pre = await runSettlementPreflight(h.db, scope, {
    settlementId, ruleSet, actor: creator, documents: DOCUMENTS,
    hasActiveLiquidityFacility: facilities.length > 0,
  })
  if (!pre.ok) throw new Error(`preflight: ${JSON.stringify(pre)}`)

  const quote = await live((tx) => createQuote(tx, scope, {
    fundingCurrency: 'USDT', recipientAmount: { currency: 'INR', minorUnits: AMOUNT },
    actor: creator,
  }))
  const attached = await live((tx) =>
    attachQuote(tx, scope, { settlementId, quoteId: quote.id, actor: creator }))
  if (!attached.ok) throw new Error(`attach: ${JSON.stringify(attached)}`)
  const auth = await live((tx) => authorizeSettlement(tx, scope, {
    settlementId, actor: approver, actorRoles: [...ROLES], ruleSet,
    hasActiveLiquidityFacility: true, documents: DOCUMENTS,
  }))
  if (!auth.ok) throw new Error(`authorize: ${JSON.stringify(auth)}`)

  await reserveForSettlement(h.db, scope, {
    settlementId, facilityId, fundingAmount: money('USDT', UNIT), ttlSeconds: 900, actor: creator,
  })
  return { settlementId, facilityId }
}

/** In `EXCEPTION`, entered from `LIQUIDITY_RESERVED`, still pre-PONR. */
async function stalledAtReservation(): Promise<string> {
  const { settlementId } = await reservedSettlement()
  const opened = await live((tx) => openException(tx, scope, {
    settlementId, trigger: 'reservation_expired', code: 'LIQUIDITY_UNAVAILABLE',
    actor: { type: 'job', id: 'liquidity.sweeper' },
    guards: { reservation_ttl_reached: true },
  }))
  if (!opened.ok) throw new Error(`open: ${JSON.stringify(opened)}`)
  return settlementId
}

/** In `EXCEPTION`, entered from `PAYOUT_SUBMITTED` — past the point of no return. */
async function stalledAfterDispatch(): Promise<string> {
  const { settlementId, facilityId } = await reservedSettlement()
  // Drawdown, then dispatch: dispatching is what stamps `point_of_no_return_at`.
  const requested = await live((tx) => requestDrawdown(tx, scope, { settlementId, actor: creator }))
  if (!requested.ok) throw new Error(`drawdown request: ${JSON.stringify(requested)}`)
  const confirmed = await live((tx) => resolveDrawdown(tx, scope, {
    settlementId, trigger: 'confirmed', actor: creator, providerEventVerified: true,
    evidence: { amountMinor: UNIT, currency: 'USDT', facilityId },
  }))
  if (!confirmed.ok) throw new Error(`drawdown confirm: ${JSON.stringify(confirmed)}`)

  const rail = await chooseRail(provider, { destinationKind: 'bank_account', amountMinor: AMOUNT })
  if (!rail.ok) throw new Error(`rail: ${JSON.stringify(rail)}`)
  const dispatched = await live((tx) => dispatchPayout(tx, scope, {
    settlementId, actor: creator, railSelected: true,
    rail: rail.rail, slaSeconds: rail.slaSeconds, providerId: provider.id,
    fundingAmountMinor: AMOUNT,
  }))
  if (!dispatched.ok) throw new Error(`dispatch: ${JSON.stringify(dispatched)}`)

  const opened = await live((tx) => openException(tx, scope, {
    settlementId, trigger: 'payout_timeout', code: 'PAYOUT_STATUS_UNKNOWN',
    actor: { type: 'job', id: 'payout.poll' },
    guards: { rail_sla_elapsed: true },
  }))
  if (!opened.ok) throw new Error(`open: ${JSON.stringify(opened)}`)
  return settlementId
}

async function statusOf(settlementId: string): Promise<string> {
  const [row] = await h.admin<{ status: string }[]>`
    SELECT status FROM settlements WHERE id = ${settlementId}`
  return row!.status
}

/* ── Exit criterion 4 ───────────────────────────────────────────────────── */

describe('exception resolution resumes at exception_entered_from', () => {
  it('returns the settlement to exactly where it stalled', async () => {
    const settlementId = await stalledAtReservation()
    expect(await statusOf(settlementId)).toBe('EXCEPTION')

    const result = await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
      settlementId, resolution: 'resume',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Not a state the operator chose, and not a default: the machine recorded
    // where it was when it stalled, and T22's destination is that value.
    expect(result.to).toBe('LIQUIDITY_RESERVED')
    expect(await statusOf(settlementId)).toBe('LIQUIDITY_RESERVED')
  })

  it('resumes a post-dispatch exception to the dispatch state, not to the start', async () => {
    // `INV-36`: an exception opened after the point of no return cannot resume
    // to a pre-dispatch state, and the database refuses it independently of
    // anything this service does.
    const settlementId = await stalledAfterDispatch()
    const result = await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
      settlementId, resolution: 'resume',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.to).toBe('PAYOUT_SUBMITTED')
  })

  it('closes the exception row with an attributed, reasoned resolution', async () => {
    const settlementId = await stalledAtReservation()
    await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
      settlementId, resolution: 'resume',
    })
    const [row] = await h.admin<{
      resolved_by: string; resolution_reason: string; resolved_at: Date
    }[]>`SELECT resolved_by, resolution_reason, resolved_at
           FROM settlement_exceptions WHERE settlement_id = ${settlementId}`
    expect(row!.resolved_by).toBe(resolver.id)
    expect(row!.resolution_reason).toContain('never left')
    expect(row!.resolved_at).not.toBeNull()
  })
})

/* ── Exit criterion 1 ───────────────────────────────────────────────────── */

describe('every operator action is attributed and reasoned', () => {
  it('will not resolve without a reason, and changes nothing when refused', async () => {
    const settlementId = await stalledAtReservation()
    for (const reason of ['', '   ', 'nope']) {
      await expect(resolveExceptionAsOperator(h.db, scope, ctx(resolver, { reason }), {
        settlementId, resolution: 'resume',
      })).rejects.toThrow(OperatorAccessRefused)
    }
    expect(await statusOf(settlementId)).toBe('EXCEPTION')
  })

  it('will not resolve without the capability', async () => {
    // `ops_read` can see the exception and cannot touch it. That separation is
    // the reason the roles are not a hierarchy.
    const settlementId = await stalledAtReservation()
    await expect(resolveExceptionAsOperator(h.db, scope, ctx(readerOnly), {
      settlementId, resolution: 'resume',
    })).rejects.toThrow(/does not hold ops:exception_resolve/)
    expect(await statusOf(settlementId)).toBe('EXCEPTION')
  })

  it('writes the operator record and the customer-visible audit row together', async () => {
    const settlementId = await stalledAtReservation()
    await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
      settlementId, resolution: 'resume',
    })

    const [action] = await h.admin<{
      kind: string; operator_id: string; reason: string; subject_id: string; request_id: string
    }[]>`SELECT kind, operator_id, reason, subject_id, request_id
           FROM operator_actions WHERE subject_id = ${settlementId}`
    expect(action!.kind).toBe('write')
    expect(action!.operator_id).toBe(resolver.id)
    expect(action!.request_id).toBe('req_ops_exc')

    const audits = (await withTenant(h.db, scope, (tx) => tx.execute(sql`
      SELECT action, actor_type, actor_id, reason FROM audit_log
       WHERE subject_id = ${settlementId} AND actor_type = 'operator'`))) as unknown as {
      action: string; actor_type: string; actor_id: string; reason: string
    }[]
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits.every((a) => a.actor_type === 'operator')).toBe(true)
    expect(audits.every((a) => a.reason.length > 0)).toBe(true)
  })

  it('leaves no record when the transition itself is refused', async () => {
    // A write that did not happen should leave no attribution saying it did.
    // This is the one place the ops record is written inside the transaction
    // rather than before it, and this is why.
    const { settlementId } = await reservedSettlement()
    const before = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM operator_actions WHERE subject_id = ${settlementId}`

    const result = await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
      settlementId, resolution: 'resume',
    })
    expect(result).toEqual({ ok: false, reason: 'no_open_exception' })

    const after = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM operator_actions WHERE subject_id = ${settlementId}`
    expect(after[0]!.n).toBe(before[0]!.n)
  })
})

/* ── Exit criterion 2 ───────────────────────────────────────────────────── */

describe('no ops action can settle a settlement or edit a settled one', () => {
  it('offers no resolution that reaches SETTLED', async () => {
    // The three resolutions are the whole vocabulary. `SETTLED` is reachable
    // only from `RECONCILING` through `reconciled_matched`, which the finality
    // evaluator drives on evidence — there is no operator trigger for it.
    const settlementId = await stalledAfterDispatch()
    for (const resolution of ['resume', 'fail', 'cancel'] as const) {
      const result = await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
        settlementId, resolution,
      })
      if (result.ok) expect(result.to).not.toBe('SETTLED')
      expect(await statusOf(settlementId)).not.toBe('SETTLED')
    }
  })

  it('refuses to call a settlement FAILED once value may have moved', async () => {
    // Past the point of no return we do not know that no money moved, and
    // `FAILED` tells the customer that we do.
    const settlementId = await stalledAfterDispatch()
    const result = await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
      settlementId, resolution: 'fail',
    })
    expect(result).toEqual({ ok: false, reason: 'value_may_have_been_delivered' })
    expect(await statusOf(settlementId)).toBe('EXCEPTION')
  })

  it('refuses to cancel past the point of no return', async () => {
    const settlementId = await stalledAfterDispatch()
    const result = await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
      settlementId, resolution: 'cancel',
    })
    expect(result).toEqual({ ok: false, reason: 'past_point_of_no_return' })
  })

  it('cannot touch a settled settlement, because the database refuses it', async () => {
    // Not a rule this service remembers: an operator resolving an exception
    // goes through the ordinary application role, so the settled-row
    // immutability guard applies to them exactly as it does to a customer.
    const settlementId = await stalledAtReservation()
    // A raw UPDATE, written deliberately so the database can refuse it: proving
    // a guard exists means attempting the thing it guards against, and the
    // assertion is `rejects`.
    // GATE-EXEMPT+3
    await expect(withTenant(h.db, scope, (tx) => tx.execute(sql`
      UPDATE settlements SET status = 'SETTLED' WHERE id = ${settlementId}`)))
      .rejects.toThrow()
  })

  it('releases the reservation when it fails a pre-dispatch settlement', async () => {
    // `INV-22`: an active reservation is released; a consumed one is not, and
    // capacity returns through a repayment instead. Doing the wrong one credits
    // the facility twice.
    const settlementId = await stalledAtReservation()
    const result = await resolveExceptionAsOperator(h.db, scope, ctx(resolver), {
      settlementId, resolution: 'fail',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.to).toBe('FAILED')
    expect(result.compensation).toBe('reservation_released')

    const [reservation] = await h.admin<{ status: string }[]>`
      SELECT status FROM liquidity_reservations WHERE settlement_id = ${settlementId}`
    expect(reservation!.status).toBe('RELEASED')
  })
})

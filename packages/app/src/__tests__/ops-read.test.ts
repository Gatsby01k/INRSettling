/**
 * The nine areas `PRODUCT.md § 14` names, read across tenants.
 *
 * > settlements, liquidity facilities, reservations, drawdowns, repayments,
 * > payout providers, reconciliation queues, exceptions, raw provider events,
 * > and the audit log.
 * >
 * > **The internal tool may expose complexity. The customer product must not.**
 *
 * Both halves of that last sentence are under test here: ops sees the internal
 * status and the provider's own vocabulary, and ops still does **not** see an
 * account number — because `SECURITY.md § 8` has no ops exception and the
 * ciphertext columns are not granted to the role.
 *
 * Also here: the `ops_liquidity` actions, whose interesting case is a limit
 * lowered below what the facility already carries.
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
  SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider,
} from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { createSettlement } from '../settlement-transition.service.js'
import { attachQuote, authorizeSettlement, runSettlementPreflight } from '../settlement.service.js'
import { createQuote } from '../quote.service.js'
import { createFacility } from '../liquidity.service.js'
import { reserveForSettlement } from '../settlement-liquidity.service.js'
import { activeRuleSetVersion, loadRuleSetFromDatabase } from '../reference-data.service.js'
import { withOperatorRead, type OperatorContext } from '../ops/access.service.js'
import {
  opsAuditLog, opsExceptionQueue, opsFacilities, opsFacilityMovements,
  opsOperatorHistory, opsProviderEvents, opsReconciliationQueue, opsSettlement,
} from '../ops/read.service.js'
import { setFacilityLimit, setFacilityStatus } from '../ops/liquidity.service.js'
import {
  createOperator, establishOperatorSession, resolveOperatorSession, type NetworkPolicy,
} from '../ops/session.service.js'

let h: Harness
let opsDb: Db
let closeOps: (() => Promise<void>) | undefined
let ruleSet: PreflightRuleSet

const DB = `inrsettle_test_ops_read_${process.pid}`
const A: TenantScope = { workspaceId: 'ws_read_a', environment: 'sandbox' }
const B: TenantScope = { workspaceId: 'ws_read_b', environment: 'sandbox' }
const creator: PrincipalRef = { type: 'user', id: 'usr_a' }
const OFFICE: NetworkPolicy = { name: 'office-v1', allowedCidrs: ['10.0.0.0/8'] }
const DEVICE = 'ops-laptop-01'

const AMOUNT = 500_000_000n
const UNIT = 1_000_000n
const ACCOUNT = '50100123456789'

const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}

let readerCtx: OperatorContext
let liquidityCtx: OperatorContext
let liquidityOperatorId = ''
let readerOperatorId = ''

let settlementA = ''
let facilityA = ''

const inA = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => withTenant(h.db, A, fn)

async function operatorCtx(
  roles: readonly string[], suffix: string, action: string,
): Promise<{ id: string; ctx: OperatorContext }> {
  const id = await createOperator(h.db, {
    email: `${suffix}@inrsettle.test`, displayName: suffix,
    roles: roles as never, grantedBy: 'opr_root',
  })
  const established = await establishOperatorSession(h.db, {
    operatorId: id, mfaMethod: 'totp', ip: '10.3.3.3',
    deviceFingerprint: DEVICE, policy: OFFICE,
  })
  if (!established.ok) throw new Error(`establish: ${established.reason}`)
  const resolved = await resolveOperatorSession(h.db, established.sessionId, {
    ip: '10.3.3.3', deviceFingerprint: DEVICE, policy: OFFICE,
  })
  if (!resolved.ok) throw new Error(`resolve: ${resolved.reason}`)
  return {
    id,
    ctx: {
      operator: resolved.operator,
      action,
      reason: 'Investigating a stalled settlement reported by the customer.',
      requestId: 'req_ops_read',
      ip: '10.3.3.3',
    },
  }
}

beforeAll(async () => {
  h = await createTestDatabase('ops_read')
  for (const [scope, user] of [[A, 'usr_a'], [B, 'usr_b']] as const) {
    await seedWorkspace(h.admin, {
      workspaceId: scope.workspaceId, userId: user, email: `${user}@example.test`,
      roles: ['admin', 'approver', 'operator'],
    })
  }
  // A second member of workspace A. Separation of duties means the person who
  // creates a settlement is not the one who authorizes it.
  await h.admin`INSERT INTO users (id, email) VALUES ('usr_appr', 'appr@example.test')`
  await h.admin`
    INSERT INTO memberships (id, workspace_id, environment, user_id)
    VALUES ('mem_appr', ${A.workspaceId}, 'sandbox', 'usr_appr')`
  await h.admin`
    INSERT INTO membership_roles (membership_id, workspace_id, environment, role)
    VALUES ('mem_appr', ${A.workspaceId}, 'sandbox', 'approver'),
           ('mem_appr', ${A.workspaceId}, 'sandbox', 'operator')`
  await h.admin`
    INSERT INTO internal_operators (id, email, display_name, status)
    VALUES ('opr_root', 'root@inrsettle.test', 'Root', 'active')`

  const version = await activeRuleSetVersion(h.admin, 'sandbox', new Date())
  ruleSet = (await loadRuleSetFromDatabase(h.admin, version!))!.ruleSet

  const ops = createClient(opsConnectionString(DB), { max: 2 })
  opsDb = ops.db
  closeOps = ops.close

  const readerSetup = await operatorCtx(['ops_read'], 'opsreader', 'ops.settlement_read')
  readerOperatorId = readerSetup.id
  readerCtx = readerSetup.ctx
  const liquiditySetup = await operatorCtx(
    ['ops_liquidity'], 'opsliquidity', 'ops.facility_limit_changed')
  liquidityOperatorId = liquiditySetup.id
  liquidityCtx = liquiditySetup.ctx

  // One settlement, staged through the real services, reserved against a real
  // facility. A forged row would make the masking assertions meaningless.
  facilityA = (await inA((tx) => createFacility(tx, A, {
    providerId: 'mock_liquidity', currency: 'USDT',
    limit: money('USDT', 100n * UNIT), actor: creator,
  }))).id

  const beneficiary = await inA((tx) => createBeneficiary(tx, A, crypto, {
    identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN' },
    destination: {
      kind: 'bank_account', accountNumber: ACCOUNT, ifsc: 'HDFC0000123',
      accountType: 'savings', accountHolderName: 'Aarti Sharma',
    },
    actor: creator,
  }))
  await requestVerification(
    h.db, A, createSandboxVerificationProvider(), crypto.cipher,
    SANDBOX_NAME_MATCH_POLICIES,
    { destinationVersionId: beneficiary.destinations[0]!.currentVersion!.id, actor: creator },
  )

  settlementA = (await inA((tx) => createSettlement(tx, A, {
    beneficiaryId: beneficiary.id, recipientAmountMinor: AMOUNT, fundingCurrency: 'USDT',
    purposeCode: 'SOFTWARE_SERVICES', externalReference: 'ops_read_1', actor: creator,
  }))).id
  const pre = await runSettlementPreflight(h.db, A, {
    settlementId: settlementA, ruleSet, actor: creator,
    documents: ['commercial_invoice'], hasActiveLiquidityFacility: true,
  })
  if (!pre.ok) throw new Error(`preflight: ${JSON.stringify(pre)}`)

  // Authorized and reserved, so the facility actually carries something. The
  // limit guard below is only meaningful against a committed amount.
  const quote = await inA((tx) => createQuote(tx, A, {
    fundingCurrency: 'USDT', recipientAmount: { currency: 'INR', minorUnits: AMOUNT },
    actor: creator,
  }))
  const attached = await inA((tx) =>
    attachQuote(tx, A, { settlementId: settlementA, quoteId: quote.id, actor: creator }))
  if (!attached.ok) throw new Error(`attach: ${JSON.stringify(attached)}`)
  const authorized = await inA((tx) => authorizeSettlement(tx, A, {
    settlementId: settlementA, actor: { type: 'user', id: 'usr_appr' },
    actorRoles: ['approver', 'operator'], ruleSet,
    hasActiveLiquidityFacility: true, documents: ['commercial_invoice'],
  }))
  if (!authorized.ok) throw new Error(`authorize: ${JSON.stringify(authorized)}`)

  const reserved = await reserveForSettlement(h.db, A, {
    settlementId: settlementA, facilityId: facilityA,
    fundingAmount: money('USDT', UNIT), ttlSeconds: 900, actor: creator,
  })
  if (!reserved.ok) throw new Error(`reserve: ${JSON.stringify(reserved)}`)
})

afterAll(async () => {
  if (closeOps) await closeOps()
  if (h) await h.close()
})

const read = <T>(scopes: readonly TenantScope[], fn: (conn: Db) => Promise<T>): Promise<T> =>
  withOperatorRead(h.db, opsDb, readerCtx, { scopes }, fn)

/* ── Complexity, exposed ────────────────────────────────────────────────── */

describe('a settlement, as ops sees it', () => {
  it('shows the internal status, which the customer product never does', async () => {
    const view = await read([A], (conn) => opsSettlement(conn, settlementA))
    expect(view).not.toBeNull()
    // `LIQUIDITY_RESERVED` is an internal status with no customer equivalent:
    // the customer sees `settling` for this and for four other states. That is
    // the whole reason a second surface exists.
    expect(view!.status).toBe('LIQUIDITY_RESERVED')
    expect(view!.version).toBeGreaterThan(0)
    expect(view!.workspaceId).toBe(A.workspaceId)
    expect(view!.customerStatus).toBe('SETTLING')
  })

  it('still shows the payout destination masked, because § 8 has no ops exception', async () => {
    const view = await read([A], (conn) => opsSettlement(conn, settlementA))
    expect(JSON.stringify(view)).not.toContain(ACCOUNT)
    expect(view!.beneficiaryName).toBe('Aarti Sharma')
  })

  it('cannot reach the ciphertext even by asking for it directly', async () => {
    // The column is not granted to this role, so the masking above is a fact
    // about the connection rather than a discipline the read service keeps.
    await expect(opsDb.execute(sql`
      SELECT account_number_ciphertext FROM payout_destination_versions`))
      .rejects.toThrow(/permission denied/i)
  })
})

/* ── The queues ─────────────────────────────────────────────────────────── */

describe('the queues § 14 names', () => {
  it('reads facilities with availability derived, not stored', async () => {
    const facilities = await read([A], (conn) => opsFacilities(conn, [A]))
    expect(facilities).toHaveLength(1)
    const facility = facilities[0]!
    expect(facility.id).toBe(facilityA)
    // limit − drawn − reserved, computed in the query. A stored copy would be a
    // second source of truth that can disagree with the ledger.
    expect(BigInt(facility.available.minorUnits))
      .toBe(BigInt(facility.limit.minorUnits)
        - BigInt(facility.drawn.minorUnits)
        - BigInt(facility.reserved.minorUnits))
  })

  it('reads reservations, drawdowns and repayments as one history', async () => {
    const movements = await read([A], (conn) => opsFacilityMovements(conn, [A]))
    expect(movements.some((m) => m.kind === 'reservation')).toBe(true)
    // An operator chasing a stuck settlement should not have to open three
    // screens and merge them by timestamp in their head.
    const reservation = movements.find((m) => m.kind === 'reservation')!
    expect(reservation.settlementId).toBe(settlementA)
    expect(reservation.expiresAt).not.toBeNull()
  })

  it('reads the exception, reconciliation and provider-event queues', async () => {
    // Empty is a real answer, and the shape being right matters more than the
    // rows: these run against the live catalogue, so a renamed column fails
    // here rather than in production.
    const [exceptions, reconciliations, providerEvents] = await read([A, B], async (conn) => [
      await opsExceptionQueue(conn, [A, B]),
      await opsReconciliationQueue(conn, [A, B]),
      await opsProviderEvents(conn, [A, B]),
    ] as const)
    expect(Array.isArray(exceptions)).toBe(true)
    expect(Array.isArray(reconciliations)).toBe(true)
    expect(Array.isArray(providerEvents)).toBe(true)
  })

  it('reads the audit log across workspaces, filtered to a subject', async () => {
    const entries = await read([A], (conn) =>
      opsAuditLog(conn, [A], { subjectId: settlementA }))
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((e) => e.subjectId === settlementA)).toBe(true)
    expect(entries.every((e) => e.workspaceId === A.workspaceId)).toBe(true)
  })

  it('answers "what has this operator been doing" across every workspace', async () => {
    // The reason `operator_actions` exists alongside `audit_log`: this question
    // spans tenants, and answering it from the per-workspace log would mean
    // scanning every workspace in the deployment.
    await read([A, B], async () => undefined)
    const history = await opsOperatorHistory(opsDb, readerOperatorId)
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(new Set(history.map((a) => a.workspaceId)).size).toBeGreaterThanOrEqual(2)
    expect(history.every((a) => a.reason.length > 0)).toBe(true)
  })

  it('returns nothing rather than everything when given no scopes', async () => {
    // A defensive shape: these functions are the ones with the cross-tenant
    // connection, so an empty filter must not become "no WHERE clause".
    expect(await opsExceptionQueue(opsDb, [])).toEqual([])
    expect(await opsFacilities(opsDb, [])).toEqual([])
    expect(await opsAuditLog(opsDb, [])).toEqual([])
  })

  it('does not leak workspace B into a read scoped to workspace A', async () => {
    // The permissive policy is `USING (true)`, so the scoping here is the
    // query's own predicate — which is exactly why it is asserted.
    const facilities = await read([A], (conn) => opsFacilities(conn, [A]))
    expect(facilities.every((f) => f.workspaceId === A.workspaceId)).toBe(true)
  })
})

/* ── ops_liquidity ──────────────────────────────────────────────────────── */

describe('an operator changing a facility limit', () => {
  it('raises headroom without touching drawn or reserved', async () => {
    const before = (await read([A], (conn) => opsFacilities(conn, [A])))[0]!
    const result = await setFacilityLimit(h.db, A, liquidityCtx, {
      facilityId: facilityA, limit: money('USDT', 200n * UNIT),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.next.minorUnits).toBe(200n * UNIT)

    const after = (await read([A], (conn) => opsFacilities(conn, [A])))[0]!
    expect(after.drawn.minorUnits).toBe(before.drawn.minorUnits)
    expect(after.reserved.minorUnits).toBe(before.reserved.minorUnits)
  })

  it('refuses a limit below what the facility already carries, and says by how much', async () => {
    // `drawn + reserved` is money that has moved or is promised. A limit under
    // it would make availability negative, which is an incident rather than a
    // number.
    const result = await setFacilityLimit(h.db, A, liquidityCtx, {
      facilityId: facilityA, limit: money('USDT', 1n),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('below_committed')
    expect(result.committed?.minorUnits).toBeGreaterThan(0n)
  })

  it('refuses a limit in the wrong currency', async () => {
    const result = await setFacilityLimit(h.db, A, liquidityCtx, {
      facilityId: facilityA, limit: money('INR', 100n),
    })
    expect(result).toMatchObject({ ok: false, reason: 'currency_mismatch' })
  })

  it('is attributed and reasoned, like every other operator action', async () => {
    await setFacilityLimit(h.db, A, liquidityCtx, {
      facilityId: facilityA, limit: money('USDT', 300n * UNIT),
    })
    const [action] = await h.admin<{ operator_id: string; kind: string; reason: string }[]>`
      SELECT operator_id, kind, reason FROM operator_actions
       WHERE subject_id = ${facilityA} AND kind = 'write'
       ORDER BY created_at DESC LIMIT 1`
    expect(action!.operator_id).toBe(liquidityOperatorId)
    expect(action!.reason.length).toBeGreaterThan(0)
  })

  it('is refused to an operator who only holds ops:read', async () => {
    await expect(setFacilityLimit(h.db, A, readerCtx, {
      facilityId: facilityA, limit: money('USDT', 400n * UNIT),
    })).rejects.toThrow(/does not hold ops:liquidity_manage/)
  })

  it('suspends and reactivates, and refuses a no-op', async () => {
    const suspended = await setFacilityStatus(h.db, A, liquidityCtx, {
      facilityId: facilityA, status: 'SUSPENDED',
    })
    expect(suspended).toMatchObject({ ok: true, from: 'ACTIVE', to: 'SUSPENDED' })

    expect(await setFacilityStatus(h.db, A, liquidityCtx, {
      facilityId: facilityA, status: 'SUSPENDED',
    })).toMatchObject({ ok: false, reason: 'no_change' })

    const back = await setFacilityStatus(h.db, A, liquidityCtx, {
      facilityId: facilityA, status: 'ACTIVE',
    })
    expect(back).toMatchObject({ ok: true, to: 'ACTIVE' })
  })
})

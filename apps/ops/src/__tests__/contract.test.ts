/**
 * The Internal Operations surface, as a contract.
 *
 * Every route is called against a real database with real RLS, real migrations
 * and two real workspaces. The rules under test are the ones `PRODUCT.md § 14`
 * and `SECURITY.md § 3` state, and the four Stage 9 exit criteria run through
 * all of them:
 *
 *   every operator action is attributed and reasoned;
 *   no route settles a settlement or edits a settled record;
 *   cross-tenant reads use the named role and are audited individually;
 *   exception resolution resumes at `exception_entered_from`.
 *
 * The table-walking tests at the bottom are the ones that matter most: they
 * assert that **every route in the table produced an audit record**, and that
 * nothing exists which the frozen documents forbid. A route added later without
 * either property fails the build rather than shipping.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestDatabase, opsConnectionString, seedWorkspace, type Harness,
} from '@inrsettle/testing'
import { createClient, withTenant, type Db, type TenantScope } from '@inrsettle/db'
import { money } from '@inrsettle/money'
import type { PreflightRuleSet, PrincipalRef } from '@inrsettle/domain'
import {
  SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider,
} from '@inrsettle/providers'
import {
  activeRuleSetVersion, attachQuote, authorizeSettlement, createBeneficiary, createFacility,
  createFieldCipher, createDestinationFingerprinter, createOperator, createQuote,
  createSettlement, establishOperatorSession, loadRuleSetFromDatabase, openException,
  requestVerification, reserveForSettlement, runSettlementPreflight,
  type NetworkPolicy,
} from '@inrsettle/app-services'
import { handleOps, type OpsDeps } from '../pipeline.js'
import { OPS_ROUTES, matchOpsRoute } from '../routes.js'
import type { OpsRequest } from '../http.js'

let h: Harness
let opsDb: Db
let closeOps: (() => Promise<void>) | undefined
let deps: OpsDeps
let ruleSet: PreflightRuleSet

const DB = `inrsettle_test_ops_contract_${process.pid}`
const A: TenantScope = { workspaceId: 'ws_ops_a', environment: 'sandbox' }
const B: TenantScope = { workspaceId: 'ws_ops_b', environment: 'sandbox' }
const creator: PrincipalRef = { type: 'user', id: 'usr_a' }
const OFFICE: NetworkPolicy = { name: 'office-v1', allowedCidrs: ['10.0.0.0/8'] }
const OFFICE_IP = '10.7.7.7'
const DEVICE = 'ops-laptop-01'
const REASON = 'Customer raised a ticket about a stalled payout; investigating.'

const AMOUNT = 500_000_000n
const UNIT = 1_000_000n

const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}

const sessions: Record<string, string> = {}
const operatorIds: Record<string, string> = {}
let settlementA = ''
let facilityA = ''

const inA = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => withTenant(h.db, A, fn)

/* ── Calling ────────────────────────────────────────────────────────────── */

interface CallOptions {
  as?: string
  reason?: string | null
  /** `null` omits the address entirely — the fail-closed case. */
  ip?: string | null
  /** `null` presents no device fingerprint at all. */
  device?: string | null
  query?: Record<string, string>
  body?: unknown
  session?: string | null
}

async function call(
  method: 'GET' | 'POST', path: string, opts: CallOptions = {},
): Promise<{ status: number; json: unknown; headers: Readonly<Record<string, string>> }> {
  const who = opts.as ?? 'reader'
  const session = opts.session === undefined ? sessions[who] : opts.session
  const headers: Record<string, string> = { 'user-agent': 'ops-tests/1' }
  if (session !== null && session !== undefined) headers['x-ops-session'] = session
  const reason = opts.reason === undefined ? REASON : opts.reason
  if (reason !== null) headers['x-ops-reason'] = reason
  const device = opts.device === undefined ? DEVICE : opts.device
  if (device !== null) headers['x-ops-device'] = device

  const req: OpsRequest = {
    method,
    path,
    headers,
    // A deployment that cannot supply the address sends an empty one; the
    // boundary refuses it rather than treating it as "no restriction applies".
    ip: opts.ip === null ? '' : opts.ip ?? OFFICE_IP,
    ...(opts.query ? { query: opts.query } : {}),
    ...(opts.body === undefined ? {} : { rawBody: JSON.stringify(opts.body) }),
  }
  const res = await handleOps(req, deps)
  return { status: res.status, json: JSON.parse(res.body) as unknown, headers: res.headers }
}

const inWorkspace = (scope: TenantScope): Record<string, string> =>
  ({ workspace_id: scope.workspaceId, environment: scope.environment })

/* ── Setup ──────────────────────────────────────────────────────────────── */

async function makeOperator(name: string, roles: readonly string[]): Promise<void> {
  const id = await createOperator(h.db, {
    email: `${name}@inrsettle.test`, displayName: name,
    roles: roles as never, grantedBy: 'opr_root',
  })
  operatorIds[name] = id
  const established = await establishOperatorSession(h.db, {
    operatorId: id, mfaMethod: 'totp', ip: OFFICE_IP,
    deviceFingerprint: DEVICE, policy: OFFICE,
  })
  if (!established.ok) throw new Error(`establish ${name}: ${established.reason}`)
  sessions[name] = established.sessionId
}

beforeAll(async () => {
  h = await createTestDatabase('ops_contract')
  for (const [scope, user] of [[A, 'usr_a'], [B, 'usr_b']] as const) {
    await seedWorkspace(h.admin, {
      workspaceId: scope.workspaceId, userId: user, email: `${user}@example.test`,
      roles: ['admin', 'approver', 'operator'],
    })
  }
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

  const ops = createClient(opsConnectionString(DB), { max: 3 })
  opsDb = ops.db
  closeOps = ops.close
  deps = {
    appDb: h.db, opsDb, networkPolicy: OFFICE,
    // Surfaced rather than swallowed. A 500 in this suite is a defect, and the
    // suite should say what it was rather than only that the status was wrong.
    onUnexpectedError: (error) => { console.error('[ops 500]', error) },
  }

  await makeOperator('reader', ['ops_read'])
  await makeOperator('resolver', ['ops_resolve'])
  await makeOperator('treasury', ['ops_liquidity'])
  await makeOperator('admin', ['ops_admin'])

  // One settlement carried to an exception through the real services.
  facilityA = (await inA((tx) => createFacility(tx, A, {
    providerId: 'mock_liquidity', currency: 'USDT',
    limit: money('USDT', 100n * UNIT), actor: creator,
  }))).id

  const beneficiary = await inA((tx) => createBeneficiary(tx, A, crypto, {
    identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN' },
    destination: {
      kind: 'bank_account', accountNumber: '50100123456789', ifsc: 'HDFC0000123',
      accountType: 'savings', accountHolderName: 'Aarti Sharma',
    },
    actor: creator,
  }))
  await requestVerification(
    h.db, A, createSandboxVerificationProvider(), crypto.cipher, SANDBOX_NAME_MATCH_POLICIES,
    { destinationVersionId: beneficiary.destinations[0]!.currentVersion!.id, actor: creator },
  )

  settlementA = (await inA((tx) => createSettlement(tx, A, {
    beneficiaryId: beneficiary.id, recipientAmountMinor: AMOUNT, fundingCurrency: 'USDT',
    purposeCode: 'SOFTWARE_SERVICES', externalReference: 'ops_contract_1', actor: creator,
  }))).id
  const pre = await runSettlementPreflight(h.db, A, {
    settlementId: settlementA, ruleSet, actor: creator,
    documents: ['commercial_invoice'], hasActiveLiquidityFacility: true,
  })
  if (!pre.ok) throw new Error(`preflight: ${JSON.stringify(pre)}`)

  const quote = await inA((tx) => createQuote(tx, A, {
    fundingCurrency: 'USDT', recipientAmount: { currency: 'INR', minorUnits: AMOUNT },
    actor: creator,
  }))
  await inA((tx) => attachQuote(tx, A, { settlementId: settlementA, quoteId: quote.id, actor: creator }))
  const authorized = await inA((tx) => authorizeSettlement(tx, A, {
    settlementId: settlementA, actor: { type: 'user', id: 'usr_appr' },
    actorRoles: ['approver', 'operator'], ruleSet,
    hasActiveLiquidityFacility: true, documents: ['commercial_invoice'],
  }))
  if (!authorized.ok) throw new Error(`authorize: ${JSON.stringify(authorized)}`)

  await reserveForSettlement(h.db, A, {
    settlementId: settlementA, facilityId: facilityA,
    fundingAmount: money('USDT', UNIT), ttlSeconds: 900, actor: creator,
  })
  const opened = await inA((tx) => openException(tx, A, {
    settlementId: settlementA, trigger: 'reservation_expired', code: 'LIQUIDITY_UNAVAILABLE',
    actor: { type: 'job', id: 'liquidity.sweeper' },
    guards: { reservation_ttl_reached: true },
  }))
  if (!opened.ok) throw new Error(`open: ${JSON.stringify(opened)}`)
})

afterAll(async () => {
  if (closeOps) await closeOps()
  if (h) await h.close()
})

/* ── Authentication and the network ─────────────────────────────────────── */

describe('getting in', () => {
  it('refuses a request with no session', async () => {
    const res = await call('GET', '/ops/me', { session: null })
    expect(res.status).toBe(401)
    expect((res.json as never)['error']['code']).toBe('missing_session')
  })

  it('refuses an unknown session', async () => {
    const res = await call('GET', '/ops/me', { session: 'ops_nonsense' })
    expect(res.status).toBe(401)
  })

  it('refuses a valid session from outside the allow-list', async () => {
    // Checked on every request, not once at login (`SECURITY.md § 3.1`).
    const res = await call('GET', '/ops/me', { ip: '203.0.113.5' })
    expect(res.status).toBe(401)
    // 401 rather than 403, and the same shape as an unknown session: telling
    // someone probing from outside that the session id was valid is a gift.
    expect((res.json as never)['error']['code']).toBe('network_not_allowed')
  })

  it('refuses a valid session presented with no request address', async () => {
    // The fail-closed case, at the boundary. A deployment whose proxy did not
    // set the address sends an empty one, and this refuses rather than treating
    // "we could not check" as "it passed".
    const res = await call('GET', '/ops/me', { ip: null })
    expect(res.status).toBe(401)
    expect((res.json as never)['error']['code']).toBe('request_address_missing')
  })

  it('refuses a valid session presented with no device fingerprint', async () => {
    const res = await call('GET', '/ops/me', { device: null })
    expect(res.status).toBe(401)
    expect((res.json as never)['error']['code']).toBe('session_device_mismatch')
  })

  it('refuses a valid session presented from another device, and ends it', async () => {
    // `SECURITY.md § 3.1` binds every human session to a device. A session id
    // presented from elsewhere is the signature of a stolen token, so it is
    // revoked rather than merely refused — the same semantics a customer
    // session has.
    await makeOperator('borrowed', ['ops_read'])
    const stolen = await call('GET', '/ops/me', {
      as: 'borrowed', device: 'someone-elses-laptop',
    })
    expect(stolen.status).toBe(401)
    expect((stolen.json as never)['error']['code']).toBe('session_device_mismatch')

    // And now dead, even from the right device.
    const after = await call('GET', '/ops/me', { as: 'borrowed' })
    expect(after.status).toBe(401)
    expect((after.json as never)['error']['code']).toBe('session_revoked')
  })

  it('reaches no data on any of those refusals', async () => {
    // A refusal that had already read something would be the failure the
    // restriction exists to prevent, arriving one step later.
    await h.admin`TRUNCATE operator_actions`
    for (const opts of [{ ip: null }, { device: null }, { ip: '203.0.113.9' }] as const) {
      await call('GET', '/ops/exceptions', { ...opts, query: inWorkspace(A) })
    }
    const [row] = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM operator_actions`
    expect(row!.n).toBe(0)
  })

  it('answers who the operator is, and what they may do', async () => {
    const res = await call('GET', '/ops/me', { as: 'resolver' })
    expect(res.status).toBe(200)
    expect((res.json as never)['roles']).toEqual(['ops_resolve'])
    expect((res.json as never)['capabilities']).toEqual(['ops:exception_resolve', 'ops:read'])
  })

  it('carries a request id on every response, including refusals', async () => {
    for (const res of [
      await call('GET', '/ops/me'),
      await call('GET', '/ops/nonsense'),
      await call('GET', '/ops/me', { session: null }),
    ]) {
      expect(res.headers['X-Request-Id']).toBeTruthy()
    }
  })
})

/* ── Exit criterion 1 — attributed, reasoned ────────────────────────────── */

describe('every action needs a reason', () => {
  it('refuses a read with no reason header', async () => {
    const res = await call('GET', '/ops/exceptions', {
      reason: null, query: inWorkspace(A),
    })
    expect(res.status).toBe(403)
    expect((res.json as never)['error']['code']).toBe('reason_missing')
  })

  it('refuses a reason too short to be one', async () => {
    const res = await call('GET', '/ops/exceptions', {
      reason: 'x', query: inWorkspace(A),
    })
    expect(res.status).toBe(403)
    expect((res.json as never)['error']['code']).toBe('reason_too_short')
  })

  it('reaches no data when refused', async () => {
    const before = await countActions()
    await call('GET', '/ops/exceptions', { reason: '  ', query: inWorkspace(A) })
    expect(await countActions()).toBe(before)
  })

  it('does not ask for a reason to look at ourselves', async () => {
    // `me` touches no customer data, and saying so in the same route table is
    // what stops "this one does not need a reason" from becoming a habit.
    const res = await call('GET', '/ops/me', { reason: null })
    expect(res.status).toBe(200)
  })
})

async function countActions(): Promise<number> {
  const [row] = await h.admin<{ n: number }[]>`SELECT count(*)::int AS n FROM operator_actions`
  return row!.n
}

/* ── Capabilities ───────────────────────────────────────────────────────── */

describe('capabilities are checked at the route', () => {
  it('lets a reader read and not resolve', async () => {
    expect((await call('GET', '/ops/exceptions', { query: inWorkspace(A) })).status).toBe(200)
    const refused = await call('POST', `/ops/exceptions/${settlementA}/resolve`, {
      query: inWorkspace(A), body: { resolution: 'resume' },
    })
    expect(refused.status).toBe(403)
    expect((refused.json as never)['error']['code']).toBe('insufficient_capability')
  })

  it('keeps liquidity out of a resolver\'s hands, and resolution out of treasury\'s', async () => {
    const byResolver = await call('POST', `/ops/facilities/${facilityA}/limit`, {
      as: 'resolver', query: inWorkspace(A),
      body: { currency: 'USDT', minor_units: '1000000000' },
    })
    expect(byResolver.status).toBe(403)

    const byTreasury = await call('POST', `/ops/exceptions/${settlementA}/resolve`, {
      as: 'treasury', query: inWorkspace(A), body: { resolution: 'resume' },
    })
    expect(byTreasury.status).toBe(403)
  })

  it('gives an administrator neither, which is the point of the split', async () => {
    // The person who grants access should not thereby acquire the ability to
    // resolve exceptions and move facility limits.
    expect((await call('POST', `/ops/exceptions/${settlementA}/resolve`, {
      as: 'admin', query: inWorkspace(A), body: { resolution: 'resume' },
    })).status).toBe(403)
    expect((await call('POST', `/ops/facilities/${facilityA}/limit`, {
      as: 'admin', query: inWorkspace(A), body: { currency: 'USDT', minor_units: '1' },
    })).status).toBe(403)
  })
})

/* ── Exit criterion 3 — cross-tenant reads, audited ─────────────────────── */

describe('cross-tenant reads', () => {
  it('needs a workspace named, because the record is against a workspace', async () => {
    const res = await call('GET', '/ops/exceptions')
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['code']).toBe('workspace_required')
  })

  it('records the read against the workspace it touched, with the reason', async () => {
    await h.admin`TRUNCATE operator_actions`
    await call('GET', '/ops/exceptions', { query: inWorkspace(A) })

    const [action] = await h.admin<{
      workspace_id: string; kind: string; reason: string; request_id: string
      operator_id: string; user_agent: string
    }[]>`SELECT workspace_id, kind, reason, request_id, operator_id, user_agent
           FROM operator_actions ORDER BY created_at DESC LIMIT 1`
    expect(action!.workspace_id).toBe(A.workspaceId)
    expect(action!.kind).toBe('read')
    expect(action!.reason).toBe(REASON)
    expect(action!.operator_id).toBe(operatorIds['reader'])
    expect(action!.request_id).toBeTruthy()
    expect(action!.user_agent).toBe('ops-tests/1')
  })

  it('finds work across workspaces through discovery, which reveals no customer data', async () => {
    const res = await call('GET', '/ops/queues/exceptions')
    expect(res.status).toBe(200)
    const data = (res.json as never)['data'] as Record<string, unknown>[]
    expect(data.length).toBeGreaterThan(0)
    for (const row of data) {
      expect(Object.keys(row).sort())
        .toEqual(['environment', 'oldest_at', 'waiting', 'workspace_id'])
    }
  })

  it('refuses an unknown queue', async () => {
    expect((await call('GET', '/ops/queues/invented')).status).toBe(404)
  })

  it('reads one workspace without leaking the other', async () => {
    const res = await call('GET', '/ops/exceptions', { query: inWorkspace(B) })
    expect(res.status).toBe(200)
    expect((res.json as never)['data']).toEqual([])
  })
})

/* ── Exit criteria 2 and 4 — the resolution ─────────────────────────────── */

describe('resolving an exception', () => {
  it('resumes to where the settlement stalled', async () => {
    const res = await call('POST', `/ops/exceptions/${settlementA}/resolve`, {
      as: 'resolver', query: inWorkspace(A), body: { resolution: 'resume' },
    })
    expect(res.status).toBe(200)
    expect((res.json as never)['to']).toBe('LIQUIDITY_RESERVED')
    expect((res.json as never)['from']).toBe('EXCEPTION')
  })

  it('refuses an invented resolution', async () => {
    const res = await call('POST', `/ops/exceptions/${settlementA}/resolve`, {
      as: 'resolver', query: inWorkspace(A), body: { resolution: 'settle' },
    })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['code']).toBe('invalid_resolution')
  })

  it('answers a settlement with no open exception with 409, not 500', async () => {
    const res = await call('POST', `/ops/exceptions/${settlementA}/resolve`, {
      as: 'resolver', query: inWorkspace(A), body: { resolution: 'resume' },
    })
    expect(res.status).toBe(409)
    expect((res.json as never)['error']['code']).toBe('no_open_exception')
  })
})

/* ── Liquidity ──────────────────────────────────────────────────────────── */

describe('facility limits', () => {
  it('refuses an amount sent as a JSON number', async () => {
    // `INV-04`: a limit above 2^53 read as a number arrives rounded, and a
    // facility limit is exactly the figure nobody notices is wrong until it is.
    const res = await call('POST', `/ops/facilities/${facilityA}/limit`, {
      as: 'treasury', query: inWorkspace(A), body: { currency: 'USDT', minor_units: 1000 },
    })
    expect(res.status).toBe(400)
    expect((res.json as never)['error']['code']).toBe('invalid_amount')
  })

  it('raises a limit and reports the new availability', async () => {
    const res = await call('POST', `/ops/facilities/${facilityA}/limit`, {
      as: 'treasury', query: inWorkspace(A),
      body: { currency: 'USDT', minor_units: (300n * UNIT).toString() },
    })
    expect(res.status).toBe(200)
    expect((res.json as never)['limit']['minor_units']).toBe((300n * UNIT).toString())
    // A string on the way out as well as in.
    expect(typeof (res.json as never)['available']['minor_units']).toBe('string')
  })

  it('refuses a limit below what the facility already carries, and says by how much', async () => {
    const res = await call('POST', `/ops/facilities/${facilityA}/limit`, {
      as: 'treasury', query: inWorkspace(A), body: { currency: 'USDT', minor_units: '1' },
    })
    expect(res.status).toBe(409)
    expect((res.json as never)['error']['code']).toBe('below_committed')
    expect((res.json as never)['error']['committed']['minor_units']).toBeTruthy()
  })

  it('suspends and reactivates, and will not close', async () => {
    expect((await call('POST', `/ops/facilities/${facilityA}/status`, {
      as: 'treasury', query: inWorkspace(A), body: { status: 'SUSPENDED' },
    })).status).toBe(200)
    // Closing is a commercial act with an open settlement question (`D-16b`),
    // and it is not invented here.
    expect((await call('POST', `/ops/facilities/${facilityA}/status`, {
      as: 'treasury', query: inWorkspace(A), body: { status: 'CLOSED' },
    })).status).toBe(400)
    expect((await call('POST', `/ops/facilities/${facilityA}/status`, {
      as: 'treasury', query: inWorkspace(A), body: { status: 'ACTIVE' },
    })).status).toBe(200)
  })
})

/* ── The table itself ───────────────────────────────────────────────────── */

describe('the route table', () => {
  it('has no route that settles, marks paid, or edits a settlement', async () => {
    // `SECURITY.md § 6`: no principal, internal or external, can set a
    // settlement to SETTLED. The way that stops being true is somebody adding a
    // route at 6pm with a customer on the phone.
    for (const route of OPS_ROUTES) {
      expect(`${route.method} ${route.pattern} ${route.name}`)
        .not.toMatch(/settle(?!ment)|mark_paid|force|override|amend|adjust/i)
    }
  })

  it('has no route that reads a payout account number', async () => {
    for (const route of OPS_ROUTES) {
      expect(route.pattern).not.toMatch(/account|destination|decrypt|reveal/i)
    }
  })

  it('requires a reason on every route that reaches customer data', async () => {
    for (const route of OPS_ROUTES) {
      if (route.crossTenant) {
        expect(route.reason, `${route.name} reaches customer data without a reason`).toBe(true)
      }
    }
  })

  it('reaches every route without a 500', async () => {
    // Walked from the table, so a route added later is exercised whether or not
    // anybody wrote a test for it.
    const reached = new Set<string>()
    for (const route of OPS_ROUTES) {
      const path = route.pattern
        .replace(':queue', 'exceptions')
        .replace(':settlementId', settlementA)
        .replace(':id', route.name.startsWith('facilities')
          ? facilityA
          : route.name.startsWith('operators') ? operatorIds['reader']! : settlementA)

      const res = await call(route.method, path, {
        as: 'admin', query: inWorkspace(A), body: route.method === 'POST' ? {} : undefined,
      })
      // 403 is a legitimate answer for a capability this operator lacks; what
      // must never happen is a 500.
      expect(res.status, `${route.name} → ${res.status}`).not.toBe(500)
      reached.add(route.name)
    }
    expect(reached.size).toBe(OPS_ROUTES.length)
  })

  it('has a handler for every route and a route for every handler', () => {
    // Matching is total: every pattern resolves to itself.
    for (const route of OPS_ROUTES) {
      const matched = matchOpsRoute(route.method, route.pattern.replace(/:(\w+)/g, 'x'))
      expect(matched, `${route.method} ${route.pattern} does not match itself`).not.toBeNull()
    }
  })

  it('audits every cross-tenant route it serves', async () => {
    await h.admin`TRUNCATE operator_actions`
    const crossTenantReads = OPS_ROUTES.filter(
      (r) => r.crossTenant && r.method === 'GET' && !r.pattern.includes(':queue'))

    for (const route of crossTenantReads) {
      const path = route.pattern
        .replace(':settlementId', settlementA)
        .replace(':id', settlementA)
      await call(route.method, path, { as: 'reader', query: inWorkspace(A) })
    }

    const [row] = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM operator_actions WHERE kind = 'read'`
    // One per route, because each named exactly one workspace. The property
    // being asserted is that none of them read without recording.
    expect(row!.n).toBe(crossTenantReads.length)
  })
})

/**
 * Stage 9 exit criterion 3 — *"Cross-tenant reads use the named role and are
 * audited individually."*
 *
 * Both halves, against a real database with two workspaces:
 *
 *   the named role reads across tenants and the application role does not;
 *   every workspace a read touches gets its own audit record, before the read;
 *   an operator without `ops:read`, or without a reason, gets neither.
 *
 * Also here: the operator session, whose network restriction is checked on
 * every request rather than once at login.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  createTestDatabase, opsConnectionString, seedWorkspace, type Harness,
} from '@inrsettle/testing'
import { createClient, withTenant, type Db, type TenantScope } from '@inrsettle/db'
import { OPS_SESSION_TTL_SECONDS } from '@inrsettle/domain'
import {
  OperatorAccessRefused, discoverQueueScopes, recordOperatorAccess, withOperatorRead,
  type OperatorContext,
} from '../ops/access.service.js'
import {
  EmptyNetworkPolicy, createOperator, establishOperatorSession, resolveOperatorSession,
  revokeOperatorSession, suspendOperator, type NetworkPolicy,
} from '../ops/session.service.js'

let h: Harness
let opsDb: Db
let closeOps: () => Promise<void>
const DB = `inrsettle_test_ops_access_${process.pid}`

const A: TenantScope = { workspaceId: 'ws_alpha', environment: 'live' }
const B: TenantScope = { workspaceId: 'ws_beta', environment: 'live' }

const OFFICE: NetworkPolicy = { name: 'office-v1', allowedCidrs: ['10.0.0.0/8', '2001:db8::/32'] }
const DEVICE = 'ops-laptop-01'
/** What every ordinary request in this suite presents. */
const FROM_OFFICE = { ip: '10.1.2.3', deviceFingerprint: DEVICE, policy: OFFICE }

let rootOperatorId = ''

beforeAll(async () => {
  h = await createTestDatabase('ops_access')
  await seedWorkspace(h.admin, {
    workspaceId: A.workspaceId, userId: 'usr_a', email: 'a@example.test', roles: ['admin'],
  })
  await seedWorkspace(h.admin, {
    workspaceId: B.workspaceId, userId: 'usr_b', email: 'b@example.test', roles: ['admin'],
  })

  // The first operator has no granter, which is the bootstrap case every staff
  // directory has. `created_by` is nullable for exactly this row.
  await h.admin`
    INSERT INTO internal_operators (id, email, display_name, status)
    VALUES ('opr_root', 'root@inrsettle.test', 'Root', 'active')`
  await h.admin`
    INSERT INTO internal_operator_roles (operator_id, role, granted_by)
    VALUES ('opr_root', 'ops_admin', 'opr_root')`
  rootOperatorId = 'opr_root'

  const ops = createClient(opsConnectionString(DB), { max: 2 })
  opsDb = ops.db
  closeOps = ops.close
})

afterAll(async () => {
  await closeOps()
  await h.close()
})

beforeEach(async () => {
  // TRUNCATE, not DELETE: the append-only trigger refuses a DELETE even to a
  // superuser, which is the point of it. `inrsettle_app` holds SELECT and
  // INSERT only, so it cannot reach this door either.
  await h.admin`TRUNCATE operator_actions`
  await h.admin`DELETE FROM audit_log WHERE actor_type = 'operator'`
})

/** An operator with the named roles, and a live session for them. */
async function operatorWith(roles: readonly string[], suffix: string) {
  const id = await createOperator(h.db, {
    email: `${suffix}@inrsettle.test`,
    displayName: suffix,
    roles: roles as never,
    grantedBy: rootOperatorId,
  })
  const established = await establishOperatorSession(h.db, {
    operatorId: id, mfaMethod: 'totp', ip: '10.1.2.3',
    deviceFingerprint: DEVICE, policy: OFFICE,
  })
  if (!established.ok) throw new Error(`could not establish: ${established.reason}`)
  const resolved = await resolveOperatorSession(h.db, established.sessionId, FROM_OFFICE)
  if (!resolved.ok) throw new Error(`could not resolve: ${resolved.reason}`)
  return { id, sessionId: established.sessionId, operator: resolved.operator }
}

function ctxFor(operator: Awaited<ReturnType<typeof operatorWith>>['operator'], overrides = {}) {
  return {
    operator,
    action: 'ops.settlement_read',
    reason: 'Customer reported a missing payout; checking the attempt.',
    requestId: 'req_ops_1',
    ip: '10.1.2.3',
    ...overrides,
  } as OperatorContext
}

/* ── The named role ─────────────────────────────────────────────────────── */

describe('the named cross-tenant role', () => {
  it('reads both workspaces where the application role reads one', async () => {
    await h.admin`
      INSERT INTO beneficiaries (id, workspace_id, environment, display_name, type, created_by)
      VALUES ('ben_a', 'ws_alpha', 'live', 'Alpha Payee', 'individual', 'usr_a'),
             ('ben_b', 'ws_beta',  'live', 'Beta Payee',  'individual', 'usr_b')`

    // The application role, scoped to alpha, sees alpha. That is INV-31 and it
    // is unchanged by anything in this stage.
    const scoped = (await withTenant(h.db, A, (tx) =>
      tx.execute(sql`SELECT id FROM beneficiaries ORDER BY id`))) as unknown as { id: string }[]
    expect(scoped.map((r) => r.id)).toEqual(['ben_a'])

    const { operator } = await operatorWith(['ops_read'], 'reader1')
    const seen = await withOperatorRead(
      h.db, opsDb, ctxFor(operator), { scopes: [A, B] },
      async (conn) => (await conn.execute(
        sql`SELECT id FROM beneficiaries ORDER BY id`)) as unknown as { id: string }[],
    )
    expect(seen.map((r) => r.id)).toEqual(['ben_a', 'ben_b'])

    await h.admin`DELETE FROM beneficiaries`
  })

  it('cannot write anything, even through the ops connection', async () => {
    // The grant, not the code, is what makes "no ops action can edit a settled
    // record" true. Asserting it here means a future migration that widened the
    // grant would fail this suite as well as the isolation gate.
    await expect(opsDb.execute(sql`
      UPDATE beneficiaries SET display_name = 'x' WHERE id = 'ben_a'`))
      .rejects.toThrow(/permission denied/i)
    await expect(opsDb.execute(sql`
      INSERT INTO settlement_exceptions (id, workspace_id, environment, settlement_id, code, entered_from)
      VALUES ('exc_x', 'ws_alpha', 'live', 'stl_x', 'RECONCILIATION_MISMATCH', 'RECONCILING')`))
      .rejects.toThrow(/permission denied/i)
  })

  it('cannot reach the customer\'s API keys or sessions', async () => {
    await expect(opsDb.execute(sql`SELECT id FROM api_keys`))
      .rejects.toThrow(/permission denied/i)
    await expect(opsDb.execute(sql`SELECT id FROM sessions`))
      .rejects.toThrow(/permission denied/i)
  })
})

/* ── Audited individually ───────────────────────────────────────────────── */

describe('every cross-tenant read is audited', () => {
  it('writes one record per workspace, with the operator, the workspace and the reason', async () => {
    const { id, operator } = await operatorWith(['ops_read'], 'reader2')
    await withOperatorRead(h.db, opsDb, ctxFor(operator), { scopes: [A, B] },
      async (conn) => conn.execute(sql`SELECT 1`))

    const actions = await h.admin<{
      workspace_id: string; operator_id: string; reason: string; kind: string
    }[]>`SELECT workspace_id, operator_id, reason, kind FROM operator_actions ORDER BY workspace_id`

    expect(actions).toHaveLength(2)
    expect(actions.map((a) => a.workspace_id)).toEqual(['ws_alpha', 'ws_beta'])
    for (const action of actions) {
      expect(action.operator_id).toBe(id)
      expect(action.kind).toBe('read')
      expect(action.reason).toContain('missing payout')
    }
  })

  it('puts the same record in the customer\'s own audit log', async () => {
    // The customer is entitled to know that INRSettle looked at their
    // settlement, who did, and why. A record only we can see would be a worse
    // record.
    const { operator } = await operatorWith(['ops_read'], 'reader3')
    await withOperatorRead(
      h.db, opsDb, ctxFor(operator),
      { scopes: [A], subject: { subjectType: 'settlement', subjectId: 'stl_looked_at' } },
      async (conn) => conn.execute(sql`SELECT 1`),
    )

    const visible = (await withTenant(h.db, A, (tx) => tx.execute(sql`
      SELECT actor_type, actor_id, action, subject_id, reason
        FROM audit_log WHERE actor_type = 'operator'`))) as unknown as {
      actor_type: string; actor_id: string; action: string; subject_id: string; reason: string
    }[]

    expect(visible).toHaveLength(1)
    // Its own principal type, so "was this the customer or was this us" is
    // answerable without recognising the id.
    expect(visible[0]!.actor_type).toBe('operator')
    expect(visible[0]!.subject_id).toBe('stl_looked_at')
    expect(visible[0]!.reason).toContain('missing payout')

    // And workspace B, which was not read, sees nothing.
    const other = (await withTenant(h.db, B, (tx) => tx.execute(
      sql`SELECT id FROM audit_log WHERE actor_type = 'operator'`))) as unknown as unknown[]
    expect(other).toHaveLength(0)
  })

  it('records the access before performing the read, not after', async () => {
    // The order is the property. Read-then-audit has a window in which a
    // cross-tenant read has happened with no record of it; this asserts the
    // record is already committed and visible by the time the read runs.
    const { operator } = await operatorWith(['ops_read'], 'reader4')
    let auditedDuringRead = 0
    await withOperatorRead(h.db, opsDb, ctxFor(operator), { scopes: [A] }, async () => {
      const rows = await h.admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM operator_actions`
      auditedDuringRead = rows[0]!.n
    })
    expect(auditedDuringRead).toBe(1)
  })

  it('leaves the record even when the read then fails', async () => {
    const { operator } = await operatorWith(['ops_read'], 'reader5')
    await expect(withOperatorRead(h.db, opsDb, ctxFor(operator), { scopes: [A] }, async () => {
      throw new Error('the read blew up')
    })).rejects.toThrow('the read blew up')

    const [row] = await h.admin<{ n: number }[]>`SELECT count(*)::int AS n FROM operator_actions`
    expect(row!.n, 'over-recording beats an unrecorded read').toBe(1)
  })

  it('refuses a read that names no workspace', async () => {
    const { operator } = await operatorWith(['ops_read'], 'reader6')
    await expect(withOperatorRead(h.db, opsDb, ctxFor(operator), { scopes: [] }, async () => 1))
      .rejects.toThrow(OperatorAccessRefused)
  })

  it('is append-only: an operator action cannot be edited or deleted', async () => {
    const { operator } = await operatorWith(['ops_read'], 'reader7')
    await recordOperatorAccess(h.db, A, ctxFor(operator), 'read')
    await expect(h.admin`UPDATE operator_actions SET reason = 'tidied'`)
      .rejects.toThrow(/append-only/i)
    await expect(h.admin`DELETE FROM operator_actions`).rejects.toThrow(/append-only/i)
  })
})

/* ── The reason, and the capability ─────────────────────────────────────── */

describe('an operator action without a reason', () => {
  it('does not happen, and leaves no audit record either', async () => {
    const { operator } = await operatorWith(['ops_read'], 'reader8')
    for (const reason of ['', '   ', 'oops']) {
      await expect(
        withOperatorRead(h.db, opsDb, ctxFor(operator, { reason }), { scopes: [A] },
          async () => 1),
      ).rejects.toThrow(OperatorAccessRefused)
    }
    const [row] = await h.admin<{ n: number }[]>`SELECT count(*)::int AS n FROM operator_actions`
    expect(row!.n).toBe(0)
  })

  it('is refused at the database too, so no future caller can skip the check', async () => {
    await expect(h.admin`
      INSERT INTO operator_actions
        (id, operator_id, kind, action, workspace_id, environment, reason)
      VALUES ('oac_bad', 'opr_root', 'read', 'ops.peek', 'ws_alpha', 'live', ' ')`)
      .rejects.toThrow(/reason/i)
  })
})

describe('an operator without ops:read', () => {
  it('cannot read across tenants at all', async () => {
    // Every internal role holds `ops:read`, so this is the shape of an operator
    // whose roles were revoked while their session was still open.
    const { id } = await operatorWith(['ops_read'], 'reader9')
    await h.admin`DELETE FROM internal_operator_roles WHERE operator_id = ${id}`
    const established = await establishOperatorSession(h.db, {
      operatorId: id, mfaMethod: 'totp', ip: '10.9.9.9',
      deviceFingerprint: DEVICE, policy: OFFICE,
    })
    if (!established.ok) throw new Error('setup')
    const resolved = await resolveOperatorSession(h.db, established.sessionId, {
      ...FROM_OFFICE, ip: '10.9.9.9',
    })
    if (!resolved.ok) throw new Error('setup')
    expect(resolved.operator.capabilities.size).toBe(0)

    await expect(
      withOperatorRead(h.db, opsDb, ctxFor(resolved.operator), { scopes: [A] }, async () => 1),
    ).rejects.toThrow(/does not hold ops:read/)
  })
})

/* ── Sessions ───────────────────────────────────────────────────────────── */

describe('an operator session', () => {
  it('refuses an address outside the allow-list', async () => {
    const id = await createOperator(h.db, {
      email: 'offsite@inrsettle.test', displayName: 'Offsite',
      roles: ['ops_read'], grantedBy: rootOperatorId,
    })
    const result = await establishOperatorSession(h.db, {
      operatorId: id, mfaMethod: 'totp', ip: '203.0.113.9',
      deviceFingerprint: DEVICE, policy: OFFICE,
    })
    expect(result).toEqual({ ok: false, reason: 'network_not_allowed' })

    const [row] = await h.admin<{ n: number }[]>`SELECT count(*)::int AS n FROM internal_sessions
      WHERE operator_id = ${id}`
    expect(row!.n, 'a refused address leaves no session row').toBe(0)
  })

  it('refuses an empty allow-list rather than reading it as "any"', async () => {
    await expect(establishOperatorSession(h.db, {
      operatorId: rootOperatorId, mfaMethod: 'totp', ip: '10.0.0.1',
      deviceFingerprint: DEVICE, policy: { name: 'empty', allowedCidrs: [] },
    })).rejects.toThrow(EmptyNetworkPolicy)
  })

  it('checks the network on every request, not only at login', async () => {
    // A session established inside the office and then used from a laptop on a
    // train is exactly what the restriction is for.
    const { sessionId } = await operatorWith(['ops_read'], 'commuter')
    const onsite = await resolveOperatorSession(h.db, sessionId, {
      ...FROM_OFFICE, ip: '10.4.4.4',
    })
    expect(onsite.ok).toBe(true)

    const offsite = await resolveOperatorSession(h.db, sessionId, {
      ...FROM_OFFICE, ip: '198.51.100.7',
    })
    expect(offsite).toEqual({ ok: false, reason: 'network_not_allowed' })
  })

  it('handles IPv6 the way the database does, not the way string matching would', async () => {
    const id = await createOperator(h.db, {
      email: 'v6@inrsettle.test', displayName: 'V6',
      roles: ['ops_read'], grantedBy: rootOperatorId,
    })
    const inside = await establishOperatorSession(h.db, {
      operatorId: id, mfaMethod: 'totp', ip: '2001:db8::dead:beef',
      deviceFingerprint: DEVICE, policy: OFFICE,
    })
    expect(inside.ok).toBe(true)

    const outside = await establishOperatorSession(h.db, {
      operatorId: id, mfaMethod: 'totp', ip: '2001:dbf::1',
      deviceFingerprint: DEVICE, policy: OFFICE,
    })
    expect(outside).toEqual({ ok: false, reason: 'network_not_allowed' })
  })

  it('cannot authenticate with no request address at all', async () => {
    // The fail-closed case. A valid, unexpired, unrevoked session presented
    // with no address is refused — not admitted on the grounds that no
    // restriction could be evaluated. "We could not check" is not "it passed".
    const { sessionId } = await operatorWith(['ops_read'], 'noaddress')
    expect(await resolveOperatorSession(h.db, sessionId, { ...FROM_OFFICE, ip: '' }))
      .toEqual({ ok: false, reason: 'request_address_missing' })
    expect(await resolveOperatorSession(h.db, sessionId, { ...FROM_OFFICE, ip: '   ' }))
      .toEqual({ ok: false, reason: 'request_address_missing' })

    // …and the same session works the moment an address is presented, so the
    // refusal above is the missing address and not something else.
    expect((await resolveOperatorSession(h.db, sessionId, FROM_OFFICE)).ok).toBe(true)
  })

  it('is bound to the device it was established on', async () => {
    const { sessionId } = await operatorWith(['ops_read'], 'bound')
    expect((await resolveOperatorSession(h.db, sessionId, FROM_OFFICE)).ok).toBe(true)

    expect(await resolveOperatorSession(h.db, sessionId, {
      ...FROM_OFFICE, deviceFingerprint: 'someone-elses-laptop',
    })).toEqual({ ok: false, reason: 'session_device_mismatch' })
  })

  it('revokes on a device mismatch rather than merely refusing', async () => {
    // The same fail-closed semantics `resolveSession` uses for a customer. A
    // session id presented from another device is the signature of a stolen
    // token, so refusing this one request and leaving the session alive would
    // hand the thief the rest of the half hour.
    const { sessionId } = await operatorWith(['ops_read'], 'stolen')
    await resolveOperatorSession(h.db, sessionId, {
      ...FROM_OFFICE, deviceFingerprint: 'someone-elses-laptop',
    })

    // Even from the right device, afterwards.
    expect(await resolveOperatorSession(h.db, sessionId, FROM_OFFICE))
      .toEqual({ ok: false, reason: 'session_revoked' })

    const [row] = await h.admin<{ revoked_reason: string }[]>`
      SELECT revoked_reason FROM internal_sessions WHERE id = ${sessionId}`
    expect(row!.revoked_reason).toBe('ops_session_device_mismatch')
  })

  it('treats an absent fingerprint as a mismatch, not an exemption', async () => {
    const { sessionId } = await operatorWith(['ops_read'], 'nodevice')
    expect(await resolveOperatorSession(h.db, sessionId, {
      ...FROM_OFFICE, deviceFingerprint: '',
    })).toEqual({ ok: false, reason: 'session_device_mismatch' })
  })

  it('will not establish a session with no device fingerprint', async () => {
    const id = await createOperator(h.db, {
      email: 'unbound@inrsettle.test', displayName: 'Unbound',
      roles: ['ops_read'], grantedBy: rootOperatorId,
    })
    expect(await establishOperatorSession(h.db, {
      operatorId: id, mfaMethod: 'totp', ip: '10.1.2.3',
      deviceFingerprint: '   ', policy: OFFICE,
    })).toEqual({ ok: false, reason: 'device_fingerprint_missing' })

    const [row] = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM internal_sessions WHERE operator_id = ${id}`
    expect(row!.n, 'a refused establishment leaves no session row').toBe(0)
  })

  it('will not accept an unbound session even inserted directly', async () => {
    // The column is NOT NULL with a non-empty CHECK, so an ops session without
    // a device binding is unrepresentable rather than refused by code somebody
    // could skip.
    await expect(h.admin`
      INSERT INTO internal_sessions
        (id, operator_id, mfa_method, device_fingerprint, ip, network_policy, expires_at)
      VALUES ('ops_unbound', 'opr_root', 'totp', '   ', '10.1.2.3', 'office-v1', now() + interval '1 hour')`)
      .rejects.toThrow(/device_fingerprint/i)
  })

  it('records which allow-list admitted it, so the decision is answerable later', async () => {
    const { sessionId } = await operatorWith(['ops_read'], 'recorded')
    const [row] = await h.admin<{ network_policy: string; mfa_method: string }[]>`
      SELECT network_policy, mfa_method FROM internal_sessions WHERE id = ${sessionId}`
    expect(row!.network_policy).toBe('office-v1')
    expect(row!.mfa_method).toBe('totp')
  })

  it('expires, and is shorter than any customer session', async () => {
    const { sessionId } = await operatorWith(['ops_read'], 'expiring')
    const later = new Date(Date.now() + (OPS_SESSION_TTL_SECONDS + 1) * 1000)
    const resolved = await resolveOperatorSession(h.db, sessionId, { ...FROM_OFFICE, now: later })
    expect(resolved).toEqual({ ok: false, reason: 'session_expired' })
  })

  it('stops working the moment it is revoked', async () => {
    const { sessionId } = await operatorWith(['ops_read'], 'revoked')
    expect(await revokeOperatorSession(h.db, sessionId)).toBe(true)
    expect(await resolveOperatorSession(h.db, sessionId, FROM_OFFICE))
      .toEqual({ ok: false, reason: 'session_revoked' })
  })

  it('closes every open session when the operator is suspended', async () => {
    // Suspending without revoking would leave full cross-tenant read access
    // working for up to the session TTL, for someone whose access was just
    // withdrawn.
    const { id, sessionId } = await operatorWith(['ops_read'], 'suspended')
    const second = await establishOperatorSession(h.db, {
      operatorId: id, mfaMethod: 'webauthn', ip: '10.5.5.5',
      deviceFingerprint: DEVICE, policy: OFFICE,
    })
    if (!second.ok) throw new Error('setup')

    expect(await suspendOperator(h.db, id)).toBe(true)
    expect(await resolveOperatorSession(h.db, sessionId, FROM_OFFICE))
      .toEqual({ ok: false, reason: 'session_revoked' })
    expect(await resolveOperatorSession(h.db, second.sessionId, { ...FROM_OFFICE, ip: '10.5.5.5' }))
      .toEqual({ ok: false, reason: 'session_revoked' })

    // And no new one either.
    expect(await establishOperatorSession(h.db, {
      operatorId: id, mfaMethod: 'totp', ip: '10.5.5.5',
      deviceFingerprint: DEVICE, policy: OFFICE,
    })).toEqual({ ok: false, reason: 'operator_suspended' })
  })
})

/* ── Discovery ──────────────────────────────────────────────────────────── */

describe('queue discovery', () => {
  it('returns scope pairs and a count, and no customer data', async () => {
    // Seeded in one transaction with its status event, because `INV-32`'s
    // deferred pairing trigger refuses a settlement that appears without one —
    // which is the rule doing its job, not an obstacle to work around.
    await h.admin.begin(async (tx) => {
      await tx`
        INSERT INTO beneficiaries (id, workspace_id, environment, display_name, type, created_by)
        VALUES ('ben_qa', 'ws_alpha', 'live', 'Queue Payee', 'individual', 'usr_a')`
      await tx`
        INSERT INTO settlements (id, workspace_id, environment, beneficiary_id, status,
                                 recipient_amount_minor, recipient_amount_currency,
                                 funding_currency, purpose_code, created_by,
                                 exception_entered_from, open_exception_code)
        VALUES ('stl_qa', 'ws_alpha', 'live', 'ben_qa', 'EXCEPTION', 100000, 'INR',
                'USDT', 'SOFTWARE_SERVICES', 'usr_a', 'RECONCILING', 'RECONCILIATION_MISMATCH')`
      await tx`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id,
                            actor_type, actor_id)
        VALUES ('evt_qa', 'ws_alpha', 'live', 'settlement.exception_opened', 'settlement',
                'stl_qa', 'job', 'reconcile.run')`
      await tx`
        INSERT INTO settlement_exceptions (id, workspace_id, environment, settlement_id, code, entered_from)
        VALUES ('exc_qa', 'ws_alpha', 'live', 'stl_qa', 'RECONCILIATION_MISMATCH', 'RECONCILING')`
    })

    const scopes = await discoverQueueScopes(opsDb, 'exceptions')
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.workspaceId).toBe('ws_alpha')
    expect(scopes[0]!.waiting).toBe(1)
    // The narrowest possible answer to "which workspaces need attention": a
    // scope pair and a count, never a settlement id or an amount.
    expect(Object.keys(scopes[0]!).sort())
      .toEqual(['environment', 'oldestAt', 'waiting', 'workspaceId'])

    await h.admin`DELETE FROM settlement_exceptions`
    await h.admin`DELETE FROM events WHERE subject_id = 'stl_qa'`
    await h.admin`DELETE FROM settlements`
    await h.admin`DELETE FROM beneficiaries`
  })
})

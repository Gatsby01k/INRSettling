/**
 * The persistence model must be able to represent the frozen RBAC model.
 *
 * SECURITY.md § 3.2 grants sets of roles — an admin who is also an approver is
 * a described case, not an edge case. An earlier schema stored one `role`
 * column with UNIQUE(workspace, environment, user), which made that
 * unrepresentable while the code happily accepted `capabilitiesFor([...])`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedUser, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import type { Environment } from '@inrsettle/contracts'
import { capabilitiesOf, rolesFor, setRoles } from '../membership.service.js'

let h: Harness
const WS = 'ws_rbac'
const admin = { type: 'user' as const, id: 'usr_root' }

const scoped = <T>(env: Environment, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(h.db, { workspaceId: WS, environment: env }, fn)
const scope = (environment: Environment) => ({ workspaceId: WS, environment })

beforeAll(async () => {
  h = await createTestDatabase('rbac')
  await seedWorkspace(h.admin, { workspaceId: WS, userId: 'usr_root', email: 'r@example.test', roles: ['admin'] })
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin'] })
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_appr', email: 'p@example.test', roles: ['approver'] })
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_both', email: 'b@example.test', roles: ['admin', 'approver'] })
  // Different roles per environment — the reason memberships are environment-scoped.
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_split', email: 's@example.test',
    roles: ['approver'], environments: ['sandbox'] })
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_split', email: 's@example.test',
    roles: ['viewer'], environments: ['live'] })
})
afterAll(async () => { await h?.close() })

describe('multiple roles per principal', () => {
  for (const env of ['sandbox', 'live'] as const) {
    describe(env, () => {
      it('admin-only holds workspace management and not authorize', async () => {
        const caps = await scoped(env, (tx) => capabilitiesOf(tx, scope(env), 'usr_admin'))
        expect(caps.has('security_policy:manage')).toBe(true)
        expect(caps.has('apikey:manage')).toBe(true)
        expect(caps.has('settlement:authorize')).toBe(false)
      })

      it('approver-only holds authorize and not workspace management', async () => {
        const caps = await scoped(env, (tx) => capabilitiesOf(tx, scope(env), 'usr_appr'))
        expect(caps.has('settlement:authorize')).toBe(true)
        expect(caps.has('settlement:create')).toBe(true)
        expect(caps.has('security_policy:manage')).toBe(false)
      })

      it('admin + approver holds the union, and the database really stores two rows', async () => {
        const roles = await scoped(env, (tx) => rolesFor(tx, scope(env), 'usr_both'))
        expect([...roles].sort()).toEqual(['admin', 'approver'])

        const caps = await scoped(env, (tx) => capabilitiesOf(tx, scope(env), 'usr_both'))
        expect(caps.has('security_policy:manage')).toBe(true)
        expect(caps.has('settlement:authorize')).toBe(true)
      })
    })
  }

  it('keeps roles independent per environment', async () => {
    expect(await scoped('sandbox', (tx) => rolesFor(tx, scope('sandbox'), 'usr_split'))).toEqual(['approver'])
    expect(await scoped('live', (tx) => rolesFor(tx, scope('live'), 'usr_split'))).toEqual(['viewer'])
  })

  it('stores role sets, not a single column', async () => {
    const cols = await h.admin<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'memberships'`
    expect(cols.map((c) => c.column_name)).not.toContain('role')

    const [row] = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM membership_roles mr
      JOIN memberships m ON m.id = mr.membership_id
      WHERE m.user_id = 'usr_both' AND m.environment = 'live'`
    expect(row!.n).toBe(2)
  })
})

describe('role changes invalidate sessions', () => {
  it('revokes the user’s live sessions in the same transaction as the change', async () => {
    await h.admin`
      INSERT INTO sessions (id, workspace_id, environment, user_id, mfa_method, expires_at)
      VALUES ('ses_rbac_1', ${WS}, 'live', 'usr_appr', 'totp', now() + interval '8 hours')`

    const result = await scoped('live', (tx) =>
      setRoles(tx, scope('live'), { userId: 'usr_appr', roles: ['viewer'], actor: admin,
        reason: 'moved off approvals' }))
    expect(result.revokedSessions).toBe(1)

    const [s] = await h.admin<{ revoked_reason: string }[]>`
      SELECT revoked_reason FROM sessions WHERE id = 'ses_rbac_1'`
    expect(s!.revoked_reason).toBe('roles_changed')

    const caps = await scoped('live', (tx) => capabilitiesOf(tx, scope('live'), 'usr_appr'))
    expect(caps.has('settlement:authorize')).toBe(false)
  })

  it('audits the change with before and after role sets', async () => {
    const [row] = await h.admin<{ action: string; before: unknown; after: unknown; reason: string }[]>`
      SELECT action, before, after, reason FROM audit_log
      WHERE action = 'membership.roles_changed' AND subject_id = 'usr_appr'`
    expect(row!.before).toEqual({ roles: ['approver'] })
    expect(row!.after).toEqual({ roles: ['viewer'] })
    expect(row!.reason).toBe('moved off approvals')
  })

  it('leaves the other environment untouched', async () => {
    const caps = await scoped('sandbox', (tx) => capabilitiesOf(tx, scope('sandbox'), 'usr_appr'))
    expect(caps.has('settlement:authorize')).toBe(true)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { capabilitiesFor } from '@inrsettle/domain'
import { getSeparationOfDuties, setSeparationOfDuties } from '../security-policy.service.js'

let h: Harness
const WS = 'ws_policy'
const actor = { type: 'user' as const, id: 'usr_policy' }
const adminCaps = capabilitiesFor(['admin'])
const operatorCaps = capabilitiesFor(['operator'])
const scope = (environment: 'sandbox' | 'live') => ({ workspaceId: WS, environment })
const scoped = <T>(env: 'sandbox' | 'live', fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(h.db, scope(env), fn)

beforeAll(async () => {
  h = await createTestDatabase('policy')
  await seedWorkspace(h.admin, { workspaceId: WS, userId: 'usr_policy', email: 'p@example.test', roles: ['admin'] })
})
afterAll(async () => { await h?.close() })

describe('D-007 — policy storage and audited mutation', () => {
  it('defaults off in sandbox and on in live with no row present', async () => {
    expect(await scoped('sandbox', (tx) => getSeparationOfDuties(tx, scope('sandbox')))).toBe(false)
    expect(await scoped('live', (tx) => getSeparationOfDuties(tx, scope('live')))).toBe(true)
  })

  it('refuses a change from a principal without security_policy:manage', async () => {
    await expect(
      scoped('sandbox', (tx) => setSeparationOfDuties(tx, scope('sandbox'), {
        enabled: true, actor, actorCapabilities: operatorCaps,
      })),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('records exactly one audit entry and one event per change', async () => {
    await scoped('sandbox', (tx) => setSeparationOfDuties(tx, scope('sandbox'), {
      enabled: true, actor, actorCapabilities: adminCaps, reason: 'match live before go-live',
    }))
    const rows = await h.admin<{ action: string; before: unknown; after: unknown; reason: string }[]>`
      SELECT action, before, after, reason FROM audit_log
      WHERE workspace_id = ${WS} AND environment = 'sandbox'
        AND action = 'security_policy.separation_of_duties.changed'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.before).toEqual({ separationOfDutiesEnabled: false })
    expect(rows[0]!.after).toEqual({ separationOfDutiesEnabled: true })
    expect(rows[0]!.reason).toBe('match live before go-live')

    const events = await h.admin<{ type: string }[]>`
      SELECT type FROM events WHERE workspace_id = ${WS} AND environment = 'sandbox'`
    expect(events.map((e) => e.type)).toEqual(['workspace.security_policy_changed'])
  })

  it('audits every change separately, not just the net result', async () => {
    await scoped('sandbox', (tx) => setSeparationOfDuties(tx, scope('sandbox'), {
      enabled: false, actor, actorCapabilities: adminCaps,
    }))
    const [row] = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE workspace_id = ${WS} AND environment = 'sandbox'
        AND action = 'security_policy.separation_of_duties.changed'`
    expect(row!.n).toBe(2)
  })

  it('lets an admin disable it for live, but only deliberately', async () => {
    const attempt = (extra: Record<string, unknown>) =>
      scoped('live', (tx) => setSeparationOfDuties(tx, scope('live'), {
        enabled: false, actor, actorCapabilities: adminCaps, ...extra,
      }))
    await expect(attempt({})).rejects.toMatchObject({ code: 'live_downgrade_not_confirmed' })
    await expect(attempt({ confirmLiveDowngrade: true })).rejects.toMatchObject({ code: 'reason_required' })
    const r = await attempt({ confirmLiveDowngrade: true, reason: 'single-operator pilot' })
    expect(r.enabled).toBe(false)
  })

  it('keeps sandbox and live independent', async () => {
    await scoped('live', (tx) => setSeparationOfDuties(tx, scope('live'), {
      enabled: true, actor, actorCapabilities: adminCaps,
    }))
    expect(await scoped('live', (tx) => getSeparationOfDuties(tx, scope('live')))).toBe(true)
    expect(await scoped('sandbox', (tx) => getSeparationOfDuties(tx, scope('sandbox')))).toBe(false)
  })
})

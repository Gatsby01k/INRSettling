/**
 * Stage 1 scope includes "auth with mandatory second factor" and "API keys"
 * (IMPLEMENTATION_PLAN.md, Stage 1). Schema alone does not deliver either
 * guarantee — these are the behaviours that do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedUser, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { capabilitiesFor } from '@inrsettle/domain'
import {
  AuthError, establishSession, establishSessionOrThrow, resolveSession,
  resolveSessionOrThrow, revokeSession, verifiedMfaMethods,
} from '../session.service.js'
import {
  ApiKeyError, createApiKey, hashSecret, revokeApiKey, verifyApiKey,
} from '../api-key.service.js'
import { setRoles } from '../membership.service.js'

let h: Harness
const WS = 'ws_auth'
const scope = { workspaceId: WS, environment: 'live' as const }
const sandboxScope = { workspaceId: WS, environment: 'sandbox' as const }
const actor = { type: 'user' as const, id: 'usr_admin' }
const adminCaps = capabilitiesFor(['admin'])
const approverCaps = capabilitiesFor(['approver'])

const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)
const sandbox = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, sandboxScope, fn)

beforeAll(async () => {
  h = await createTestDatabase('auth')
  await seedWorkspace(h.admin, { workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin'] })
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_mfa', email: 'm@example.test', roles: ['approver'] })
  // No verified factor at all.
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_nomfa', email: 'n@example.test',
    roles: ['approver'], verifiedMfa: null })
  // Enrolled but never verified.
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_unverified', email: 'u@example.test',
    roles: ['approver'], verifiedMfa: null })
  await h.admin`
    INSERT INTO user_mfa_methods (id, user_id, method, verified_at)
    VALUES ('mfa_pending', 'usr_unverified', 'totp', NULL)`
  await seedUser(h.admin, { workspaceId: WS, userId: 'usr_outsider', email: 'o@example.test',
    roles: [], environments: [] })
  await h.admin`INSERT INTO users (id, email) VALUES ('usr_outsider2', 'o2@example.test')`
})
afterAll(async () => { await h?.close() })

describe('mandatory second factor — SECURITY.md § 3.1', () => {
  it('refuses a session when the user has no verified factor', async () => {
    await expect(
      live((tx) => establishSession(tx, scope, { userId: 'usr_nomfa', presentedMfaMethod: 'totp' })),
    ).resolves.toMatchObject({ ok: false, code: 'mfa_required' })
  })

  it('refuses when a factor is enrolled but not verified', async () => {
    expect(await live((tx) => verifiedMfaMethods(tx, 'usr_unverified'))).toEqual([])
    await expect(
      live((tx) => establishSession(tx, scope, { userId: 'usr_unverified', presentedMfaMethod: 'totp' })),
    ).resolves.toMatchObject({ ok: false, code: 'mfa_required' })
  })

  it('refuses when no factor is presented, even though one is verified', async () => {
    await expect(
      live((tx) => establishSession(tx, scope, { userId: 'usr_mfa' })),
    ).resolves.toMatchObject({ ok: false, code: 'mfa_required' })
  })

  it('refuses a factor the user did not verify', async () => {
    await expect(
      live((tx) => establishSession(tx, scope, { userId: 'usr_mfa', presentedMfaMethod: 'webauthn' })),
    ).resolves.toMatchObject({ ok: false, code: 'mfa_required' })
  })

  it('refuses someone with no membership in this scope', async () => {
    // Membership is checked before the factor: someone with no access here is
    // told they have no access, not asked for a second factor they cannot use.
    await expect(
      live((tx) => establishSession(tx, scope, { userId: 'usr_outsider2', presentedMfaMethod: 'totp' })),
    ).resolves.toMatchObject({ ok: false, code: 'no_membership' })
  })

  it('establishes a session on a verified factor, and records which one', async () => {
    const s = await live((tx) => establishSessionOrThrow(tx, scope, {
      userId: 'usr_mfa', presentedMfaMethod: 'totp', deviceFingerprint: 'dev-1',
    }))
    expect(s.sessionId).toMatch(/^ses_/)
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now())

    const [row] = await h.admin<{ mfa_method: string; user_id: string }[]>`
      SELECT mfa_method, user_id FROM sessions WHERE id = ${s.sessionId}`
    expect(row!.mfa_method).toBe('totp')
    expect(row!.user_id).toBe('usr_mfa')
  })

  it('gives an admin a shorter session than a non-admin', async () => {
    const a = await live((tx) => establishSessionOrThrow(tx, scope, { userId: 'usr_admin', presentedMfaMethod: 'totp' }))
    const m = await live((tx) => establishSessionOrThrow(tx, scope, { userId: 'usr_mfa', presentedMfaMethod: 'totp' }))
    expect(a.expiresAt.getTime()).toBeLessThan(m.expiresAt.getTime())
  })

  it('audits every refusal with its reason', async () => {
    // The audit row must survive the refusal that produced it: establishSession
    // returns a result rather than throwing, so the transaction commits.
    const rows = await h.admin<{ after: { code: string } }[]>`
      SELECT after FROM audit_log WHERE action = 'session.refused' AND workspace_id = ${WS}`
    expect(rows.length).toBeGreaterThanOrEqual(5)
    expect(rows.every((r) => typeof r.after.code === 'string')).toBe(true)
  })
})

describe('session validation and revocation', () => {
  it('resolves a live session to its principal', async () => {
    const s = await live((tx) => establishSessionOrThrow(tx, scope, { userId: 'usr_mfa', presentedMfaMethod: 'totp' }))
    const p = await live((tx) => resolveSessionOrThrow(tx, scope, s.sessionId))
    expect(p.principal).toEqual({ type: 'user', id: 'usr_mfa' })
  })

  it('refuses a revoked session', async () => {
    const s = await live((tx) => establishSessionOrThrow(tx, scope, { userId: 'usr_mfa', presentedMfaMethod: 'totp' }))
    await live((tx) => revokeSession(tx, scope, s.sessionId, 'signed_out'))
    await expect(live((tx) => resolveSession(tx, scope, s.sessionId)))
      .resolves.toMatchObject({ ok: false, code: 'session_revoked' })
  })

  it('refuses an expired session, evaluated against the server clock', async () => {
    const s = await live((tx) => establishSessionOrThrow(tx, scope, { userId: 'usr_mfa', presentedMfaMethod: 'totp' }))
    const later = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await expect(live((tx) => resolveSession(tx, scope, s.sessionId, { now: later })))
      .resolves.toMatchObject({ ok: false, code: 'session_expired' })
  })

  it('does not resolve a session from the other environment', async () => {
    const s = await live((tx) => establishSessionOrThrow(tx, scope, { userId: 'usr_mfa', presentedMfaMethod: 'totp' }))
    await expect(sandbox((tx) => resolveSession(tx, sandboxScope, s.sessionId)))
      .resolves.toMatchObject({ ok: false, code: 'session_not_found' })
  })

  it('invalidates existing sessions when roles change', async () => {
    const s = await live((tx) => establishSessionOrThrow(tx, scope, { userId: 'usr_mfa', presentedMfaMethod: 'totp' }))
    await live((tx) => resolveSessionOrThrow(tx, scope, s.sessionId))

    await live((tx) => setRoles(tx, scope, { userId: 'usr_mfa', roles: ['viewer'], actor }))

    await expect(live((tx) => resolveSession(tx, scope, s.sessionId)))
      .resolves.toMatchObject({ ok: false, code: 'session_revoked' })
  })
})

describe('sessions are bound to device context — SECURITY.md § 3.1', () => {
  const withDevice = (fp: string) =>
    live((tx) => establishSessionOrThrow(tx, scope, {
      userId: 'usr_mfa', presentedMfaMethod: 'totp', deviceFingerprint: fp,
    }))

  it('records the device context the session was established with', async () => {
    const s = await withDevice('device-alpha')
    const [row] = await h.admin<{ device_fingerprint: string }[]>`
      SELECT device_fingerprint FROM sessions WHERE id = ${s.sessionId}`
    expect(row!.device_fingerprint).toBe('device-alpha')
  })

  it('resolves when the same device context is presented', async () => {
    const s = await withDevice('device-alpha')
    const p = await live((tx) =>
      resolveSessionOrThrow(tx, scope, s.sessionId, { deviceFingerprint: 'device-alpha' }))
    expect(p.principal).toEqual({ type: 'user', id: 'usr_mfa' })
  })

  it('refuses a session replayed from a different device', async () => {
    const s = await withDevice('device-alpha')
    await expect(
      live((tx) => resolveSession(tx, scope, s.sessionId, { deviceFingerprint: 'device-beta' })),
    ).resolves.toMatchObject({ ok: false, code: 'session_device_mismatch' })
  })

  it('refuses when no device context is presented at all', async () => {
    const s = await withDevice('device-alpha')
    await expect(
      live((tx) => resolveSession(tx, scope, s.sessionId)),
    ).resolves.toMatchObject({ ok: false, code: 'session_device_mismatch' })
  })

  it('revokes the session on mismatch rather than merely refusing it', async () => {
    const s = await withDevice('device-alpha')
    await expect(
      live((tx) => resolveSession(tx, scope, s.sessionId, { deviceFingerprint: 'device-beta' })),
    ).resolves.toMatchObject({ ok: false, code: 'session_device_mismatch' })

    const [row] = await h.admin<{ revoked_reason: string }[]>`
      SELECT revoked_reason FROM sessions WHERE id = ${s.sessionId}`
    expect(row!.revoked_reason, 'the revocation was rolled back by the refusal that caused it')
      .toBe('device_mismatch')

    // Even the legitimate device cannot use it again.
    await expect(
      live((tx) => resolveSession(tx, scope, s.sessionId, { deviceFingerprint: 'device-alpha' })),
    ).resolves.toMatchObject({ ok: false, code: 'session_revoked' })
  })

  it('audits the mismatch', async () => {
    const rows = await h.admin<{ action: string }[]>`
      SELECT action FROM audit_log WHERE action = 'session.device_mismatch' AND workspace_id = ${WS}`
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})

describe('API keys — SECURITY.md § 3.3', () => {
  let created: { id: string; plaintext: string }

  it('is shown once, stored only as a hash, and never as plaintext', async () => {
    created = await live((tx) => createApiKey(tx, scope, {
      name: 'ci', scopes: ['settlement:read'], actor, actorCapabilities: adminCaps,
    }))
    expect(created.plaintext.startsWith('sk_live_')).toBe(true)

    const [row] = await h.admin<{ secret_sha256: string; prefix: string }[]>`
      SELECT secret_sha256, prefix FROM api_keys WHERE id = ${created.id}`
    expect(row!.secret_sha256).toBe(hashSecret(created.plaintext))
    expect(row!.secret_sha256).not.toBe(created.plaintext)

    const dump = JSON.stringify(await h.admin`SELECT * FROM api_keys WHERE id = ${created.id}`)
    expect(dump).not.toContain(created.plaintext)
  })

  it('uses the environment-correct prefix', async () => {
    const s = await sandbox((tx) => createApiKey(tx, sandboxScope, {
      name: 'sbx', scopes: [], actor, actorCapabilities: adminCaps,
    }))
    expect(s.plaintext.startsWith('sk_test_')).toBe(true)
  })

  it('refuses creation without apikey:manage', async () => {
    await expect(
      live((tx) => createApiKey(tx, scope, {
        name: 'nope', scopes: [], actor, actorCapabilities: approverCaps,
      })),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('refuses to grant a scope the grantor does not hold', async () => {
    await expect(
      live((tx) => createApiKey(tx, scope, {
        name: 'escalate', scopes: ['settlement:authorize'], actor, actorCapabilities: adminCaps,
      })),
    ).rejects.toMatchObject({ code: 'scope_exceeds_grantor' })
  })

  it('verifies a good key', async () => {
    const v = await live((tx) => verifyApiKey(tx, scope, created.plaintext))
    expect(v.principal).toEqual({ type: 'api_key', id: created.id })
    expect(v.scopes).toContain('settlement:read')
  })

  it('enforces scope on verification', async () => {
    await expect(live((tx) => verifyApiKey(tx, scope, created.plaintext, 'settlement:authorize')))
      .rejects.toMatchObject({ code: 'missing_scope' })
    await expect(live((tx) => verifyApiKey(tx, scope, created.plaintext, 'settlement:read')))
      .resolves.toMatchObject({ keyId: created.id })
  })

  it('treats a wrong-environment key as unknown, not forbidden', async () => {
    await expect(sandbox((tx) => verifyApiKey(tx, sandboxScope, created.plaintext)))
      .rejects.toMatchObject({ code: 'unknown_key' })
  })

  it('rejects a malformed or unknown key', async () => {
    await expect(live((tx) => verifyApiKey(tx, scope, 'not-a-key')))
      .rejects.toMatchObject({ code: 'unknown_key' })
    await expect(live((tx) => verifyApiKey(tx, scope, 'sk_live_totallyfabricated')))
      .rejects.toMatchObject({ code: 'unknown_key' })
  })

  it('stops working the moment it is revoked', async () => {
    await live((tx) => revokeApiKey(tx, scope, {
      keyId: created.id, actor, actorCapabilities: adminCaps, reason: 'rotated',
    }))
    await expect(live((tx) => verifyApiKey(tx, scope, created.plaintext)))
      .rejects.toMatchObject({ code: 'unknown_key' })
  })

  it('refuses revocation without apikey:manage', async () => {
    await expect(
      live((tx) => revokeApiKey(tx, scope, {
        keyId: created.id, actor, actorCapabilities: approverCaps,
      })),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('audits creation and revocation', async () => {
    const rows = await h.admin<{ action: string }[]>`
      SELECT action FROM audit_log WHERE subject_id = ${created.id} ORDER BY created_at`
    expect(rows.map((r) => r.action)).toEqual(['api_key.created', 'api_key.revoked'])
  })
})

void AuthError; void ApiKeyError

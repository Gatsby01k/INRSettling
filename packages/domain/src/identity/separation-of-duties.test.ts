import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEPARATION_OF_DUTIES, denialFor, evaluateSeparationOfDuties,
  HUMAN_APPROVER_REQUIRED_DENIAL, SEPARATION_OF_DUTIES_DENIAL,
} from './separation-of-duties.js'
import { capabilitiesFor, roleHas } from './capabilities.js'
import type { PrincipalRef } from './principal.js'

const user = (id: string) => ({ type: 'user' as const, id })
const key = (id: string) => ({ type: 'api_key' as const, id })
const job = (id: string) => ({ type: 'job' as const, id })
const provider = (id: string) => ({ type: 'provider' as const, id })

const evaluate = (enabled: boolean, createdBy: PrincipalRef, authorizedBy: PrincipalRef) =>
  evaluateSeparationOfDuties({ policy: { enabled }, createdBy, authorizedBy })

describe('D-007 defaults', () => {
  it('is off in sandbox and on in live', () => {
    expect(DEFAULT_SEPARATION_OF_DUTIES.sandbox).toBe(false)
    expect(DEFAULT_SEPARATION_OF_DUTIES.live).toBe(true)
  })
})

describe('D-007 with separation of duties OFF', () => {
  it('lets a human authorize their own settlement', () => {
    expect(evaluate(false, user('u1'), user('u1'))).toEqual({
      allowed: true, reason: 'policy_disabled',
    })
  })

  it('lets an API key authorize — unattended operation lives here', () => {
    expect(evaluate(false, key('k1'), key('k1')).allowed).toBe(true)
    expect(evaluate(false, user('u1'), key('k1')).allowed).toBe(true)
  })
})

describe('D-007 with separation of duties ON', () => {
  it('refuses an API key outright, whoever created the settlement', () => {
    for (const creator of [user('u1'), key('k1'), key('k2')]) {
      const d = evaluate(true, creator, key('k9'))
      expect(d.allowed, `creator ${creator.type}:${creator.id}`).toBe(false)
      expect(d).toMatchObject({ code: 'human_approver_required' })
    }
  })

  it('refuses a job or provider principal too', () => {
    expect(evaluateSeparationOfDuties({
      policy: { enabled: true }, createdBy: user('u1'), authorizedBy: job('sweeper'),
    })).toMatchObject({ allowed: false, code: 'human_approver_required' })

    expect(evaluateSeparationOfDuties({
      policy: { enabled: true }, createdBy: user('u1'), authorizedBy: provider('payout'),
    })).toMatchObject({ allowed: false, code: 'human_approver_required' })
  })

  it('refuses the human who created it', () => {
    const d = evaluate(true, user('u1'), user('u1'))
    expect(d.allowed).toBe(false)
    expect(d).toMatchObject({ code: 'separation_of_duties' })
  })

  it('permits a different human', () => {
    expect(evaluate(true, user('u1'), user('u2'))).toEqual({
      allowed: true, reason: 'distinct_human_principals',
    })
  })

  it('permits a human to authorize an API-created settlement', () => {
    expect(evaluate(true, key('k1'), user('u1'))).toEqual({
      allowed: true, reason: 'distinct_human_principals',
    })
  })

  it('closes the same-human-different-principal loophole', () => {
    // The gap an earlier revision left: create in the UI as user:U, authorize
    // through key:K. Two principals to an identity comparison, one person in
    // reality. Rule 2 refuses every non-human authorizer, so the route is shut
    // regardless of who owns the key.
    const d = evaluate(true, user('u1'), key('k_owned_by_u1'))
    expect(d.allowed).toBe(false)
    expect(d).toMatchObject({ code: 'human_approver_required' })
  })
})

describe('D-007 denial copy', () => {
  it('gives each denial its own four-field message', () => {
    const creator = evaluate(true, user('u1'), user('u1'))
    const apiKey = evaluate(true, user('u1'), key('k1'))
    expect(denialFor(creator)).toBe(SEPARATION_OF_DUTIES_DENIAL)
    expect(denialFor(apiKey)).toBe(HUMAN_APPROVER_REQUIRED_DENIAL)
    expect(denialFor(evaluate(true, user('u1'), user('u2')))).toBeNull()

    for (const copy of [SEPARATION_OF_DUTIES_DENIAL, HUMAN_APPROVER_REQUIRED_DENIAL]) {
      expect(copy.code).toBeTruthy()
      expect(copy.title).toBeTruthy()
      expect(copy.detail).toBeTruthy()
      expect(copy.action).toBeTruthy()
      expect(copy.detail).not.toMatch(/validation failed|invalid/i) // copy-check:allow
    }
  })

  it('points an API caller at the two real routes, not at a workaround', () => {
    expect(HUMAN_APPROVER_REQUIRED_DENIAL.detail).toMatch(/approver/i)
    expect(HUMAN_APPROVER_REQUIRED_DENIAL.detail).toMatch(/separation of duties off/i)
  })
})

describe('RBAC — the policy narrows a capability, it does not replace it', () => {
  it('keeps settlement:authorize on approver only', () => {
    expect(roleHas('approver', 'settlement:authorize')).toBe(true)
    for (const r of ['operator', 'admin', 'developer', 'viewer'] as const) {
      expect(roleHas(r, 'settlement:authorize'), r).toBe(false)
    }
  })

  it('lets an operator create but never authorize', () => {
    const caps = capabilitiesFor(['operator'])
    expect(caps.has('settlement:create')).toBe(true)
    expect(caps.has('settlement:authorize')).toBe(false)
  })

  it('gives someone granted both roles both capabilities', () => {
    const caps = capabilitiesFor(['admin', 'approver'])
    expect(caps.has('security_policy:manage')).toBe(true)
    expect(caps.has('settlement:authorize')).toBe(true)
  })

  it('still requires the capability before the policy is even consulted', () => {
    // The policy can only narrow. A key without settlement:authorize is refused
    // by RBAC before evaluateSeparationOfDuties is reached at all.
    expect(capabilitiesFor(['developer']).has('settlement:authorize')).toBe(false)
  })
})

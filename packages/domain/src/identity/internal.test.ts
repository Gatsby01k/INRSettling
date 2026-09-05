/**
 * The internal role model, as a set of properties rather than a table copied
 * twice.
 *
 * The first of these is the one that matters: `SECURITY.md § 6` says the
 * capability to settle *does not exist for any principal*, and the way that
 * stops being true is somebody adding such a capability at 6pm because
 * a settlement is stuck and a customer is on the phone. This suite is what makes
 * that a failing build instead of a shipped feature.
 */
import { describe, expect, it } from 'vitest'
import { internalRoleSchema, workspaceRoleSchema } from '@inrsettle/contracts'
import { CAPABILITIES } from './capabilities.js'
import {
  INTERNAL_CAPABILITIES, INTERNAL_ROLE_CAPABILITIES, MAX_REASON_LENGTH, MIN_REASON_LENGTH,
  OPS_SESSION_TTL_SECONDS, internalCapabilitiesFor, internalRoleHas, validateReason,
} from './internal.js'
import { SESSION_TTL_SECONDS } from './auth.js'

describe('no principal can settle a settlement', () => {
  it('has no internal capability that names settling, forcing or overriding', () => {
    for (const capability of INTERNAL_CAPABILITIES) {
      expect(capability, `${capability} reads like a settle capability`)
        .not.toMatch(/settle|settled|force|override|mark_paid|mark_as_paid|finali[sz]e/i) // GATE-EXEMPT — the pattern this asserts the absence of
    }
  })

  it('has no customer capability that names settling, forcing or overriding either', () => {
    // The rule is about *any* principal, so asserting it only of the internal
    // list would leave the obvious place to put one — the workspace role model —
    // unguarded. `settlement:authorize` is the customer saying yes to their own
    // instruction; it is not a settle.
    for (const capability of CAPABILITIES) {
      expect(capability, `${capability} reads like a settle capability`)
        .not.toMatch(/settle:|:settle|force|override|mark_paid|finali[sz]e/i)
    }
  })

  it('gives no internal role a capability to edit a settlement at all', () => {
    for (const capabilities of Object.values(INTERNAL_ROLE_CAPABILITIES)) {
      for (const capability of capabilities) {
        expect(capability).not.toMatch(/edit|amend|adjust|write|update/i)
      }
    }
  })
})

describe('internal roles are separate from workspace roles', () => {
  it('shares no name with a workspace role', () => {
    const workspace = new Set(workspaceRoleSchema.options as readonly string[])
    for (const role of internalRoleSchema.options) {
      expect(workspace.has(role), `${role} must not also be a workspace role`).toBe(false)
    }
  })

  it('shares no capability string with the customer capability model', () => {
    // Two vocabularies that cannot be confused for each other. A capability
    // check that was handed the wrong kind of principal fails closed rather
    // than accidentally matching.
    const customer = new Set(CAPABILITIES as readonly string[])
    for (const capability of INTERNAL_CAPABILITIES) {
      expect(customer.has(capability)).toBe(false)
      expect(capability.startsWith('ops:')).toBe(true)
    }
  })
})

describe('the roles themselves', () => {
  it('lets every internal role read, so reading is the floor and not a second grant', () => {
    for (const role of internalRoleSchema.options) {
      expect(internalRoleHas(role, 'ops:read'), `${role} must be able to read`).toBe(true)
    }
  })

  it('keeps resolving, liquidity and administration in different hands', () => {
    expect(internalRoleHas('ops_read', 'ops:exception_resolve')).toBe(false)
    expect(internalRoleHas('ops_liquidity', 'ops:exception_resolve')).toBe(false)
    // The one most likely to be argued about: an administrator grants access;
    // that is not the same as being able to resolve an exception or move a
    // facility limit, and bundling them is how one compromised account becomes
    // every capability.
    expect(internalRoleHas('ops_admin', 'ops:exception_resolve')).toBe(false)
    expect(internalRoleHas('ops_admin', 'ops:liquidity_manage')).toBe(false)
    expect(internalRoleHas('ops_resolve', 'ops:operator_manage')).toBe(false)
  })

  it('unions the capabilities of several roles', () => {
    const both = internalCapabilitiesFor(['ops_resolve', 'ops_liquidity'])
    expect(both.has('ops:exception_resolve')).toBe(true)
    expect(both.has('ops:liquidity_manage')).toBe(true)
    expect(both.has('ops:operator_manage')).toBe(false)
  })

  it('covers every declared capability across the four roles', () => {
    const covered = internalCapabilitiesFor(internalRoleSchema.options)
    for (const capability of INTERNAL_CAPABILITIES) {
      expect(covered.has(capability), `${capability} is held by no role`).toBe(true)
    }
  })
})

describe('the mandatory reason', () => {
  it('refuses absence, emptiness and whitespace alike', () => {
    expect(validateReason(undefined)).toBe('reason_missing')
    expect(validateReason(null)).toBe('reason_missing')
    expect(validateReason('')).toBe('reason_missing')
    expect(validateReason('   \n\t ')).toBe('reason_missing')
  })

  it('refuses something too short to be a reason', () => {
    expect(validateReason('ok')).toBe('reason_too_short')
    expect(validateReason('x'.repeat(MIN_REASON_LENGTH - 1))).toBe('reason_too_short')
  })

  it('accepts a real one', () => {
    expect(validateReason('Provider confirmed the credit by phone; UTR matches.')).toBeNull()
    expect(validateReason('x'.repeat(MIN_REASON_LENGTH))).toBeNull()
  })

  it('refuses one long enough to be a denial-of-service on the audit log', () => {
    expect(validateReason('x'.repeat(MAX_REASON_LENGTH + 1))).toBe('reason_too_long')
    expect(validateReason('x'.repeat(MAX_REASON_LENGTH))).toBeNull()
  })
})

describe('operator sessions', () => {
  it('is shorter than every customer session, which is what § 3.1 says', () => {
    // Asserted against the customer TTLs rather than against a literal, so the
    // relationship survives someone changing either number.
    expect(OPS_SESSION_TTL_SECONDS).toBeLessThan(SESSION_TTL_SECONDS.standard)
    expect(OPS_SESSION_TTL_SECONDS).toBeLessThan(SESSION_TTL_SECONDS.elevated)
  })
})

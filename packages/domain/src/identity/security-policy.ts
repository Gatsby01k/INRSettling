/**
 * Security policy decisions — decision D-007.
 *
 * Pure. Given the current policy, the actor's capabilities and the requested
 * change, decide whether the change is permitted and what must be recorded.
 * Persisting the outcome is the application layer's job.
 */
import type { Environment, PrincipalRef } from '@inrsettle/contracts'
import type { Capability } from './capabilities.js'
import { DEFAULT_SEPARATION_OF_DUTIES } from './separation-of-duties.js'

export type PolicyErrorCode =
  | 'permission_denied'
  | 'reason_required'
  | 'live_downgrade_not_confirmed'

export class PolicyError extends Error {
  constructor(message: string, readonly code: PolicyErrorCode) {
    super(message)
    this.name = 'PolicyError'
  }
}

/** An absent stored value means the environment default, never "off". */
export function resolveSeparationOfDuties(
  stored: boolean | undefined,
  environment: Environment,
): boolean {
  return stored ?? DEFAULT_SEPARATION_OF_DUTIES[environment]
}

export interface PolicyChangeRequest {
  environment: Environment
  current: boolean
  requested: boolean
  actor: PrincipalRef
  actorCapabilities: ReadonlySet<Capability>
  reason?: string | undefined
  /**
   * Turning separation of duties off in live is the one change that widens what
   * a single compromised principal can do, so it takes two deliberate steps.
   */
  confirmLiveDowngrade?: boolean | undefined
}

export interface PolicyChangePlan {
  changed: boolean
  from: boolean
  to: boolean
  auditAction: 'security_policy.separation_of_duties.changed'
  eventType: 'workspace.security_policy_changed'
  reason?: string | undefined
}

/** Throws `PolicyError` if the change is not permitted; otherwise returns the plan. */
export function planSeparationOfDutiesChange(req: PolicyChangeRequest): PolicyChangePlan {
  if (!req.actorCapabilities.has('security_policy:manage')) {
    throw new PolicyError('actor lacks security_policy:manage', 'permission_denied')
  }

  const isLiveDowngrade = req.environment === 'live' && req.current && !req.requested
  if (isLiveDowngrade) {
    if (!req.confirmLiveDowngrade) {
      throw new PolicyError(
        'disabling separation of duties in live must be explicitly confirmed',
        'live_downgrade_not_confirmed',
      )
    }
    if (!req.reason?.trim()) {
      throw new PolicyError(
        'disabling separation of duties in live requires a stated reason',
        'reason_required',
      )
    }
  }

  return {
    changed: req.current !== req.requested,
    from: req.current,
    to: req.requested,
    auditAction: 'security_policy.separation_of_duties.changed',
    eventType: 'workspace.security_policy_changed',
    reason: req.reason,
  }
}

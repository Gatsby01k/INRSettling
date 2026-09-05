/**
 * Session establishment policy — SECURITY.md § 3.1.
 *
 * "Email identity with a second factor that is **mandatory, not optional**, for
 * every user in every workspace. There is no 'remind me later'."
 *
 * Pure: given what is known about the user, decide whether a session may be
 * established and for how long. The application layer supplies the facts and
 * writes the row.
 */
import type { Environment, WorkspaceRole } from '@inrsettle/contracts'

export type MfaMethod = 'totp' | 'webauthn'

export type SessionDenialCode =
  | 'mfa_required'
  | 'no_membership'
  | 'user_disabled'
  | 'workspace_not_active'

export type SessionDecision =
  | { allowed: true; mfaMethod: MfaMethod; ttlSeconds: number }
  | { allowed: false; code: SessionDenialCode; message: string }

/**
 * Ops sessions are shorter than customer sessions, and both are short.
 * An internal role present on the membership shortens the whole session.
 */
export const SESSION_TTL_SECONDS = { standard: 12 * 60 * 60, elevated: 60 * 60 } as const

export interface SessionRequest {
  userDisabled: boolean
  workspaceActive: boolean
  roles: readonly WorkspaceRole[]
  /** Only methods the user has actually verified count. */
  verifiedMfaMethods: readonly MfaMethod[]
  /** The factor presented in this attempt. */
  presentedMfaMethod?: MfaMethod | undefined
  environment: Environment
}

export function evaluateSessionEstablishment(req: SessionRequest): SessionDecision {
  if (req.userDisabled) {
    return { allowed: false, code: 'user_disabled', message: 'This account is disabled.' }
  }
  if (!req.workspaceActive) {
    return {
      allowed: false,
      code: 'workspace_not_active',
      message: 'This workspace is not active.',
    }
  }
  if (req.roles.length === 0) {
    return {
      allowed: false,
      code: 'no_membership',
      message: 'You do not have access to this workspace in this environment.',
    }
  }

  // Mandatory, not optional: no verified factor means no session, whatever the
  // caller presents. A presented factor must itself be one the user verified.
  const presented = req.presentedMfaMethod
  if (!presented || !req.verifiedMfaMethods.includes(presented)) {
    return {
      allowed: false,
      code: 'mfa_required',
      message: 'Set up and verify a second factor before signing in.',
    }
  }

  const elevated = req.roles.includes('admin')
  return {
    allowed: true,
    mfaMethod: presented,
    ttlSeconds: elevated ? SESSION_TTL_SECONDS.elevated : SESSION_TTL_SECONDS.standard,
  }
}

/** A session is usable only while it is unrevoked and unexpired. */
export function isSessionUsable(
  s: { revokedAt: Date | null; expiresAt: Date },
  now: Date,
): boolean {
  return s.revokedAt === null && s.expiresAt.getTime() > now.getTime()
}

/**
 * Changing what someone can do must not wait for their current session to
 * expire, so any role change invalidates that user's sessions in that scope.
 */
export const ROLE_CHANGE_REVOCATION_REASON = 'roles_changed'

/**
 * A session id presented from a device other than the one it was established
 * with is treated as compromised, not as a mistake: the session is revoked
 * rather than merely refused.
 */
export const DEVICE_MISMATCH_REVOCATION_REASON = 'device_mismatch'

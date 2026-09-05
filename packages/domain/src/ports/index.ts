/**
 * Ports.
 *
 * The domain states what it needs from the outside world as interfaces and
 * nothing more. It has no dependency on Drizzle, on `@inrsettle/db`, on a
 * transaction type, or on any framework — `ARCHITECTURE.md § 2` allows the
 * domain database *types* only, and this package takes the stricter line of
 * depending on none of it.
 *
 * Implementations live in `@inrsettle/app`, which owns transactions and I/O.
 */
import type { Environment, PrincipalRef, WorkspaceRole } from '@inrsettle/contracts'

export interface TenantScope {
  workspaceId: string
  environment: Environment
}

export interface SecurityPolicyStore {
  getSeparationOfDuties(scope: TenantScope): Promise<boolean | undefined>
  setSeparationOfDuties(scope: TenantScope, enabled: boolean, actor: PrincipalRef): Promise<void>
}

export interface MembershipStore {
  rolesFor(scope: TenantScope, userId: string): Promise<readonly WorkspaceRole[]>
}

export interface MfaStore {
  verifiedMethodsFor(userId: string): Promise<readonly ('totp' | 'webauthn')[]>
}

export interface EventSink {
  event(scope: TenantScope, e: {
    type: string
    subjectType: string
    subjectId: string
    actor: PrincipalRef
    payload?: Record<string, unknown>
    deliver?: boolean
  }): Promise<void>
  audit(scope: TenantScope, a: {
    actor: PrincipalRef
    action: string
    subjectType: string
    subjectId: string
    before?: unknown
    after?: unknown
    reason?: string
  }): Promise<void>
}

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() }

/**
 * RBAC — SECURITY.md § 3.2.
 *
 * Capabilities are the unit of authorisation. Roles are bundles of them, and
 * nothing in the system checks a role name directly: it checks a capability.
 * That is what lets decision D-007 layer a workspace policy on top without a
 * second role model.
 */
import type { WorkspaceRole } from '@inrsettle/contracts'

export const CAPABILITIES = [
  'settlement:read',
  'settlement:create',
  'settlement:authorize',
  'settlement:cancel',
  'beneficiary:read',
  'beneficiary:write',
  'batch:read',
  'batch:write',
  'workspace:read',
  'workspace:manage',
  'member:manage',
  'security_policy:manage',
  'apikey:manage',
  'webhook:manage',
  'developer:read',
] as const

export type Capability = (typeof CAPABILITIES)[number]

const VIEWER: readonly Capability[] = [
  'settlement:read', 'beneficiary:read', 'batch:read', 'workspace:read',
]

const OPERATOR: readonly Capability[] = [
  ...VIEWER, 'settlement:create', 'settlement:cancel', 'beneficiary:write', 'batch:write',
]

// `approver` is `operator` plus the one capability that moves money.
const APPROVER: readonly Capability[] = [...OPERATOR, 'settlement:authorize']

// `admin` runs the workspace and cannot authorize. Someone who needs both is
// granted both roles deliberately, not by accident of hierarchy.
const ADMIN: readonly Capability[] = [
  ...VIEWER, 'workspace:manage', 'member:manage', 'security_policy:manage',
  'apikey:manage', 'webhook:manage',
]

// `developer` never reads payout destinations beyond their masked form.
const DEVELOPER: readonly Capability[] = [
  ...VIEWER, 'apikey:manage', 'webhook:manage', 'developer:read',
]

export const ROLE_CAPABILITIES: Record<WorkspaceRole, readonly Capability[]> = {
  viewer: VIEWER,
  operator: OPERATOR,
  approver: APPROVER,
  admin: ADMIN,
  developer: DEVELOPER,
}

export function roleHas(role: WorkspaceRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability)
}

export function capabilitiesFor(roles: readonly WorkspaceRole[]): Set<Capability> {
  return new Set(roles.flatMap((r) => [...ROLE_CAPABILITIES[r]]))
}

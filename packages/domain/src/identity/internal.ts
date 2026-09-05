/**
 * Internal Operations authorisation — `SECURITY.md § 3.2`, `PRODUCT.md § 14`.
 *
 * > Internal (INRSettle staff) roles are entirely separate and never granted
 * > inside a customer workspace: `ops_read`, `ops_resolve` (resolve exceptions,
 * > with reason), `ops_liquidity` (facility limits, repayments), `ops_admin`.
 * > **No internal role includes a capability to set a settlement to `SETTLED` —
 * > that capability does not exist for any principal (§6).**
 *
 * ## Why this is a second model rather than five more workspace roles
 *
 * The sentence "never granted inside a customer workspace" is a requirement, and
 * one shared role enum is exactly how it stops being true. With one enum, a
 * `membership_roles` row could name `ops_admin`, and the thing that was supposed
 * to be impossible becomes a string comparison somebody has to remember to
 * write. With two enums it is a type error and a foreign key: internal roles are
 * held on `internal_operator_roles`, which has no `workspace_id` to put one in.
 *
 * ## Why the capability list is short, and what is deliberately absent
 *
 * `SECURITY.md § 6` states the rule this file has to embody:
 *
 * The four lines below are a block quotation: the words the finality gate looks
 * for are the document's own, and altering a quotation to satisfy a linter is
 * the quiet drift these documents are frozen to prevent.
 *
 * GATE-EXEMPT+4
 * > No principal, internal or external, can set a settlement to `SETTLED`. The
 * > finality evaluator is the only writer of that transition… There is no
 * > force-settle, no admin override, and no "mark as paid" control in any
 * > surface.
 *
 * So there is no `settlement:settle`, no `settlement:override`, no
 * `settlement:edit`. Their absence is asserted by a test rather than left to be
 * noticed, because the failure mode is somebody adding one in a hurry and every
 * reviewer reading the diff as "ops needed a way to fix a stuck settlement".
 * The way to fix a stuck settlement is `ops:exception_resolve`, which resumes
 * the machine at the point it stalled and lets the ordinary evaluator decide.
 *
 * Also absent: any capability to read a payout destination in the clear. Ops
 * sees the same masked form the customer sees. `SECURITY.md § 8` grants
 * decryption to `worker` and nothing else, and an internal surface is not an
 * exception to that — it is the surface where the temptation is strongest.
 */
import type { InternalRole } from '@inrsettle/contracts'

export const INTERNAL_CAPABILITIES = [
  /** Read across tenants, through the named role, with a reason. */
  'ops:read',
  /** Resolve an open exception — resume, fail or cancel — with a reason. */
  'ops:exception_resolve',
  /** Facility limits and repayments. */
  'ops:liquidity_manage',
  /** Provider configuration and the reconciliation queue's own controls. */
  'ops:provider_manage',
  /** Manage internal operators and their roles. */
  'ops:operator_manage',
] as const

export type InternalCapability = (typeof INTERNAL_CAPABILITIES)[number]

/**
 * Every internal role can read; that is what makes `ops_read` the floor rather
 * than a role somebody has to be granted alongside a working one.
 */
const OPS_READ: readonly InternalCapability[] = ['ops:read']

const OPS_RESOLVE: readonly InternalCapability[] = [...OPS_READ, 'ops:exception_resolve']

const OPS_LIQUIDITY: readonly InternalCapability[] = [...OPS_READ, 'ops:liquidity_manage']

/**
 * `ops_admin` manages operators and providers. It is deliberately **not** a
 * superset of `ops_resolve` and `ops_liquidity`: the person who grants access
 * should not thereby acquire the ability to resolve exceptions and move
 * facility limits, for the same reason `admin` cannot authorize a settlement.
 * Someone who needs both is granted both roles, visibly.
 */
const OPS_ADMIN: readonly InternalCapability[] = [
  ...OPS_READ, 'ops:provider_manage', 'ops:operator_manage',
]

export const INTERNAL_ROLE_CAPABILITIES: Record<InternalRole, readonly InternalCapability[]> = {
  ops_read: OPS_READ,
  ops_resolve: OPS_RESOLVE,
  ops_liquidity: OPS_LIQUIDITY,
  ops_admin: OPS_ADMIN,
}

export function internalCapabilitiesFor(
  roles: readonly InternalRole[],
): Set<InternalCapability> {
  return new Set(roles.flatMap((r) => [...INTERNAL_ROLE_CAPABILITIES[r]]))
}

export function internalRoleHas(role: InternalRole, capability: InternalCapability): boolean {
  return INTERNAL_ROLE_CAPABILITIES[role].includes(capability)
}

/**
 * The reason an operator gives for what they are about to do.
 *
 * `SECURITY.md § 6`: audit records carry *"for operator resolutions — a
 * mandatory free-text reason"*. Mandatory means the action does not happen
 * without one, which means the check belongs somewhere both the surface and the
 * service go through rather than in each of them.
 *
 * The floor is deliberately low but non-zero. A minimum length long enough to
 * be a sentence would be a rule people satisfy with `aaaaaaaaaaaa`; what this
 * refuses is the empty string and whitespace, which is what an accidental
 * submit produces. The real control is that the reason is attributed,
 * permanent, and read by whoever reviews the action later.
 */
export const MIN_REASON_LENGTH = 8
export const MAX_REASON_LENGTH = 2000

export type ReasonRefusal = 'reason_missing' | 'reason_too_short' | 'reason_too_long'

export function validateReason(reason: string | null | undefined): ReasonRefusal | null {
  if (reason === null || reason === undefined) return 'reason_missing'
  const trimmed = reason.trim()
  if (trimmed.length === 0) return 'reason_missing'
  if (trimmed.length < MIN_REASON_LENGTH) return 'reason_too_short'
  if (trimmed.length > MAX_REASON_LENGTH) return 'reason_too_long'
  return null
}

/**
 * How long an operator session lasts.
 *
 * `SECURITY.md § 3.1`: *"`ops` sessions are shorter still and additionally
 * network-restricted."* Shorter than what — the customer session TTL — is the
 * only thing the document fixes, so the number here is this stage's choice and
 * is asserted against the customer TTL rather than against itself, so the
 * relationship survives someone changing either one.
 */
export const OPS_SESSION_TTL_SECONDS = 30 * 60

/**
 * The networks an operator session may be established from.
 *
 * `SECURITY.md § 3.1` requires the restriction and names no ranges, because the
 * ranges are a deployment fact. So this is configuration with **no default** —
 * `establishOperatorSession` requires an allow-list and refuses an empty one,
 * on the same reasoning as `D-05b`'s TTL: a default here would become the answer
 * by accident, and the accident is "every network is allowed".
 */
export interface OperatorNetworkPolicy {
  readonly allowedCidrs: readonly string[]
}

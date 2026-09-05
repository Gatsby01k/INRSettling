/**
 * Separation of duties — decision D-007.
 *
 * Policy, as decided:
 *   - configurable per workspace, per environment
 *   - sandbox OFF by default, live ON by default
 *   - a workspace admin may explicitly disable it for live
 *   - every policy change is a separate audited security action
 *   - when enabled, the principal that created a thing cannot authorize it,
 *     applied consistently to human and API principals
 *
 * `settlement:authorize` stays the capability. This is a workspace *policy*
 * evaluated on top of RBAC, not a second role model — so the rule below takes a
 * capability decision that has already been made and can only narrow it.
 *
 * Stage 1 scope: the policy, its storage, its audited mutation, and this pure
 * evaluator. Nothing here knows what a settlement is. Stage 3 wires the
 * evaluator to the settlement authorize transition (T08).
 */
import type { Environment } from '@inrsettle/contracts'
import { samePrincipal, type PrincipalRef } from './principal.js'

export const DEFAULT_SEPARATION_OF_DUTIES: Record<Environment, boolean> = {
  sandbox: false,
  live: true,
}

export interface SeparationOfDutiesPolicy {
  workspaceId: string
  environment: Environment
  enabled: boolean
}

export type SeparationDecision =
  | { allowed: true; reason: 'policy_disabled' | 'distinct_human_principals' }
  | { allowed: false; reason: 'creator_cannot_authorize'; code: 'separation_of_duties' }
  | { allowed: false; reason: 'authorizer_is_not_human'; code: 'human_approver_required' }

/**
 * Pure. Takes the two principals and the policy, returns a decision that
 * explains itself. Never consults the database, never mutates.
 *
 * The rules, in the order they are applied:
 *
 *   1. Policy OFF — anyone holding `settlement:authorize` may authorize,
 *      including an API key. Unattended operation lives here, behind the
 *      explicit live downgrade, rather than behind a workaround.
 *   2. Policy ON — **only a human may authorize.** An API key, a job or a
 *      provider is refused outright, whoever created the settlement.
 *   3. Policy ON — a human may not authorize what they themselves created.
 *
 * Rule 2 is what closes the gap an earlier revision left open. Comparing
 * principal identity alone let a human create in the UI as `user:U` and
 * authorize through a key as `api_key:K` — two distinct principals to the
 * check, one person in reality. Separation of duties is about people, so when
 * it is on, the approving principal must be a person.
 */
export function evaluateSeparationOfDuties(args: {
  policy: Pick<SeparationOfDutiesPolicy, 'enabled'>
  createdBy: PrincipalRef
  authorizedBy: PrincipalRef
}): SeparationDecision {
  if (!args.policy.enabled) return { allowed: true, reason: 'policy_disabled' }

  if (args.authorizedBy.type !== 'user') {
    return { allowed: false, reason: 'authorizer_is_not_human', code: 'human_approver_required' }
  }

  if (samePrincipal(args.createdBy, args.authorizedBy)) {
    return { allowed: false, reason: 'creator_cannot_authorize', code: 'separation_of_duties' }
  }

  return { allowed: true, reason: 'distinct_human_principals' }
}

/** Customer-facing copy, held to the four-field rule in PRODUCT.md § 7.1. */
export const SEPARATION_OF_DUTIES_DENIAL = {
  code: 'separation_of_duties',
  title: 'Someone else needs to approve this',
  detail:
    'This workspace requires that the person who created a settlement is not the person who approves it. Ask another approver to review it.',
  action: { type: 'request_approval' as const },
} as const

export const HUMAN_APPROVER_REQUIRED_DENIAL = {
  code: 'human_approver_required',
  title: 'A person needs to approve this',
  detail:
    'While separation of duties is on, settlements are approved by a person rather than by an API key. An approver can review it in INRSettle, or an admin can turn separation of duties off for this environment.',
  action: { type: 'request_approval' as const },
} as const

export function denialFor(decision: SeparationDecision) {
  if (decision.allowed) return null
  return decision.code === 'separation_of_duties'
    ? SEPARATION_OF_DUTIES_DENIAL
    : HUMAN_APPROVER_REQUIRED_DENIAL
}

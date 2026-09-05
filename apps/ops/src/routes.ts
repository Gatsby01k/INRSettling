/**
 * The Internal Operations route table — `PRODUCT.md § 14`.
 *
 * A table rather than a switch, for the same reasons the public API's is, plus
 * one that only applies here: **`reason`**.
 *
 * `SECURITY.md § 6` requires a mandatory free-text reason on operator actions.
 * "Mandatory" is only true if something enforces it, and the honest place for
 * that is the pipeline rather than each handler — a handler that forgot would
 * be an unaudited operator action, which is the failure the requirement exists
 * to prevent. So every route declares whether it needs one, and the pipeline
 * refuses the request before the handler runs.
 *
 * Every route requires a reason. That is not an oversight in the table design:
 * a cross-tenant read is an action, `§ 2` requires each one to be recorded
 * *"with the operator, the workspace and the reason"*, and a read with no reason
 * is precisely the row that would make the audit log useless. `reason: false`
 * exists as a possibility so that a future route which genuinely touches no
 * customer data — a health check, the operator's own profile — can say so
 * visibly rather than by being forgotten.
 *
 * ## What is not in this table
 *
 * There is no route that settles a settlement, marks one paid, adjusts an
 * amount, edits a beneficiary, or reads a payout account number. `SECURITY.md
 * § 6` forbids the first three for every principal and `§ 8` the last, and a
 * test walks this table asserting their absence — because the way that rule
 * stops being true is somebody adding a route at 6pm with a customer on the
 * phone, and a reviewer reading the diff as "ops needed a way to fix a stuck
 * settlement".
 */
import type { InternalCapability } from '@inrsettle/domain'

export interface OpsRouteDefinition {
  readonly method: 'GET' | 'POST'
  /** `/ops/settlements/:id` — `:name` captures one path segment. */
  readonly pattern: string
  readonly name: string
  readonly capability: InternalCapability
  /** Whether this route needs a mandatory reason. See the header. */
  readonly reason: boolean
  /**
   * Whether this route reaches customer data across tenants. Routes that do
   * pass through `withOperatorRead`, which audits every workspace touched
   * before the read happens.
   */
  readonly crossTenant: boolean
}

export const OPS_ROUTES: readonly OpsRouteDefinition[] = [
  /* ── Queues — where an operator starts ──────────────────────────────── */
  { method: 'GET', pattern: '/ops/queues/:queue', name: 'queues.discover',
    capability: 'ops:read', reason: true, crossTenant: true },

  /* ── Settlements ────────────────────────────────────────────────────── */
  { method: 'GET', pattern: '/ops/settlements/:id', name: 'settlements.get',
    capability: 'ops:read', reason: true, crossTenant: true },
  { method: 'GET', pattern: '/ops/settlements/:id/audit', name: 'settlements.audit',
    capability: 'ops:read', reason: true, crossTenant: true },

  /* ── Exceptions ─────────────────────────────────────────────────────── */
  { method: 'GET', pattern: '/ops/exceptions', name: 'exceptions.list',
    capability: 'ops:read', reason: true, crossTenant: true },
  { method: 'POST', pattern: '/ops/exceptions/:settlementId/resolve', name: 'exceptions.resolve',
    capability: 'ops:exception_resolve', reason: true, crossTenant: true },

  /* ── Liquidity ──────────────────────────────────────────────────────── */
  { method: 'GET', pattern: '/ops/facilities', name: 'facilities.list',
    capability: 'ops:read', reason: true, crossTenant: true },
  { method: 'GET', pattern: '/ops/facilities/movements', name: 'facilities.movements',
    capability: 'ops:read', reason: true, crossTenant: true },
  { method: 'POST', pattern: '/ops/facilities/:id/limit', name: 'facilities.set_limit',
    capability: 'ops:liquidity_manage', reason: true, crossTenant: true },
  { method: 'POST', pattern: '/ops/facilities/:id/status', name: 'facilities.set_status',
    capability: 'ops:liquidity_manage', reason: true, crossTenant: true },
  { method: 'POST', pattern: '/ops/repayments/:id/advance', name: 'repayments.advance',
    capability: 'ops:liquidity_manage', reason: true, crossTenant: true },

  /* ── Reconciliation and providers ───────────────────────────────────── */
  { method: 'GET', pattern: '/ops/reconciliations', name: 'reconciliations.list',
    capability: 'ops:read', reason: true, crossTenant: true },
  { method: 'GET', pattern: '/ops/provider_events', name: 'provider_events.list',
    capability: 'ops:read', reason: true, crossTenant: true },

  /* ── The audit log ──────────────────────────────────────────────────── */
  { method: 'GET', pattern: '/ops/audit', name: 'audit.list',
    capability: 'ops:read', reason: true, crossTenant: true },

  /* ── Ourselves ──────────────────────────────────────────────────────── */
  /*
   * The two routes that touch no customer data.
   *
   * `me` is the operator's own session; `operators.history` is our record of
   * what one of us did. Neither is a cross-tenant read of a tenant's data, so
   * neither needs a reason to look — and saying that here, in the same table,
   * is what stops "this one does not need a reason" from becoming a habit.
   */
  { method: 'GET', pattern: '/ops/me', name: 'me.get',
    capability: 'ops:read', reason: false, crossTenant: false },
  { method: 'GET', pattern: '/ops/operators/:id/history', name: 'operators.history',
    capability: 'ops:operator_manage', reason: false, crossTenant: false },
]

/* ── Matching ───────────────────────────────────────────────────────────── */

export interface MatchedOpsRoute {
  readonly route: OpsRouteDefinition
  readonly params: Readonly<Record<string, string>>
}

export function matchOpsRoute(method: string, path: string): MatchedOpsRoute | null {
  const segments = path.split('/').filter((s) => s.length > 0)
  for (const route of OPS_ROUTES) {
    if (route.method !== method) continue
    const pattern = route.pattern.split('/').filter((s) => s.length > 0)
    if (pattern.length !== segments.length) continue

    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < pattern.length; i += 1) {
      const p = pattern[i]!
      const s = segments[i]!
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(s)
      } else if (p !== s) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return null
}

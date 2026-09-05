/**
 * The route table — `API_CONTRACT.md § 8`, in the order the document lists them.
 *
 * A table rather than a switch, for three reasons that each earn their keep:
 *
 * - **`scope`** is declared beside the route, so "which capability does this
 *   need" is answerable by reading one file rather than by trusting that every
 *   handler remembered. A route with no scope is a deliberate, visible choice.
 * - **`idempotency: 'required'`** is where `§ 4`'s *"Required on `POST
 *   /v1/settlements` and `POST /v1/settlements/{id}/authorize`"* lives, so the
 *   requirement is enforced by the pipeline instead of by each handler.
 * - A test can walk this table and assert that **every route in `§ 8` exists**
 *   and that nothing exists which `§ 8` does not list — including the thing the
 *   document is most emphatic about: *"There is deliberately no endpoint to set
 *   a status, mark a settlement paid, or adjust an amount."*
 */
import type { Capability } from '@inrsettle/domain'

export type IdempotencyRequirement =
  | 'required'
  | 'accepted'
  | 'none'
  /**
   * The route writes its own claim, because its operation is not one
   * transaction. `POST /v1/batches` is the only one: `INV-30` gives every row
   * its own transaction, so there is nothing for the pipeline to wrap. The
   * claim rides with the batch container instead.
   */
  | 'route_managed'

export interface RouteDefinition {
  readonly method: 'GET' | 'POST' | 'DELETE'
  /** `/v1/settlements/:id/authorize` — `:name` captures one path segment. */
  readonly pattern: string
  readonly name: string
  readonly scope: Capability | null
  readonly idempotency: IdempotencyRequirement
  /** Which path parameter names the object a claim is about, if any. */
  readonly subjectParam?: string
}

export const ROUTES: readonly RouteDefinition[] = [
  { method: 'POST', pattern: '/v1/beneficiaries', name: 'beneficiaries.create',
    scope: 'beneficiary:write', idempotency: 'accepted' },
  { method: 'GET', pattern: '/v1/beneficiaries', name: 'beneficiaries.list',
    scope: 'beneficiary:read', idempotency: 'none' },
  { method: 'GET', pattern: '/v1/beneficiaries/:id', name: 'beneficiaries.get',
    scope: 'beneficiary:read', idempotency: 'none' },
  { method: 'POST', pattern: '/v1/beneficiaries/:id/verify', name: 'beneficiaries.verify',
    scope: 'beneficiary:write', idempotency: 'accepted', subjectParam: 'id' },
  { method: 'POST', pattern: '/v1/beneficiaries/:id/disable', name: 'beneficiaries.disable',
    scope: 'beneficiary:write', idempotency: 'accepted', subjectParam: 'id' },

  { method: 'POST', pattern: '/v1/quotes', name: 'quotes.create',
    scope: 'settlement:create', idempotency: 'accepted' },
  { method: 'GET', pattern: '/v1/quotes/:id', name: 'quotes.get',
    scope: 'settlement:read', idempotency: 'none' },

  { method: 'POST', pattern: '/v1/settlements', name: 'settlements.create',
    scope: 'settlement:create', idempotency: 'required' },
  { method: 'GET', pattern: '/v1/settlements', name: 'settlements.list',
    scope: 'settlement:read', idempotency: 'none' },
  { method: 'GET', pattern: '/v1/settlements/:id', name: 'settlements.get',
    scope: 'settlement:read', idempotency: 'none' },
  { method: 'POST', pattern: '/v1/settlements/:id/authorize', name: 'settlements.authorize',
    scope: 'settlement:authorize', idempotency: 'required', subjectParam: 'id' },
  { method: 'POST', pattern: '/v1/settlements/:id/cancel', name: 'settlements.cancel',
    scope: 'settlement:cancel', idempotency: 'accepted', subjectParam: 'id' },
  { method: 'GET', pattern: '/v1/settlements/:id/receipt', name: 'settlements.receipt',
    scope: 'settlement:read', idempotency: 'none' },
  { method: 'GET', pattern: '/v1/settlements/:id/returns', name: 'settlements.returns',
    scope: 'settlement:read', idempotency: 'none' },
  { method: 'GET', pattern: '/v1/settlements/:id/receipt/composite',
    name: 'settlements.receipt.composite', scope: 'settlement:read', idempotency: 'none' },

  { method: 'POST', pattern: '/v1/batches', name: 'batches.create',
    scope: 'batch:write', idempotency: 'route_managed' },
  { method: 'GET', pattern: '/v1/batches/:id', name: 'batches.get',
    scope: 'batch:read', idempotency: 'none' },
  { method: 'GET', pattern: '/v1/batches/:id/settlements', name: 'batches.settlements',
    scope: 'batch:read', idempotency: 'none' },

  { method: 'GET', pattern: '/v1/events', name: 'events.list',
    scope: 'developer:read', idempotency: 'none' },
  { method: 'GET', pattern: '/v1/events/:id', name: 'events.get',
    scope: 'developer:read', idempotency: 'none' },

  { method: 'POST', pattern: '/v1/webhook_endpoints', name: 'webhook_endpoints.create',
    scope: 'webhook:manage', idempotency: 'accepted' },
  { method: 'GET', pattern: '/v1/webhook_endpoints/:id', name: 'webhook_endpoints.get',
    scope: 'webhook:manage', idempotency: 'none' },
  { method: 'DELETE', pattern: '/v1/webhook_endpoints/:id', name: 'webhook_endpoints.delete',
    scope: 'webhook:manage', idempotency: 'none' },
  { method: 'POST', pattern: '/v1/webhook_endpoints/:id/test', name: 'webhook_endpoints.test',
    scope: 'webhook:manage', idempotency: 'accepted', subjectParam: 'id' },
]

export interface RouteMatch {
  readonly route: RouteDefinition
  readonly params: Readonly<Record<string, string>>
}

/**
 * Match a concrete path against the table.
 *
 * `methodMismatch` is distinguished from "no such route" so a `DELETE` to a
 * path that only accepts `GET` can say so, rather than claiming the object does
 * not exist — which would be both unhelpful and, given `§ 3.3`, a confusing
 * echo of the deliberate `404` a wrong-environment key gets.
 */
export function matchRoute(
  method: string, path: string,
): RouteMatch | { readonly methodMismatch: readonly string[] } | null {
  const segments = path.split('/').filter((s) => s.length > 0)
  const pathMatches: RouteDefinition[] = []

  for (const route of ROUTES) {
    const patternSegments = route.pattern.split('/').filter((s) => s.length > 0)
    if (patternSegments.length !== segments.length) continue

    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < patternSegments.length; i += 1) {
      const p = patternSegments[i]!
      const s = segments[i]!
      if (p.startsWith(':')) {
        params[p.slice(1)] = s
      } else if (p !== s) {
        matched = false
        break
      }
    }
    if (!matched) continue
    pathMatches.push(route)
    if (route.method === method.toUpperCase()) return { route, params }
  }

  if (pathMatches.length === 0) return null
  return { methodMismatch: pathMatches.map((r) => r.method) }
}

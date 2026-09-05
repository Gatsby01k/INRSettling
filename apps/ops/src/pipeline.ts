/**
 * The Internal Operations request pipeline.
 *
 * `ARCHITECTURE.md` puts `ops` on its own deployment; `apps/ops/src/README.md`
 * says why: *"Sharing a process with the customer surface is how an internal
 * control leaks into a customer session."* So this is a separate pipeline from
 * `apps/api`'s, with a different authentication model and a different set of
 * rules, and it deliberately shares no code with it.
 *
 * The order, and what each step is for:
 *
 *   1. **Session.** An operator session, not an API key. There is no bearer
 *      token authentication here at all — an internal surface that could be
 *      driven by a long-lived credential is one that can be driven by a leaked
 *      one.
 *   2. **Network and device.** Both re-checked on every request, not once at
 *      login (`SECURITY.md § 3.1`). A session established in the office and used
 *      from elsewhere is exactly what the restriction is for, and a session id
 *      replayed from another machine is what the device binding is for. A
 *      request with no address, or no fingerprint, is refused rather than
 *      exempted — the absence of evidence is not evidence of authorisation.
 *   3. **Route.** Unknown path is `404`, before any capability is considered.
 *   4. **Capability.** From the route table, so "which role does this need" is
 *      answerable by reading one file.
 *   5. **Reason.** From the route table, refused before the handler runs.
 *      `SECURITY.md § 6` says mandatory; this is where mandatory happens.
 *   6. **Handle**, with the cross-tenant read wrapped so every workspace it
 *      touches is recorded first.
 *
 * A refusal at 4 or 5 is a `403` with a code an operator can act on, and it is
 * itself worth noticing: an operator repeatedly hitting `insufficient_capability`
 * is a signal, and the request log this returns to is where it shows up.
 */
import type { Db } from '@inrsettle/db'
import {
  OperatorAccessRefused,
  resolveOperatorSession,
  type ActiveOperator,
  type NetworkPolicy,
  type OperatorContext,
} from '@inrsettle/app-services'
import { validateReason } from '@inrsettle/domain'
import { json, type OpsRequest, type OpsResponse } from './http.js'
import { matchOpsRoute, type OpsRouteDefinition } from './routes.js'
import { handleOpsRoute } from './handlers/index.js'

export interface OpsDeps {
  /** The application pool — every write, and every audit record. */
  readonly appDb: Db
  /** The named cross-tenant read role. SELECT-only, by grant. */
  readonly opsDb: Db
  /** No default. `SECURITY.md § 3.1` requires the restriction; the ranges are deployment. */
  readonly networkPolicy: NetworkPolicy
  readonly now?: () => Date
  readonly onUnexpectedError?: (error: unknown, requestId: string) => void
}

export interface OpsHandlerContext {
  readonly deps: OpsDeps
  readonly operator: ActiveOperator
  readonly ctx: OperatorContext
  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
  readonly body: unknown
  readonly route: OpsRouteDefinition
}

const SESSION_HEADER = 'x-ops-session'
const REASON_HEADER = 'x-ops-reason'
const DEVICE_HEADER = 'x-ops-device'

/**
 * The reason travels in a header rather than in the body.
 *
 * Because a `GET` has no body, and the reason is required on reads — which are
 * most of this surface. Putting it in the body for writes and a header for
 * reads would give the same requirement two shapes and two places to forget it.
 */
export async function handleOps(req: OpsRequest, deps: OpsDeps): Promise<OpsResponse> {
  const requestId = req.headers?.['x-request-id'] ?? `req_ops_${Date.now().toString(36)}`
  const started = Date.now()

  try {
    /* 1 & 2 — who, and from where. */
    const sessionId = req.headers?.[SESSION_HEADER]
    if (sessionId === undefined || sessionId === '') {
      return refuse(401, 'missing_session', 'This request carried no operator session.', requestId)
    }

    /*
     * The address is required by the type, and re-checked here for the one
     * shape a type cannot refuse: an empty string from a deployment whose proxy
     * did not set the header. Reading that as "no restriction applies" is the
     * failure the restriction exists to prevent, so it is a refusal.
     *
     * The device fingerprint is presented the same way and treated the same
     * way. An ops session is bound to a device (`SECURITY.md § 3.1`), so a
     * request that presents none cannot match and is refused rather than
     * exempted.
     */
    if (req.ip.trim().length === 0) {
      return refuse(
        401, 'request_address_missing',
        'This operator session cannot be used.', requestId,
      )
    }

    const resolved = await resolveOperatorSession(deps.appDb, sessionId, {
      ip: req.ip,
      deviceFingerprint: req.headers?.[DEVICE_HEADER] ?? '',
      policy: deps.networkPolicy,
      ...(deps.now ? { now: deps.now() } : {}),
    })
    if (!resolved.ok) {
      // Every refusal here is 401 rather than 403, including
      // `network_not_allowed` and `session_device_mismatch`: from the caller's
      // side they are all "this session is not usable", and distinguishing them
      // would tell someone probing from outside the allow-list, or from another
      // device, that the session id was valid.
      return refuse(401, resolved.reason, 'This operator session cannot be used.', requestId)
    }

    /* 3 — where to. */
    const matched = matchOpsRoute(req.method, req.path)
    if (!matched) {
      return refuse(404, 'not_found', 'No such Internal Operations route.', requestId)
    }
    const { route, params } = matched

    /* 4 — may they. */
    if (!resolved.operator.capabilities.has(route.capability)) {
      return refuse(
        403, 'insufficient_capability',
        `This action needs ${route.capability}.`, requestId,
      )
    }

    /* 5 — why. */
    const reason = req.headers?.[REASON_HEADER] ?? ''
    if (route.reason) {
      const bad = validateReason(reason)
      if (bad !== null) {
        return refuse(
          403, bad,
          'Internal Operations records why every action was taken. Give a reason.',
          requestId,
        )
      }
    }

    let body: unknown
    if (req.rawBody !== undefined && req.rawBody !== '') {
      try {
        body = JSON.parse(req.rawBody)
      } catch {
        return refuse(400, 'invalid_json', 'The request body is not valid JSON.', requestId)
      }
    }

    const ctx: OperatorContext = {
      operator: resolved.operator,
      action: `ops.${route.name}`,
      reason,
      requestId,
      ip: req.ip,
      ...(req.headers?.['user-agent'] === undefined
        ? {}
        : { userAgent: req.headers['user-agent'] }),
    }

    /* 6 — do it. */
    const response = await handleOpsRoute({
      deps, operator: resolved.operator, ctx, params,
      query: req.query ?? {}, body, route,
    })
    return withTiming(response, requestId, started)
  } catch (error) {
    // A refusal thrown from inside a service — a capability or reason check a
    // handler reached directly — is a 403 rather than a 500. The pipeline
    // checks both already; this is the belt to that pair of braces.
    if (error instanceof OperatorAccessRefused) {
      return refuse(403, error.refusal.reason, error.message, requestId)
    }
    deps.onUnexpectedError?.(error, requestId)
    return refuse(
      500, 'internal_error',
      'This request failed inside INRSettle. It is our fault, not yours.', requestId,
    )
  }
}

function refuse(
  status: number, code: string, message: string, requestId: string,
): OpsResponse {
  return json(status, { error: { code, message, request_id: requestId } }, {
    'X-Request-Id': requestId,
  })
}

function withTiming(response: OpsResponse, requestId: string, started: number): OpsResponse {
  return {
    ...response,
    headers: {
      ...response.headers,
      'X-Request-Id': requestId,
      'X-Duration-Ms': String(Date.now() - started),
    },
  }
}

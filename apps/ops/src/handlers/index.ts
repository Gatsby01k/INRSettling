/**
 * The Internal Operations handlers.
 *
 * One file, because there are fourteen of them and each is a few lines: the
 * services in `packages/app/src/ops` hold the rules, and a handler's whole job
 * is to turn path parameters into a call and a result into a response. Spreading
 * that across seven files would make the surface look larger than it is.
 *
 * Every cross-tenant handler goes through `withOperatorRead`, which records who
 * is reading, which workspaces, and why — **before** the read happens. A handler
 * that reached for `opsDb` directly would bypass that, so none of them does, and
 * a test asserts that every route in the table produces an audit record.
 */
import {
  advanceRepaymentAsOperator,
  discoverQueueScopes,
  opsAuditLog,
  opsExceptionQueue,
  opsFacilities,
  opsFacilityMovements,
  opsOperatorHistory,
  opsProviderEvents,
  opsReconciliationQueue,
  opsSettlement,
  resolveExceptionAsOperator,
  setFacilityLimit,
  setFacilityStatus,
  type OpsQueue,
  type OpsScoped,
} from '@inrsettle/app-services'
import { withOperatorRead } from '@inrsettle/app-services'
import type { TenantScope } from '@inrsettle/db'
import { money, type CurrencyCode } from '@inrsettle/money'
import { intParam, json, opsList, type OpsResponse } from '../http.js'
import type { OpsHandlerContext } from '../pipeline.js'

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100

/* ── Scope selection ────────────────────────────────────────────────────── */

/**
 * Which workspaces this request is about.
 *
 * Either named explicitly — `?workspace_id=…&environment=…`, the shape a detail
 * view uses — or discovered from a queue. Both end up as an explicit list
 * before any customer data is read, because `withOperatorRead` audits the list
 * and will not read without one.
 */
function explicitScopes(query: Readonly<Record<string, string>>): readonly TenantScope[] {
  const workspaceId = query['workspace_id']
  const environment = query['environment']
  if (workspaceId === undefined || workspaceId === '') return []
  if (environment !== 'sandbox' && environment !== 'live') return []
  return [{ workspaceId, environment }]
}

function needsScope(): OpsResponse {
  return json(400, {
    error: {
      code: 'workspace_required',
      message:
        'Name the workspace and environment this is about. A cross-tenant read ' +
        'is recorded against the workspaces it touches, so it has to know them.',
    },
  })
}

const asOpsScoped = (scopes: readonly TenantScope[]): readonly OpsScoped[] => scopes

/* ── The dispatcher ─────────────────────────────────────────────────────── */

export async function handleOpsRoute(h: OpsHandlerContext): Promise<OpsResponse> {
  switch (h.route.name) {
    case 'queues.discover': return discoverQueue(h)
    case 'settlements.get': return getSettlement(h)
    case 'settlements.audit': return settlementAudit(h)
    case 'exceptions.list': return listExceptions(h)
    case 'exceptions.resolve': return resolveOne(h)
    case 'facilities.list': return listFacilities(h)
    case 'facilities.movements': return listMovements(h)
    case 'facilities.set_limit': return setLimit(h)
    case 'facilities.set_status': return setStatus(h)
    case 'repayments.advance': return advanceOne(h)
    case 'reconciliations.list': return listReconciliations(h)
    case 'provider_events.list': return listProviderEvents(h)
    case 'audit.list': return listAudit(h)
    case 'me.get': return me(h)
    case 'operators.history': return operatorHistory(h)
    default:
      // Unreachable: the route table and this switch are asserted equal by a
      // test, so a route added without a handler fails the build rather than
      // 500ing in production.
      return json(500, { error: { code: 'no_handler', message: h.route.name } })
  }
}

/* ── Queues ─────────────────────────────────────────────────────────────── */

const QUEUES = new Set<OpsQueue>(['exceptions', 'reconciliation', 'returns', 'drawdowns'])

async function discoverQueue(h: OpsHandlerContext): Promise<OpsResponse> {
  const queue = h.params['queue'] as OpsQueue
  if (!QUEUES.has(queue)) {
    return json(404, { error: { code: 'unknown_queue', message: `No queue named ${queue}.` } })
  }

  // Discovery returns scope pairs and a count — no settlement id, no amount, no
  // customer name. Every workspace it names is then audited by the read that
  // follows, before any of its content is read.
  const scopes = await discoverQueueScopes(h.deps.opsDb, queue)
  return json(200, opsList(scopes.map((s) => ({
    workspace_id: s.workspaceId,
    environment: s.environment,
    waiting: s.waiting,
    oldest_at: s.oldestAt.toISOString(),
  })), scopes.length))
}

/* ── Settlements ────────────────────────────────────────────────────────── */

async function getSettlement(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()

  const view = await withOperatorRead(
    h.deps.appDb, h.deps.opsDb, h.ctx,
    { scopes, subject: { subjectType: 'settlement', subjectId: h.params['id']! } },
    (conn) => opsSettlement(conn, h.params['id']!),
  )
  if (!view) return json(404, { error: { code: 'not_found', message: 'No such settlement.' } })
  return json(200, view)
}

async function settlementAudit(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()
  const limit = intParam(h.query, 'limit', DEFAULT_LIMIT, MAX_LIMIT)

  const entries = await withOperatorRead(
    h.deps.appDb, h.deps.opsDb, h.ctx,
    { scopes, subject: { subjectType: 'settlement', subjectId: h.params['id']! } },
    (conn) => opsAuditLog(conn, asOpsScoped(scopes), { subjectId: h.params['id']! }, limit),
  )
  return json(200, opsList(entries, limit))
}

/* ── Exceptions ─────────────────────────────────────────────────────────── */

async function listExceptions(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()
  const limit = intParam(h.query, 'limit', DEFAULT_LIMIT, MAX_LIMIT)

  const queue = await withOperatorRead(
    h.deps.appDb, h.deps.opsDb, h.ctx, { scopes },
    (conn) => opsExceptionQueue(conn, asOpsScoped(scopes), limit),
  )
  return json(200, opsList(queue, limit))
}

async function resolveOne(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()

  const body = (h.body ?? {}) as { resolution?: unknown }
  const resolution = body.resolution
  if (resolution !== 'resume' && resolution !== 'fail' && resolution !== 'cancel') {
    return json(400, {
      error: {
        code: 'invalid_resolution',
        message: 'resolution must be one of resume, fail or cancel.',
      },
    })
  }

  const result = await resolveExceptionAsOperator(
    h.deps.appDb, scopes[0]!, h.ctx,
    { settlementId: h.params['settlementId']!, resolution },
  )
  if (!result.ok) {
    // A refused resolution is a `409`, not a `500`: nothing went wrong, the
    // action was not available. `value_may_have_been_delivered` is the one an
    // operator most needs to read as an answer rather than an error.
    return json(409, { error: { code: result.reason, message: refusalMessage(result.reason) } })
  }
  return json(200, {
    settlement_id: h.params['settlementId'],
    resolution: result.resolution,
    from: result.from,
    to: result.to,
    compensation: result.compensation,
  })
}

function refusalMessage(reason: string): string {
  switch (reason) {
    case 'value_may_have_been_delivered':
      return 'This payout may already have credited. Marking it failed would tell the ' +
             'customer no money moved, and we do not know that. Resume it and find out.'
    case 'past_point_of_no_return':
      return 'This settlement is past the point of no return and cannot be cancelled.'
    case 'no_open_exception':
      return 'This settlement has no open exception.'
    case 'settlement_not_found':
      return 'No such settlement in that workspace.'
    case 'compensation_failed':
      return 'The liquidity compensation could not be applied, so nothing was changed.'
    default:
      return 'The state machine refused this transition.'
  }
}

/* ── Liquidity ──────────────────────────────────────────────────────────── */

async function listFacilities(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()
  const facilities = await withOperatorRead(
    h.deps.appDb, h.deps.opsDb, h.ctx, { scopes },
    (conn) => opsFacilities(conn, asOpsScoped(scopes)),
  )
  return json(200, opsList(facilities, facilities.length))
}

async function listMovements(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()
  const limit = intParam(h.query, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
  const movements = await withOperatorRead(
    h.deps.appDb, h.deps.opsDb, h.ctx, { scopes },
    (conn) => opsFacilityMovements(conn, asOpsScoped(scopes), limit),
  )
  return json(200, opsList(movements, limit))
}

async function setLimit(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()

  const body = (h.body ?? {}) as { currency?: unknown; minor_units?: unknown }
  if (typeof body.currency !== 'string' || typeof body.minor_units !== 'string') {
    return json(400, {
      error: {
        code: 'invalid_amount',
        // `INV-04` in the error message: a limit arriving as a JSON number
        // would be rounded above 2^53, and a facility limit is exactly the
        // figure nobody notices is wrong until it is.
        message: 'Send currency and minor_units, with minor_units as a string.',
      },
    })
  }
  if (!/^\d+$/.test(body.minor_units)) {
    return json(400, {
      error: { code: 'invalid_amount', message: 'minor_units must be a non-negative integer string.' },
    })
  }

  const result = await setFacilityLimit(h.deps.appDb, scopes[0]!, h.ctx, {
    facilityId: h.params['id']!,
    limit: money(body.currency as CurrencyCode, BigInt(body.minor_units)),
  })
  if (!result.ok) {
    return json(409, {
      error: {
        code: result.reason,
        message: result.reason === 'below_committed'
          ? 'This facility already carries more than that. Lowering the limit below ' +
            'what is drawn and reserved would make availability negative.'
          : 'The facility limit was not changed.',
        ...(result.committed
          ? {
              committed: {
                currency: result.committed.currency,
                minor_units: result.committed.minorUnits.toString(),
              },
            }
          : {}),
      },
    })
  }
  return json(200, {
    facility_id: result.facilityId,
    previous: { currency: result.previous.currency, minor_units: result.previous.minorUnits.toString() },
    limit: { currency: result.next.currency, minor_units: result.next.minorUnits.toString() },
    available: { currency: result.available.currency, minor_units: result.available.minorUnits.toString() },
  })
}

async function setStatus(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()

  const body = (h.body ?? {}) as { status?: unknown }
  if (body.status !== 'ACTIVE' && body.status !== 'SUSPENDED') {
    return json(400, {
      error: {
        code: 'invalid_status',
        // Closing is absent on purpose: it is a commercial act with an open
        // settlement question (`D-16b`), and it is not invented here.
        message: 'status must be ACTIVE or SUSPENDED.',
      },
    })
  }

  const result = await setFacilityStatus(h.deps.appDb, scopes[0]!, h.ctx, {
    facilityId: h.params['id']!, status: body.status,
  })
  if (!result.ok) {
    return json(409, { error: { code: result.reason, message: 'The facility was not changed.' } })
  }
  return json(200, { facility_id: result.facilityId, from: result.from, to: result.to })
}

async function advanceOne(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()

  const body = (h.body ?? {}) as { trigger?: unknown; provider_reference?: unknown }
  if (typeof body.trigger !== 'string') {
    return json(400, { error: { code: 'invalid_trigger', message: 'trigger is required.' } })
  }

  const result = await advanceRepaymentAsOperator(h.deps.appDb, scopes[0]!, h.ctx, {
    repaymentId: h.params['id']!,
    trigger: body.trigger as never,
    ...(typeof body.provider_reference === 'string'
      ? { providerReference: body.provider_reference }
      : {}),
  })
  if (!result.ok) {
    return json(409, { error: { code: result.reason, message: 'The repayment was not advanced.' } })
  }
  return json(200, { repayment_id: result.repaymentId, status: result.status })
}

/* ── Reconciliation and providers ───────────────────────────────────────── */

async function listReconciliations(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()
  const limit = intParam(h.query, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
  const queue = await withOperatorRead(
    h.deps.appDb, h.deps.opsDb, h.ctx, { scopes },
    (conn) => opsReconciliationQueue(conn, asOpsScoped(scopes), limit),
  )
  return json(200, opsList(queue, limit))
}

async function listProviderEvents(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()
  const limit = intParam(h.query, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
  const events = await withOperatorRead(
    h.deps.appDb, h.deps.opsDb, h.ctx, { scopes },
    (conn) => opsProviderEvents(conn, asOpsScoped(scopes), limit),
  )
  return json(200, opsList(events, limit))
}

/* ── The audit log ──────────────────────────────────────────────────────── */

async function listAudit(h: OpsHandlerContext): Promise<OpsResponse> {
  const scopes = explicitScopes(h.query)
  if (scopes.length === 0) return needsScope()
  const limit = intParam(h.query, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
  const filter = {
    ...(h.query['subject_id'] ? { subjectId: h.query['subject_id'] } : {}),
    ...(h.query['actor_id'] ? { actorId: h.query['actor_id'] } : {}),
  }
  const entries = await withOperatorRead(
    h.deps.appDb, h.deps.opsDb, h.ctx, { scopes },
    (conn) => opsAuditLog(conn, asOpsScoped(scopes), filter, limit),
  )
  return json(200, opsList(entries, limit))
}

/* ── Ourselves ──────────────────────────────────────────────────────────── */

function me(h: OpsHandlerContext): OpsResponse {
  return json(200, {
    operator_id: h.operator.operatorId,
    email: h.operator.email,
    display_name: h.operator.displayName,
    roles: h.operator.roles,
    capabilities: [...h.operator.capabilities].sort(),
  })
}

async function operatorHistory(h: OpsHandlerContext): Promise<OpsResponse> {
  const limit = intParam(h.query, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
  // Our own record of what we did, not a tenant's data — so no
  // `withOperatorRead` and no reason. It is the query an `ops_admin` runs when
  // reviewing someone's access, and it spans every workspace they touched.
  const history = await opsOperatorHistory(h.deps.opsDb, h.params['id']!, limit)
  return json(200, opsList(history, limit))
}

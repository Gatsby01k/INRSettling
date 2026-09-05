/**
 * The request pipeline.
 *
 * Every `/v1` request goes through here in one fixed order, and the order is
 * the design:
 *
 *  1. **Reject a session cookie outright.** `§ 2`: *"Session cookies are never
 *     accepted by the API host."*
 *  2. **Authenticate.** The bearer key resolves to a workspace and environment.
 *     Nothing before this point has touched tenant data.
 *  3. **Route, then authorize.** Both *before* the idempotency claim, and that
 *     ordering is a security property rather than tidiness: a caller who could
 *     not perform the operation must not be able to read a stored response by
 *     guessing a key, and must not be able to squat a key so that the caller who
 *     *can* perform it gets a `409` for the next 24 hours.
 *  4. **Rate limit**, in its own short transaction, so a refused request costs
 *     nothing and a slow one does not hold the counter's row lock.
 *  5. **Version.** An unknown `INRSettle-Version` is a `400`, not a silent
 *     fallback to the workspace pin.
 *  6. **Parse the body strictly**, rejecting duplicate keys.
 *  7. **Handle**, inside one transaction that also carries the idempotency claim.
 *  8. **Log**, afterwards, in a transaction of its own.
 *
 * `request_id` is generated at step 0 and is on every response, success or
 * failure, and in the log row (`§ 5`).
 */
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  ApiError, bucketFor, internalError, JsonParseError, notFound, parseStrictJson,
  rateLimitHeaders, resolveApiVersion,
  type ApiVersion, type JsonValue, type TenantScope,
} from '@inrsettle/domain'
import {
  confirmKeyInScope, keyRejection, rateLimited, recordApiRequest, requireScope,
  resolveApiKey, touchKeyLastUsed, withIdempotencyClaim,
  type AuthenticatedKey, type RateLimiter, type StoredResponse,
} from '@inrsettle/app-services'
import { header, json, type ApiRequest, type ApiResponse } from './http.js'
import { matchRoute, type RouteDefinition } from './routes.js'
import type { ApiDeps } from './deps.js'

export interface HandlerContext {
  readonly db: Db
  readonly tx: Db
  readonly scope: TenantScope
  readonly key: AuthenticatedKey
  readonly requestId: string
  readonly apiVersion: ApiVersion
  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
  readonly body: JsonValue | null
  readonly route: RouteDefinition
  readonly request: ApiRequest
  readonly deps: ApiDeps
  readonly numberFormat: 'international' | 'indian'
}

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>

export interface HandlerResult {
  readonly status: number
  readonly body: unknown
  readonly headers?: Readonly<Record<string, string>>
  /** The object this request acted on, recorded on the idempotency claim. */
  readonly subjectId?: string
}

export type HandlerTable = Readonly<Record<string, Handler>>

const sessionCookieRejected = (): ApiError =>
  new ApiError({
    type: 'authentication_error',
    code: 'session_credentials_not_accepted',
    message: 'The API does not accept session cookies.',
    detail: 'Authenticate with an API key: Authorization: Bearer sk_live_… or sk_test_…',
  })

const missingAuthorization = (): ApiError =>
  new ApiError({
    type: 'authentication_error',
    code: 'missing_authorization',
    message: 'This endpoint needs an API key.',
    detail: 'Send Authorization: Bearer sk_live_… (or sk_test_… for sandbox).',
  })

const malformedAuthorization = (): ApiError =>
  new ApiError({
    type: 'authentication_error',
    code: 'malformed_authorization',
    message: 'The Authorization header is not a bearer token.',
    detail: 'The format is: Authorization: Bearer sk_live_…',
  })

const idempotencyKeyRequired = (): ApiError =>
  new ApiError({
    type: 'invalid_request_error',
    code: 'idempotency_key_required',
    message: 'This endpoint requires an Idempotency-Key header.',
    detail:
      'Generate one unique value per logical operation — a UUID, or your own reference — and ' +
      'reuse it on every retry of that operation. It is what makes a retry safe.',
    param: 'Idempotency-Key',
  })

const idempotencyKeyInvalid = (why: string): ApiError =>
  new ApiError({
    type: 'invalid_request_error',
    code: 'idempotency_key_invalid',
    message: `The Idempotency-Key is ${why}.`,
    detail: 'It must be 1 to 255 printable ASCII characters.',
    param: 'Idempotency-Key',
  })

const unsupportedVersion = (requested: string, supported: readonly string[]): ApiError =>
  new ApiError({
    type: 'invalid_request_error',
    code: 'unsupported_api_version',
    message: `"${requested}" is not an API version this service speaks.`,
    detail: `Send one of: ${supported.join(', ')}, or omit the header to use your workspace's pinned version.`,
    param: 'INRSettle-Version',
  })

const methodNotAllowed = (allowed: readonly string[]): ApiError =>
  new ApiError({
    type: 'invalid_request_error',
    code: 'invalid_parameter',
    message: 'That method is not allowed on this path.',
    detail: `This path accepts: ${allowed.join(', ')}.`,
  })

const badJson = (e: JsonParseError): ApiError =>
  new ApiError({
    type: 'invalid_request_error',
    code: e.kind === 'duplicate_key' ? 'duplicate_json_key' : 'invalid_json',
    message: e.kind === 'duplicate_key'
      ? 'The request body has the same key twice.'
      : 'The request body is not valid JSON.',
    detail: `${e.message} (at byte ${e.offset}).`,
  })

function bearerToken(req: ApiRequest): string | ApiError {
  if (header(req, 'cookie') !== undefined) return sessionCookieRejected()
  const auth = header(req, 'authorization')
  if (auth === undefined || auth === '') return missingAuthorization()
  const [scheme, ...rest] = auth.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) return malformedAuthorization()
  return rest.join(' ').trim()
}

/** 1–255 printable ASCII, matching the CHECK on the column. */
function validateIdempotencyKey(value: string): ApiError | null {
  if (value.length === 0) return idempotencyKeyInvalid('empty')
  if (value.length > 255) return idempotencyKeyInvalid('longer than 255 characters')
  if (!/^[\x20-\x7E]+$/.test(value)) return idempotencyKeyInvalid('not printable ASCII')
  return null
}

function errorResponse(
  e: ApiError, requestId: string, extra: Readonly<Record<string, string>>,
): ApiResponse {
  return json(e.status, e.envelope(requestId), {
    'INRSettle-Request-Id': requestId,
    ...extra,
    ...e.headers,
  })
}

export interface PipelineOptions {
  readonly db: Db
  readonly deps: ApiDeps
  readonly handlers: HandlerTable
  readonly rateLimiter: RateLimiter
  readonly now?: () => Date
}

export async function handle(
  req: ApiRequest, options: PipelineOptions,
): Promise<ApiResponse> {
  const requestId = newId('apiRequest')
  const now = options.now ?? (() => new Date())
  const startedAt = Date.now()

  const token = bearerToken(req)
  if (typeof token !== 'string') return errorResponse(token, requestId, {})

  const resolution = await resolveApiKey(options.db, token)
  if (!resolution.ok) {
    // A revoked key resolves to a workspace, which is where the compromise
    // signal belongs — a key someone is still presenting after it was revoked
    // is worth an audit row in its own workspace. An unresolvable token has no
    // workspace and belongs in the structured log, never in `audit_log`: giving
    // that table a nullable workspace would punch a hole through the tenant
    // shape for the sake of a line about a string somebody typed.
    if (resolution.reason === 'revoked') {
      await auditRevokedKeyUse(options.db, {
        workspaceId: resolution.workspaceId,
        environment: resolution.environment,
      }, resolution.keyId, requestId)
    }
    return errorResponse(keyRejection(), requestId, {})
  }

  const key: AuthenticatedKey = resolution.key
  const scope: TenantScope = { workspaceId: key.workspaceId, environment: key.environment }

  const matched = matchRoute(req.method, req.path)
  if (matched === null) {
    return errorResponse(notFound('endpoint'), requestId, {})
  }
  if ('methodMismatch' in matched) {
    return errorResponse(methodNotAllowed(matched.methodMismatch), requestId, {})
  }
  const { route, params } = matched

  // Before the claim, deliberately. See the header.
  if (route.scope !== null) {
    const denied = requireScope(key, route.scope)
    if (denied) return errorResponse(denied, requestId, {})
  }

  const nowSeconds = Math.floor(now().getTime() / 1000)
  const limit = await options.rateLimiter.consume(scope, {
    apiKeyId: key.keyId,
    bucket: bucketFor(req.method, req.path),
    nowSeconds,
  })
  const limitHeaders = rateLimitHeaders(limit)
  if (!limit.allowed) {
    return errorResponse(rateLimited(limit.retryAfterSeconds), requestId, limitHeaders)
  }

  const workspace = await readWorkspaceSettings(options.db, scope)
  const version = resolveApiVersion(header(req, 'inrsettle-version'), workspace.apiVersion)
  if (!version.ok) {
    return errorResponse(
      unsupportedVersion(version.requested, version.supported), requestId, limitHeaders,
    )
  }

  const baseHeaders = {
    'INRSettle-Request-Id': requestId,
    'INRSettle-Version': version.version,
    ...limitHeaders,
  }

  let body: JsonValue | null = null
  if (req.rawBody !== undefined && req.rawBody !== '') {
    try {
      body = parseStrictJson(req.rawBody)
    } catch (e) {
      if (e instanceof JsonParseError) return errorResponse(badJson(e), requestId, baseHeaders)
      throw e
    }
  }

  const idempotencyKey = header(req, 'idempotency-key')
  if (route.idempotency === 'required' && idempotencyKey === undefined) {
    return errorResponse(idempotencyKeyRequired(), requestId, baseHeaders)
  }
  if (idempotencyKey !== undefined) {
    const invalid = validateIdempotencyKey(idempotencyKey)
    if (invalid) return errorResponse(invalid, requestId, baseHeaders)
  }

  const handler = options.handlers[route.name]
  if (handler === undefined) return errorResponse(internalError(), requestId, baseHeaders)

  let response: ApiResponse
  let replayed = false
  let errorType: string | undefined
  let errorCode: string | undefined

  try {
    response = await withTenant(options.db, scope, async (tx) => {
      // Step 2 of authentication: the definer answer was advisory, and this is
      // the ordinary RLS-filtered table agreeing with it. It settles revocation
      // and scope ownership in one statement.
      if (!(await confirmKeyInScope(tx, scope, key.keyId))) throw keyRejection()

      const ctx: HandlerContext = {
        db: options.db, tx, scope, key, requestId,
        apiVersion: version.version, params, query: req.query ?? {}, body,
        route, request: req, deps: options.deps,
        numberFormat: workspace.numberFormat,
      }

      const run = async (): Promise<{
        value: HandlerResult; response: StoredResponse; subjectId?: string
      }> => {
        const result = await handler(ctx)
        const stored: StoredResponse = {
          status: result.status,
          body: JSON.stringify(result.body),
        }
        return {
          value: result,
          response: stored,
          ...(result.subjectId === undefined ? {} : { subjectId: result.subjectId }),
        }
      }

      if (idempotencyKey === undefined || route.idempotency === 'route_managed') {
        const result = await handler(ctx)
        return json(result.status, result.body, { ...baseHeaders, ...(result.headers ?? {}) })
      }

      const outcome = await withIdempotencyClaim(tx, scope, {
        method: req.method,
        // The CONCRETE path. Under a route template, one key reused across two
        // settlements would replay the first's response and the second would
        // silently never be authorized.
        path: req.path,
        apiVersion: version.version,
        idempotencyKey,
        body,
        requestId,
        ...(route.subjectParam !== undefined && params[route.subjectParam] !== undefined
          ? { subjectId: params[route.subjectParam]! }
          : {}),
      }, run)

      if (outcome.kind === 'replayed') {
        replayed = true
        return {
          status: outcome.response.status,
          headers: {
            'Content-Type': 'application/json',
            ...baseHeaders,
            'Idempotency-Replayed': 'true',
          },
          body: outcome.response.body,
        }
      }
      return json(outcome.value.status, outcome.value.body, {
        ...baseHeaders, ...(outcome.value.headers ?? {}),
      })
    })
  } catch (e) {
    const apiError = e instanceof ApiError ? e : internalError()
    errorType = apiError.type
    errorCode = apiError.code
    response = errorResponse(apiError, requestId, baseHeaders)
    if (!(e instanceof ApiError)) options.deps.onUnexpectedError?.(e, requestId)
  }

  await recordApiRequest(options.db, scope, {
    requestId,
    apiKeyId: key.keyId,
    method: req.method.toUpperCase(),
    path: req.path,
    route: route.pattern,
    status: response.status,
    errorType,
    errorCode,
    apiVersion: version.version,
    idempotencyKey,
    idempotencyReplayed: replayed,
    durationMs: Date.now() - startedAt,
  })
  void touchKeyLastUsed(options.db, scope, key.keyId)

  return response
}

async function readWorkspaceSettings(
  db: Db, scope: TenantScope,
): Promise<{ apiVersion: string; numberFormat: 'international' | 'indian' }> {
  return withTenant(db, scope, async (tx) => {
    const [row] = await tx.select({
      apiVersion: schema.workspaces.apiVersion,
      numberFormat: schema.workspaces.numberFormat,
    }).from(schema.workspaces).limit(1)
    return {
      apiVersion: row?.apiVersion ?? '2026-08-31',
      numberFormat: row?.numberFormat === 'indian' ? 'indian' : 'international',
    }
  })
}

async function auditRevokedKeyUse(
  db: Db, scope: TenantScope, keyId: string, requestId: string,
): Promise<void> {
  try {
    await withTenant(db, scope, async (tx) => {
      await tx.insert(schema.auditLog).values({
        id: newId('audit'),
        workspaceId: scope.workspaceId,
        environment: scope.environment,
        actorType: 'api_key',
        actorId: keyId,
        action: 'api_key.revoked_key_presented',
        subjectType: 'api_key',
        subjectId: keyId,
        requestId,
      })
    })
  } catch {
    // Never let the audit of a rejected request change the rejection.
  }
}

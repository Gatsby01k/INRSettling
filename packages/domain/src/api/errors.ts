/**
 * The one error envelope — `API_CONTRACT.md § 5`.
 *
 * > One envelope, everywhere, including `500`s.
 *
 * Two rules make this file worth existing rather than being a type alias.
 *
 * **The type decides the status, and nothing else does.** The table in `§ 5`
 * pairs each `type` with exactly one HTTP status, so a handler that picks a
 * status independently of a type can produce a `403` whose body says
 * `not_found_error`. Here the status is derived, so that combination is
 * unrepresentable.
 *
 * **Every error is as specific and as actionable as a screen** (`§ 5` rule 4,
 * pointing at `PRODUCT.md § 7.1`). The same standard the preflight requirements
 * are held to applies to the API, and the same gate enforces it: the generic
 * phrases that gate bans cannot appear in a `message` here, including on a
 * `500` — which is why the internal error below names what the reader can
 * actually do rather than apologising.
 */

export const API_ERROR_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'conflict_error',
  'rate_limit_error',
  'provider_error',
  'api_error',
] as const
export type ApiErrorType = (typeof API_ERROR_TYPES)[number]

/** `§ 5`'s table, as data. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorType, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  rate_limit_error: 429,
  provider_error: 502,
  api_error: 500,
}

export function statusForErrorType(type: ApiErrorType): number {
  return API_ERROR_STATUS[type]
}

/**
 * The stable `code` values.
 *
 * `§ 5`: *"`code` values are stable and enumerated in the reference."* Being
 * enumerated in a document nobody can execute is how enumerations drift, so the
 * reference is generated from this list and a test asserts every code a handler
 * can emit appears in it.
 */
export const API_ERROR_CODES = [
  // 400
  'invalid_body',
  'invalid_json',
  'duplicate_json_key',
  'missing_parameter',
  'invalid_parameter',
  'unsupported_api_version',
  'idempotency_key_required',
  'idempotency_key_invalid',
  'unknown_event_type',
  // 401
  'missing_authorization',
  'malformed_authorization',
  'invalid_api_key',
  'session_credentials_not_accepted',
  // 403
  'insufficient_scope',
  // 404
  'not_found',
  // 409
  'idempotency_key_reuse',
  'idempotency_in_progress',
  'invalid_transition',
  'past_point_of_no_return',
  'beneficiary_not_verified',
  'quote_expired',
  'receipt_not_ready',
  // 429
  'rate_limit_exceeded',
  // 502
  'provider_unavailable',
  // 500
  'internal_error',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export interface ApiErrorBody {
  readonly type: ApiErrorType
  readonly code: ApiErrorCode
  readonly message: string
  readonly detail?: string
  readonly param?: string
  readonly doc_url: string
  readonly request_id: string
}

export interface ApiErrorEnvelope {
  readonly error: ApiErrorBody
}

export const ERROR_DOC_BASE = 'https://docs.inrsettle.com/errors'

export function docUrlFor(code: ApiErrorCode): string {
  return `${ERROR_DOC_BASE}/${code}`
}

/**
 * A refusal, carrying everything the envelope needs and nothing the handler has
 * to remember to add.
 *
 * `detail` is optional in the wire shape but not in spirit: for every code below
 * that a customer can hit by doing something reasonable, the catalogue supplies
 * one. `param` is set wherever the problem is attributable to a named field,
 * because "invalid_parameter" without a parameter name is the generic error
 * message `PRODUCT.md § 7.1` forbids, wearing a code.
 */
export class ApiError extends Error {
  readonly type: ApiErrorType
  readonly code: ApiErrorCode
  readonly detail: string | undefined
  readonly param: string | undefined
  /** Extra response headers this error requires, e.g. `Retry-After` on a 429. */
  readonly headers: Readonly<Record<string, string>>

  constructor(args: {
    type: ApiErrorType
    code: ApiErrorCode
    message: string
    detail?: string
    param?: string
    headers?: Readonly<Record<string, string>>
  }) {
    super(args.message)
    this.name = 'ApiError'
    this.type = args.type
    this.code = args.code
    this.detail = args.detail
    this.param = args.param
    this.headers = args.headers ?? {}
  }

  get status(): number {
    return statusForErrorType(this.type)
  }

  envelope(requestId: string): ApiErrorEnvelope {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        ...(this.detail === undefined ? {} : { detail: this.detail }),
        ...(this.param === undefined ? {} : { param: this.param }),
        doc_url: docUrlFor(this.code),
        request_id: requestId,
      },
    }
  }
}

/* ── The refusals a handler reaches for ─────────────────────────────────── */

export const notFound = (what: string): ApiError =>
  new ApiError({
    type: 'not_found_error',
    code: 'not_found',
    message: `No such ${what}.`,
    // The wording is load-bearing. A `sk_test_` key addressing a live object
    // gets this answer, and it must not read as "it exists but not for you" —
    // that would confirm the object exists, which SECURITY.md § 3.3 forbids.
    detail:
      `Check the id, and check that the key you used belongs to the same ` +
      `environment as the object. A sandbox key cannot address a live object, ` +
      `and a live object is not visible to it.`,
  })

export const insufficientScope = (scope: string): ApiError =>
  new ApiError({
    type: 'permission_error',
    code: 'insufficient_scope',
    message: `This API key does not have the ${scope} scope.`,
    detail: `Grant ${scope} to the key in Developers → API keys, or use a key that already holds it.`,
  })

export const invalidApiKey = (): ApiError =>
  new ApiError({
    type: 'authentication_error',
    code: 'invalid_api_key',
    message: 'That API key is not valid.',
    detail:
      'It may have been revoked, or it may belong to another workspace. ' +
      'Create a new key in Developers → API keys.',
  })

export const internalError = (): ApiError =>
  new ApiError({
    type: 'api_error',
    code: 'internal_error',
    // Even a 500 owes the reader three things: whose fault it was, whether
    // anything happened, and what to do next. "Our fault" matters because the
    // integrator's first move is otherwise to audit their own code; "nothing
    // was committed" matters because their second move is to check whether to
    // retry.
    message: 'This request failed inside INRSettle. It is our fault, not yours.',
    detail:
      'Nothing was committed, so the request is safe to retry with the same ' +
      'Idempotency-Key. Send us the request_id on this response and we can tell ' +
      'you exactly what happened.',
  })

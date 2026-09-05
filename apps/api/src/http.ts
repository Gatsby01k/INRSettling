/**
 * The public API's HTTP shapes.
 *
 * Deliberately framework-free. `ARCHITECTURE.md § 2` puts the API in a Next.js
 * app, and a Next route handler is a five-line adapter over `handle` — but the
 * contract, the error envelope, the idempotency semantics and the version
 * negotiation are none of Next's business, and a contract test that has to boot
 * a web framework to assert a `409` is a test nobody runs often enough.
 *
 * So a request is a plain object and a response is a plain object, and the
 * whole surface is callable from a unit test in microseconds. The exit
 * criterion is *"contract tests cover every endpoint, every error type, and the
 * idempotency semantics"* — which is a lot of tests, and they have to be cheap.
 */

export interface ApiRequest {
  readonly method: string
  /** Path only, no query string: `/v1/settlements/stl_2Rn8Kq5TzYw6`. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  /** Lower-cased keys, as every HTTP stack normalises them. */
  readonly headers?: Readonly<Record<string, string>>
  readonly rawBody?: string | undefined
}

export interface ApiResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export function header(req: ApiRequest, name: string): string | undefined {
  return req.headers?.[name.toLowerCase()]
}

export function json(
  status: number, value: unknown, headers: Readonly<Record<string, string>> = {},
): ApiResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value),
  }
}

/** A list envelope — `API_CONTRACT.md § 6`. Offsets do not exist. */
export interface ListEnvelope<T> {
  readonly object: 'list'
  readonly data: readonly T[]
  readonly has_more: boolean
  readonly next_cursor: string | null
}

export const LIST_DEFAULT_LIMIT = 25
export const LIST_MAX_LIMIT = 100

export function listEnvelope<T>(
  rows: readonly T[], limit: number, cursorOf: (row: T) => string,
): ListEnvelope<T> {
  // The caller fetches limit + 1 and hands the whole thing here, so "is there
  // more" is answered by having looked rather than by a count query that can
  // disagree with the page it describes.
  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const last = data[data.length - 1]
  return {
    object: 'list',
    data,
    has_more: hasMore,
    next_cursor: hasMore && last !== undefined ? cursorOf(last) : null,
  }
}

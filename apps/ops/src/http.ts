/**
 * Internal Operations HTTP shapes.
 *
 * Framework-free, for the same reason `apps/api`'s are: the rules under test
 * here — who may act, from where, with what reason — are none of a web
 * framework's business, and a test that has to boot one to assert a `403` is a
 * test nobody runs often enough.
 *
 * One difference from the public API's request shape: `ip`, and it is
 * **required**. The public API does not care where a request came from; this one
 * does, because `SECURITY.md § 3.1` makes ops sessions network-restricted.
 *
 * Required rather than optional, because an optional address is one that is
 * sometimes absent, and a network restriction skipped when the address is
 * missing is not a restriction — it is a restriction with a hole shaped like a
 * misconfigured proxy. A deployment that cannot supply the address cannot serve
 * ops requests, and that is the correct outcome: it fails at the boundary rather
 * than quietly admitting everyone.
 */

export interface OpsRequest {
  readonly method: string
  /** Path only, no query string: `/ops/settlements/stl_2Rn8Kq5TzYw6`. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  /** Lower-cased keys, as every HTTP stack normalises them. */
  readonly headers?: Readonly<Record<string, string>>
  readonly rawBody?: string | undefined
  /** The address this request arrived from, checked on every request. Required. */
  readonly ip: string
}

export interface OpsResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export function json(
  status: number, value: unknown, headers: Readonly<Record<string, string>> = {},
): OpsResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value, (_key, v: unknown) =>
      // `INV-04`: minor units cross the wire as strings. Ops is not an exception
      // — a bigint that reached `JSON.stringify` unhandled would throw, and one
      // silently coerced to a number would be a rounded payment on a screen
      // somebody makes a decision from.
      typeof v === 'bigint' ? v.toString() : v),
  }
}

/**
 * A list envelope.
 *
 * Deliberately unlike `apps/api`'s: no cursor. Ops queues are bounded by their
 * own nature — an exception queue with ten thousand entries is an incident
 * rather than a page — and a limit with a stated total is the more useful shape
 * for a screen whose job is to say how much work is waiting.
 */
export interface OpsList<T> {
  readonly object: 'list'
  readonly data: readonly T[]
  readonly count: number
  readonly limit: number
  /** True when the limit cut the result short, so the count is a floor. */
  readonly truncated: boolean
}

export function opsList<T>(rows: readonly T[], limit: number): OpsList<T> {
  const truncated = rows.length >= limit
  return { object: 'list', data: rows, count: rows.length, limit, truncated }
}

export function intParam(
  query: Readonly<Record<string, string>>, name: string, fallback: number, max: number,
): number {
  const raw = query[name]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

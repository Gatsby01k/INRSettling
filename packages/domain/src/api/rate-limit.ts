/**
 * Rate limiting — `API_CONTRACT.md § 11`.
 *
 * > Per API key, published in the reference, returned on every response.
 * > Reads and writes have separate buckets. Batch ingestion has its own. `429`
 * > carries `Retry-After` and is always safe to retry with the same idempotency
 * > key.
 *
 * Separate buckets because the failure they prevent is specific: a nightly batch
 * import must not be able to exhaust the allowance a dashboard's polling needs,
 * and a dashboard must not be able to throttle payroll. One shared bucket makes
 * every client's behaviour everyone else's problem.
 *
 * **The limits are configuration, not a number chosen here.** The sandbox
 * fixture in the application layer is labelled as one, on the same reasoning
 * `D-05b` and `D-08b` were settled with: a default becomes the answer by
 * accident, and the first person to notice is a customer whose payroll run was
 * refused. This module owns the arithmetic; it owns no figures.
 */

export const RATE_LIMIT_BUCKETS = ['read', 'write', 'batch'] as const
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number]

export interface RateLimitPolicy {
  /** Requests allowed per window, per key, per bucket. */
  readonly limit: number
  readonly windowSeconds: number
}

export type RateLimitConfig = Readonly<Record<RateLimitBucket, RateLimitPolicy>>

/** Which bucket a request draws from. */
export function bucketFor(method: string, path: string): RateLimitBucket {
  if (path.startsWith('/v1/batches') && method !== 'GET') return 'batch'
  return method === 'GET' ? 'read' : 'write'
}

export interface RateLimitDecision {
  readonly allowed: boolean
  readonly limit: number
  readonly remaining: number
  /** Unix seconds at which the window resets — the `…-RateLimit-Reset` header. */
  readonly resetAtSeconds: number
  /** Seconds, for `Retry-After`. Only meaningful when refused. */
  readonly retryAfterSeconds: number
}

/**
 * A fixed window.
 *
 * Fixed rather than sliding, deliberately. A sliding window needs either a
 * per-request log or an approximation, and the honest trade is: a fixed window
 * lets a client send up to twice the limit across a window boundary, which for a
 * settlement API is a burst somebody's payroll job legitimately produces anyway.
 * The alternative costs a row per request and buys smoothness nobody asked for.
 *
 * @param windowStartSeconds when the current stored window began, or `null` if
 *   this key has never drawn from this bucket.
 * @param countSoFar requests already recorded in that window.
 */
export function evaluateRateLimit(args: {
  policy: RateLimitPolicy
  nowSeconds: number
  windowStartSeconds: number | null
  countSoFar: number
}): RateLimitDecision & { readonly newWindowStartSeconds: number; readonly newCount: number } {
  const { policy, nowSeconds } = args
  const expired =
    args.windowStartSeconds === null ||
    nowSeconds - args.windowStartSeconds >= policy.windowSeconds

  const windowStart = expired ? nowSeconds : args.windowStartSeconds!
  const used = expired ? 0 : args.countSoFar
  const resetAt = windowStart + policy.windowSeconds
  const allowed = used < policy.limit
  const newCount = allowed ? used + 1 : used

  return {
    allowed,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - newCount),
    resetAtSeconds: resetAt,
    // Never zero: a `Retry-After: 0` invites an immediate retry, which is
    // exactly the traffic the refusal exists to stop.
    retryAfterSeconds: Math.max(1, resetAt - nowSeconds),
    newWindowStartSeconds: windowStart,
    newCount,
  }
}

/** The three headers `§ 11` puts on every response, success or failure. */
export function rateLimitHeaders(d: RateLimitDecision): Record<string, string> {
  return {
    'INRSettle-RateLimit-Limit': String(d.limit),
    'INRSettle-RateLimit-Remaining': String(d.remaining),
    'INRSettle-RateLimit-Reset': String(d.resetAtSeconds),
  }
}

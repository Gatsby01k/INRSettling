/**
 * Delivery policy — `API_CONTRACT.md § 10.3`, `ARCHITECTURE.md § 6`.
 *
 * > Delivery: retried with exponential backoff and jitter for about 24 hours; a
 * > consistently failing endpoint is circuit-broken and the workspace is
 * > notified. Every attempt, its response code and its body are visible in
 * > Developers → Event logs, with a replay action.
 *
 * Everything here is pure: a schedule, a classification of one HTTP response,
 * and a circuit-breaker decision. No clock, no network, no database. The worker
 * supplies `now` and a random draw and does what it is told, which is what makes
 * "survives an endpoint that is down for an hour" a test that runs in
 * milliseconds instead of an hour.
 */

/**
 * The backoff schedule, in seconds, one entry per retry after the first attempt.
 *
 * Chosen to satisfy the two numbers `§ 10.3` actually states — *about 24 hours*
 * of retrying, with *exponential backoff* — while keeping the early retries
 * close enough together that the overwhelmingly common failure (a deploy, a
 * thirty-second restart, a transient 502) is recovered from before anybody
 * looks at a dashboard.
 *
 * The sum is 23h 54m over 13 retries — fourteen attempts in all. The first five
 * land within the first nine minutes; the last four are hours apart, because an
 * endpoint that has been down for six hours is not going to be fixed by asking
 * again in thirty seconds.
 */
export const RETRY_SCHEDULE_SECONDS: readonly number[] = [
  10, 30, 60, 120, 300,          //  8m40s — a restart or a deploy
  900, 1800, 3600,               // +1h45m — a bad release someone is fixing
  7200, 10800, 14400,            // +9h    — an outage
  21600, 25200,                  // +13h   — overnight, and the morning after
]

export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1

/**
 * How long an endpoint must keep failing before the circuit opens.
 *
 * Counted in *consecutive failed deliveries across events*, not attempts within
 * one delivery: an endpoint that fails one event fifteen times may simply
 * dislike that event, and cutting a customer off from every other event because
 * of one poison payload would be the wrong response to a narrow problem.
 */
export const CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES = 20

/**
 * Jitter, as a fraction of the interval.
 *
 * Without it, a thousand deliveries that failed together retry together, and the
 * endpoint that just came back up is knocked over by the recovery. ±20% of the
 * interval, so the ordering of the schedule survives while the herd does not.
 */
export const JITTER_FRACTION = 0.2

export type DeliveryOutcome =
  /** 2xx. Done, and the endpoint's failure streak resets. */
  | { readonly kind: 'delivered'; readonly statusCode: number }
  /** A response that will not become a success by being repeated. */
  | { readonly kind: 'rejected'; readonly statusCode: number }
  /** Down, overloaded, or unreachable. Retry. */
  | { readonly kind: 'retryable'; readonly statusCode?: number; readonly error?: string }

/**
 * What one HTTP response means.
 *
 * `4xx` is not retried, with two exceptions that are not client errors in
 * practice: `408` is the endpoint saying it ran out of time, and `429` is the
 * endpoint asking for less traffic — retrying is the *requested* behaviour.
 * Everything else in the 4xx range means the endpoint understood the request and
 * refused it, and fourteen more identical refusals over 24 hours is noise in
 * somebody's error budget.
 */
export function classifyResponse(statusCode: number): DeliveryOutcome {
  if (statusCode >= 200 && statusCode < 300) return { kind: 'delivered', statusCode }
  if (statusCode === 408 || statusCode === 429) return { kind: 'retryable', statusCode }
  if (statusCode >= 400 && statusCode < 500) return { kind: 'rejected', statusCode }
  return { kind: 'retryable', statusCode }
}

export interface NextAttempt {
  readonly attemptNumber: number
  readonly delaySeconds: number
}

/**
 * When to try again, or `null` when the schedule is spent.
 *
 * @param random a draw in `[0, 1)`. Injected rather than called, so a test can
 *   assert the schedule exactly and a second test can assert the jitter bounds,
 *   instead of one flaky test asserting neither.
 */
export function nextAttempt(attemptsSoFar: number, random: number): NextAttempt | null {
  const index = attemptsSoFar - 1
  const base = RETRY_SCHEDULE_SECONDS[index]
  if (base === undefined) return null
  const spread = base * JITTER_FRACTION
  const delay = base - spread + random * 2 * spread
  return { attemptNumber: attemptsSoFar + 1, delaySeconds: Math.max(1, Math.round(delay)) }
}

/** The total the schedule covers, for the claim "about 24 hours" to be checkable. */
export function scheduleHorizonSeconds(): number {
  return RETRY_SCHEDULE_SECONDS.reduce((a, b) => a + b, 0)
}

export type EndpointHealth =
  | { readonly action: 'keep_enabled'; readonly consecutiveFailures: number }
  | { readonly action: 'open_circuit'; readonly consecutiveFailures: number }

/**
 * Whether this outcome should take the endpoint out of service.
 *
 * The circuit opens; it does not delete. A customer whose endpoint was down for
 * a day comes back to a disabled endpoint, a notification saying so, and every
 * event still in the log with a replay action — rather than to a silence they
 * have to reconstruct.
 */
export function endpointHealthAfter(
  consecutiveFailuresBefore: number,
  outcome: DeliveryOutcome,
): EndpointHealth {
  if (outcome.kind === 'delivered') return { action: 'keep_enabled', consecutiveFailures: 0 }
  const failures = consecutiveFailuresBefore + 1
  return failures >= CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES
    ? { action: 'open_circuit', consecutiveFailures: failures }
    : { action: 'keep_enabled', consecutiveFailures: failures }
}

/** Response bodies are recorded for the customer to read, not archived. */
export const MAX_RECORDED_RESPONSE_BYTES = 2048

export function truncateResponseBody(body: string): string {
  if (body.length <= MAX_RECORDED_RESPONSE_BYTES) return body
  return `${body.slice(0, MAX_RECORDED_RESPONSE_BYTES)}… (truncated)`
}

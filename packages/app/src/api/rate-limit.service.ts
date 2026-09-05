/**
 * Rate limiting, persisted — `API_CONTRACT.md § 11`.
 *
 * The arithmetic is pure and lives in the domain. This is the row that holds one
 * key's window, and the transaction that moves it.
 *
 * A short transaction of its own, taken *before* the request's own transaction
 * opens. Two reasons, and the second is the important one: a limiter that shared
 * the request's transaction would release its count on a rollback, so a client
 * could hammer a failing endpoint for free; and a limiter that held its row lock
 * for the length of a settlement authorization would serialise one key's traffic
 * behind its own slowest request, which is the failure the limiter exists to
 * prevent, caused by the limiter.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { withTenant } from '@inrsettle/db'
import {
  ApiError, evaluateRateLimit,
  type RateLimitBucket, type RateLimitConfig, type RateLimitDecision, type TenantScope,
} from '@inrsettle/domain'

/**
 * Sandbox figures. **Not a price list and not a product decision.**
 *
 * `§ 11` says the limits are "published in the reference"; what they should be
 * is a commercial and operational question about real traffic, in the same class
 * as `D-05b` and `D-08b`. So the shape is built and the numbers are supplied,
 * labelled, from here — and `createRateLimiter` takes a config with no default,
 * because a default becomes the answer by accident and the first person to
 * notice is a customer whose payroll run was refused.
 */
export const SANDBOX_RATE_LIMITS: RateLimitConfig = {
  read: { limit: 100, windowSeconds: 60 },
  write: { limit: 50, windowSeconds: 60 },
  batch: { limit: 10, windowSeconds: 60 },
}

export const rateLimited = (retryAfterSeconds: number): ApiError =>
  new ApiError({
    type: 'rate_limit_error',
    code: 'rate_limit_exceeded',
    message: 'This API key is over its rate limit.',
    detail:
      `Wait ${retryAfterSeconds}s and retry. Retrying with the same Idempotency-Key is safe: ` +
      'a refused request did nothing.',
    headers: { 'Retry-After': String(retryAfterSeconds) },
  })

export interface RateLimiter {
  consume(
    scope: TenantScope,
    args: { apiKeyId: string; bucket: RateLimitBucket; nowSeconds: number },
  ): Promise<RateLimitDecision>
}

export function createRateLimiter(db: Db, config: RateLimitConfig): RateLimiter {
  return {
    async consume(scope, args) {
      const policy = config[args.bucket]
      return withTenant(db, scope, async (tx) => {
        // The row lock is taken and released inside this transaction alone.
        const rows = (await tx.execute(sql`
          SELECT extract(epoch FROM window_start)::bigint AS window_start, count
            FROM api_rate_limits
           WHERE workspace_id = ${scope.workspaceId}
             AND environment  = ${scope.environment}::environment
             AND api_key_id   = ${args.apiKeyId}
             AND bucket       = ${args.bucket}
           FOR UPDATE`)) as unknown as { window_start: string; count: number }[]

        const current = rows[0]
        const decision = evaluateRateLimit({
          policy,
          nowSeconds: args.nowSeconds,
          windowStartSeconds: current ? Number(current.window_start) : null,
          countSoFar: current ? current.count : 0,
        })

        await tx.execute(sql`
          INSERT INTO api_rate_limits
            (workspace_id, environment, api_key_id, bucket, window_start, count)
          VALUES (${scope.workspaceId}, ${scope.environment}::environment, ${args.apiKeyId},
                  ${args.bucket}, to_timestamp(${decision.newWindowStartSeconds}), ${decision.newCount})
          ON CONFLICT (workspace_id, environment, api_key_id, bucket)
          DO UPDATE SET window_start = EXCLUDED.window_start, count = EXCLUDED.count`)

        return decision
      })
    },
  }
}

/** A limiter that permits everything, for suites whose subject is not the limit. */
export function unlimitedRateLimiter(): RateLimiter {
  return {
    async consume(_scope, args) {
      return {
        allowed: true,
        limit: Number.MAX_SAFE_INTEGER,
        remaining: Number.MAX_SAFE_INTEGER,
        resetAtSeconds: args.nowSeconds + 60,
        retryAfterSeconds: 1,
      }
    },
  }
}

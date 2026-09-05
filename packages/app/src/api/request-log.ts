/**
 * The request log — `PRODUCT.md § 13`, *"request logs"*.
 *
 * One row per request that got far enough to have a workspace. The id **is** the
 * `request_id`: it is on every response, in every error envelope and in every
 * structured log line, so it is the one string a customer sends us and the one
 * we look up.
 *
 * **No request body and no response body**, and this is not an oversight. The
 * table is read by developers in a product surface, and a settlement request
 * body carries beneficiary details; `SECURITY.md § 8`'s rule about what may
 * appear in a log does not stop applying because the log has a UI. What the row
 * carries is the shape of the request, its outcome, and the error code if there
 * was one — which is what a developer debugging an integration actually needs,
 * and is enough to find the corresponding audit and event rows.
 *
 * Written in its own transaction after the response is decided, never inside the
 * request's transaction: a request that failed still happened, and a log line
 * that rolls back with the failure it was recording is not a log.
 */
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import type { TenantScope } from '@inrsettle/domain'

export interface RequestLogEntry {
  readonly requestId: string
  readonly apiKeyId: string | null
  readonly method: string
  readonly path: string
  /** The matched route template — what groups rows in the log UI. */
  readonly route: string
  readonly status: number
  readonly errorType?: string | undefined
  readonly errorCode?: string | undefined
  readonly apiVersion: string
  readonly idempotencyKey?: string | undefined
  readonly idempotencyReplayed: boolean
  readonly durationMs: number
}

export async function recordApiRequest(
  db: Db, scope: TenantScope, entry: RequestLogEntry,
): Promise<void> {
  try {
    await withTenant(db, scope, async (tx) => {
      await tx.insert(schema.apiRequests).values({
        id: entry.requestId,
        workspaceId: scope.workspaceId,
        environment: scope.environment,
        apiKeyId: entry.apiKeyId,
        method: entry.method,
        path: entry.path,
        route: entry.route,
        status: entry.status,
        errorType: entry.errorType ?? null,
        errorCode: entry.errorCode ?? null,
        apiVersion: entry.apiVersion,
        idempotencyKey: entry.idempotencyKey ?? null,
        idempotencyReplayed: entry.idempotencyReplayed,
        durationMs: entry.durationMs,
      })
    })
  } catch {
    // The customer already has their response. A failure to write the log must
    // not turn a successful settlement into a 500.
  }
}

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export type Db = PostgresJsDatabase<typeof schema>
export type Environment = 'sandbox' | 'live'

export interface TenantScope {
  workspaceId: string
  environment: Environment
}

export function createClient(connectionString: string, opts: { max?: number } = {}) {
  const sqlClient = postgres(connectionString, { max: opts.max ?? 10, onnotice: () => {} })
  const db = drizzle(sqlClient, { schema })
  return { db, sqlClient, close: () => sqlClient.end({ timeout: 5 }) }
}

/**
 * Every tenant-scoped query runs inside this wrapper.
 *
 * The scope is set from the authenticated principal — never from a request
 * body, header or query parameter (SECURITY.md § 2). The runtime role has no
 * BYPASSRLS, so a caller who forgets this wrapper reads nothing rather than
 * reading everything: RLS default-denies when the settings are absent.
 *
 * The binding goes through `set_tenant_scope` (migration 0012) rather than two
 * `set_config` calls, because that function **refuses to rebind a scope that is
 * already set to something else**. `SET LOCAL` is transaction-scoped, and
 * Drizzle implements a nested transaction as a SAVEPOINT rather than a new
 * connection — so a nested `withTenant` with a different scope used to change
 * the *enclosing* transaction's tenant for everything that followed it, with
 * `WITH CHECK` accepting every write, because the database had been told the
 * caller was somebody else. Re-entering with the same scope is still legal; it
 * is a no-op.
 *
 * READ COMMITTED is a requirement, not a default that happens to be in force.
 * The idempotency claim in `packages/app` depends on a statement-level snapshot
 * to see a row that another transaction committed while this one was blocked on
 * it; at REPEATABLE READ the same insert raises `40001` instead.
 */
export async function withTenant<T>(
  db: Db,
  scope: TenantScope,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_tenant_scope(${scope.workspaceId}, ${scope.environment})`)
    return fn(tx as unknown as Db)
  })
}

/**
 * An unscoped transaction. For provisioning and migrations only, and only from
 * a role that is permitted to see across tenants. Never reachable from a
 * request path — the public API's own pre-authentication lookup uses
 * `withoutScope` below, which is a different thing with a different contract.
 */
export async function withoutTenant<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as Db))
}

/**
 * One statement, outside any transaction, on a connection that must have no
 * tenant scope.
 *
 * This exists for exactly one caller: the public API resolving a bearer key to
 * the workspace and environment that key belongs to, before any scope can be
 * set. It is deliberately *not* `withoutTenant` — that one's contract says
 * "never reachable from a request path", and this one is reachable from every
 * request, so conflating them would have quietly made that comment false.
 *
 * No transaction, because a single `STABLE` function call does not need one and
 * an unauthenticated request should not cost a BEGIN and a COMMIT. The "no
 * scope is set" precondition is enforced by the function itself rather than
 * here, so it holds however the connection was reached.
 */
export async function withoutScope<T>(db: Db, fn: (conn: Db) => Promise<T>): Promise<T> {
  return fn(db)
}

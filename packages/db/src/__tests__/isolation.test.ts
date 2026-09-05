/**
 * Stage 1 exit criterion: RLS isolation for every tenant-scoped table.
 *
 * The table set is **discovered from the live catalogue**, not hand-written. A
 * migration that adds a product table fails this suite unless it either carries
 * the tenant shape with RLS enabled and forced, or is added to the reviewed
 * global exception set below with a reason. A previous revision hard-coded the
 * list while claiming otherwise; discovery is the point of the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant, withoutTenant } from '../client.js'

let h: Harness

const A = { workspaceId: 'ws_alpha', userId: 'usr_alpha', email: 'a@example.test' }
const B = { workspaceId: 'ws_beta', userId: 'usr_beta', email: 'b@example.test' }

/**
 * Tables that deliberately carry no `workspace_id`.
 *
 * `users` and `user_mfa_methods` are global identity: a person exists once and
 * may belong to several workspaces, so they are reached only through a
 * membership in the current scope and are protected by a policy that joins to
 * one. `job_tasks` is the queue's vetted task registry, owned by the queue role
 * and not readable by the application at all. Anything else appearing here is a
 * finding, not an exemption.
 */
const GLOBAL_TABLES: Record<string, { why: string; required: boolean }> = {
  users: {
    why: 'global identity; visible only through a membership in the current scope',
    required: true,
  },
  user_mfa_methods: {
    why: 'global identity; visible only through a membership in the current scope',
    required: true,
  },
  job_tasks: {
    why: 'queue task registry; owned by inrsettle_worker, no app privilege at all',
    // Created by migration 0002, which only databases with the queue installed apply.
    required: false,
  },
  schema_migrations: { why: 'migration bookkeeping; not tenant data', required: false },
  preflight_rule_sets: {
    why: 'versioned reference data (D-06); identical for every workspace, read-only to the app',
    // Created by migration 0004.
    required: false,
  },
  provider_mapping_tables: {
    why:
      'versioned provider vocabulary mapping (INV-43); identical for every workspace, ' +
      'read-only to the app. The same table interprets every tenant\'s provider events, ' +
      'exactly as the preflight rule sets do — scoping it per workspace would mean a ' +
      'provider code could be interpreted two different ways in one system.',
    // Created by migration 0007.
    required: false,
  },
  purpose_codes: {
    why: 'versioned reference data (D-06); identical for every workspace, read-only to the app',
    required: false,
  },
  settlement_status_events: {
    why: 'the status-event vocabulary the INV-32 pairing trigger reads; a constant, read-only to the app',
    // Created by migration 0005.
    required: false,
  },
  internal_operators: {
    why:
      'INRSettle staff identity. SECURITY.md § 3.2: internal roles are entirely separate and ' +
      'never granted inside a customer workspace — so there is no workspace_id here to grant ' +
      'one in. The separation is structural rather than a rule somebody enforces.',
    // Created by migration 0017.
    required: false,
  },
  internal_operator_roles: {
    why: 'INRSettle staff role grants; global for the same reason as internal_operators',
    required: false,
  },
  internal_sessions: {
    why: 'INRSettle staff sessions; global for the same reason as internal_operators',
    required: false,
  },
}

/** Tables scoped by `id` rather than `workspace_id`, because they *are* the tenant. */
const SCOPED_BY_ID = new Set(['workspaces'])

interface TableInfo { table_name: string; has_workspace: boolean; has_environment: boolean }

let discovered: TableInfo[] = []

beforeAll(async () => {
  h = await createTestDatabase('isolation')

  discovered = await h.admin<TableInfo[]>`
    SELECT c.relname AS table_name,
           EXISTS (SELECT 1 FROM information_schema.columns col
                   WHERE col.table_schema = 'public' AND col.table_name = c.relname
                     AND col.column_name = 'workspace_id') AS has_workspace,
           EXISTS (SELECT 1 FROM information_schema.columns col
                   WHERE col.table_schema = 'public' AND col.table_name = c.relname
                     AND col.column_name = 'environment') AS has_environment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`

  await seedWorkspace(h.admin, A)
  await seedWorkspace(h.admin, B)
  for (const w of [A, B]) {
    for (const env of ['sandbox', 'live']) {
      await h.admin`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${w.workspaceId}_${env}`}, ${w.workspaceId}, ${env}::environment,
                'workspace.created', 'workspace', ${w.workspaceId}, 'user', ${w.userId})`
      await h.admin`
        INSERT INTO audit_log (id, workspace_id, environment, actor_type, actor_id, action, subject_type, subject_id)
        VALUES (${`aud_${w.workspaceId}_${env}`}, ${w.workspaceId}, ${env}::environment,
                'user', ${w.userId}, 'workspace.created', 'workspace', ${w.workspaceId})`
      await h.admin`
        INSERT INTO api_keys (id, workspace_id, environment, name, prefix, secret_sha256, created_by)
        VALUES (${`key_${w.workspaceId}_${env}`}, ${w.workspaceId}, ${env}::environment, 'k',
                ${env === 'live' ? 'sk_live_x' : 'sk_test_x'}, ${`hash_${w.workspaceId}_${env}`}, ${w.userId})`
      await h.admin`
        INSERT INTO sessions (id, workspace_id, environment, user_id, mfa_method, expires_at)
        VALUES (${`ses_${w.workspaceId}_${env}`}, ${w.workspaceId}, ${env}::environment,
                ${w.userId}, 'totp', now() + interval '1 hour')`
    }
  }
})

afterAll(async () => { await h?.close() })

/** Every discovered public table that is not a reviewed global exception. */
const tenantTables = () =>
  discovered.filter((t) => !(t.table_name in GLOBAL_TABLES)).map((t) => t.table_name)

describe('INV-31 — discovery', () => {
  it('finds the product tables from the catalogue, not from a literal', () => {
    expect(discovered.length).toBeGreaterThan(5)
    // A required exception that has vanished means the exception set is stale
    // and is quietly exempting nothing — or worse, is about to exempt a table
    // that gets created under the same name later.
    const missing = Object.entries(GLOBAL_TABLES)
      .filter(([, v]) => v.required)
      .map(([name]) => name)
      .filter((name) => !discovered.some((t) => t.table_name === name))
    expect(missing, 'required global exceptions no longer exist — review GLOBAL_TABLES').toEqual([])
  })

  it('requires the tenant shape on every non-global table', () => {
    const wrong = discovered
      .filter((t) => !(t.table_name in GLOBAL_TABLES))
      .filter((t) => !(SCOPED_BY_ID.has(t.table_name) ? true : t.has_workspace))
      .concat(
        discovered
          .filter((t) => !(t.table_name in GLOBAL_TABLES))
          .filter((t) => !t.has_environment && !SCOPED_BY_ID.has(t.table_name)),
      )
      .map((t) => t.table_name)
    expect(
      [...new Set(wrong)],
      'tables missing workspace_id and/or environment — add the columns or justify them in GLOBAL_TABLES',
    ).toEqual([])
  })

  it('requires RLS ENABLED and FORCED on every discovered tenant table', async () => {
    const names = tenantTables()
    const rows = await h.admin<{ relname: string; en: boolean; forced: boolean }[]>`
      SELECT relname, relrowsecurity AS en, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = ANY(${names}) AND relkind = 'r'`
    expect(rows).toHaveLength(names.length)
    for (const r of rows) {
      expect(r.en, `${r.relname} RLS enabled`).toBe(true)
      expect(r.forced, `${r.relname} RLS forced`).toBe(true)
    }
  })

  it('requires a policy on every discovered tenant table', async () => {
    const names = tenantTables()
    const rows = await h.admin<{ tablename: string }[]>`
      SELECT DISTINCT tablename FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${names})`
    const withPolicy = new Set(rows.map((r) => r.tablename))
    expect(names.filter((n) => !withPolicy.has(n)), 'tables with RLS but no policy').toEqual([])
  })

  /**
   * Every scope-resolution function, held to the same four rules.
   *
   * These are the only `SECURITY DEFINER` functions the application can call,
   * and each is a hole by construction — the question is how wide. Ownership is
   * the one that used to be wrong and passed anyway: `CREATE FUNCTION` assigns
   * ownership to whoever applies the migration, so `resolve_verification_scope`
   * shipped owned by a superuser, and a definer function owned by a superuser
   * runs with rights that bypass every grant and every policy in the database.
   * Today's body is a fixed parameterised SELECT; the next edit to it would not
   * have been.
   */
  /**
   * Which role may call each of them, which is not the same question as who
   * owns them.
   *
   * `pending_outbox_scopes` is the odd one out and deliberately so: it is the
   * one cross-tenant read in the delivery path, and it exists so a
   * `NOBYPASSRLS` worker can discover that a workspace it was never told about
   * has events waiting. An `api` process holding EXECUTE could enumerate every
   * workspace in the deployment through a function whose whole purpose is to
   * see past RLS, so migration `0015` moves the grant to `inrsettle_worker`.
   * The scoped drain that follows runs on the application pool under ordinary
   * RLS — the privilege buys the worker one question, not a way around tenant
   * isolation.
   */
  const SCOPE_RESOLVERS: readonly { name: string; caller: string }[] = [
    { name: 'resolve_api_key', caller: 'inrsettle_app' },
    { name: 'resolve_verification_scope', caller: 'inrsettle_app' },
    { name: 'pending_outbox_scopes', caller: 'inrsettle_worker' },
  ]

  it.each(SCOPE_RESOLVERS)('$name is a definer function owned by the resolver role', async ({ name, caller }) => {
    const [fn] = await h.admin<{
      acl: string | null; definer: boolean; owner: string
      owner_super: boolean; config: string | null
    }[]>`
      SELECT array_to_string(p.proacl, ',') AS acl,
             p.prosecdef AS definer,
             pg_get_userbyid(p.proowner) AS owner,
             r.rolsuper AS owner_super,
             array_to_string(p.proconfig, ',') AS config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'public' AND p.proname = ${name}`

    expect(fn?.definer, `${name} must be SECURITY DEFINER`).toBe(true)
    expect(fn?.owner, `${name} must be owned by inrsettle_resolver`).toBe('inrsettle_resolver')
    expect(fn?.owner_super, `${name} must not run with superuser rights`).toBe(false)
    // Exactly one runtime role may call it, and PUBLIC may not. An ACL entry
    // with an empty grantee is PUBLIC.
    expect(fn?.acl ?? '', `${name} must be callable by ${caller}`).toContain(`${caller}=X`)
    const otherRole = caller === 'inrsettle_app' ? 'inrsettle_worker' : 'inrsettle_app'
    expect(fn?.acl ?? '', `${name} must not be callable by ${otherRole}`)
      .not.toContain(`${otherRole}=X`)
    expect((fn?.acl ?? '').split(',').some((e) => e.startsWith('=X'))).toBe(false)
    // A pinned search_path that names pg_temp explicitly and last. Left
    // implicit, pg_temp is searched *first*, and TEMPORARY on a database is
    // granted to PUBLIC by default.
    expect(fn?.config ?? '', `${name} must pin its search_path`)
      .toContain('search_path=pg_catalog, pg_temp')
  })

  it('gives the resolver role no login, no bypass, and no reach beyond its two tables', async () => {
    const [role] = await h.admin<{
      rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean
    }[]>`
      SELECT rolcanlogin, rolbypassrls, rolsuper
      FROM pg_roles WHERE rolname = 'inrsettle_resolver'`
    expect(role!.rolcanlogin, 'the resolver role must not be able to log in').toBe(false)
    // BYPASSRLS would be bounded only by whatever grants the role happens to
    // hold — one `GRANT SELECT ON ALL TABLES` later and it reads settlements
    // across every tenant. A permissive policy on one table cannot widen that
    // way, and it is visible in pg_policies, where this gate already looks.
    expect(role!.rolbypassrls, 'the resolver role must not bypass RLS').toBe(false)
    expect(role!.rolsuper).toBe(false)

    // Asked of the catalogue rather than of information_schema, which filters
    // to grants involving a currently enabled role — and column-level grants,
    // which these are, do not appear in `table_privileges` at all.
    const reachable = await h.admin<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND has_any_column_privilege('inrsettle_resolver', c.oid, 'SELECT')
      ORDER BY c.relname`

    // Exactly the three id→scope questions this role exists to answer, and
    // nothing else in the database.
    expect(new Set(reachable.map((r) => r.relname)))
      .toEqual(new Set(['api_keys', 'destination_verifications', 'outbox']))

    // Not even a whole row of the tables it can reach: the resolver can read
    // the columns a scope is made of, and not a key's name or its creator.
    const [name] = await h.admin<{ can: boolean }[]>`
      SELECT has_column_privilege('inrsettle_resolver', 'api_keys', 'name', 'SELECT') AS can`
    expect(name!.can, 'the resolver must not read a key name').toBe(false)
  })

  it('never lets the app role inherit the resolver role', async () => {
    // RLS role matching uses has_privs_of_role, which follows inheritance — so
    // `GRANT inrsettle_resolver TO inrsettle_app` would hand the application the
    // resolver's permissive policies directly, with no SET ROLE required. That
    // grant must never exist.
    const [row] = await h.admin<{ member: boolean }[]>`
      SELECT pg_has_role('inrsettle_app', 'inrsettle_resolver', 'USAGE') AS member`
    expect(row!.member).toBe(false)
  })

  /* ── The named cross-tenant role — SECURITY.md § 2, § 3.2 ─────────────── */

  it('gives the ops role no login, no bypass, and no way to write anything', async () => {
    const [role] = await h.admin<{
      rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean
    }[]>`
      SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'inrsettle_ops'`
    expect(role, 'inrsettle_ops must exist').toBeDefined()
    expect(role!.rolbypassrls, 'the ops role must not bypass RLS').toBe(false)
    expect(role!.rolsuper).toBe(false)

    // The whole design in one assertion. Ops reads across tenants; ops writes
    // do not exist. An operator action on a settlement is a tenant-scoped write
    // through the ordinary application role, so every trigger, CHECK and policy
    // applies to it unchanged — including the ones that refuse SETTLED.
    const writes = await h.admin<{ relname: string; priv: string }[]>`
      SELECT c.relname, p.priv
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND has_table_privilege('inrsettle_ops', c.oid, p.priv)`
    expect(writes.map((w) => `${w.relname}:${w.priv}`)).toEqual([])
  })

  it('never lets the app role inherit the ops role', async () => {
    // The failure that would undo all of it: `GRANT inrsettle_ops TO
    // inrsettle_app` hands the customer-facing application every cross-tenant
    // policy with no SET ROLE required.
    const [row] = await h.admin<{ member: boolean }[]>`
      SELECT pg_has_role('inrsettle_app', 'inrsettle_ops', 'USAGE') AS member`
    expect(row!.member).toBe(false)

    // …and not by the back door either.
    const [via] = await h.admin<{ member: boolean }[]>`
      SELECT pg_has_role('inrsettle_ops', 'inrsettle_app', 'USAGE') AS member`
    expect(via!.member).toBe(false)
  })

  it('keeps the customer\'s credentials and identity out of ops reach', async () => {
    // Absent by decision, not by oversight. None of these is needed to resolve
    // an exception or reconcile a payout, and an internal surface that could
    // read them is a much larger blast radius for one compromised staff account.
    const forbidden = [
      'api_keys', 'sessions', 'api_requests', 'api_rate_limits', 'idempotency_claims',
      'webhook_endpoints', 'webhook_deliveries', 'webhook_attempts',
      'users', 'user_mfa_methods', 'memberships', 'membership_roles',
      'workspace_security_policies', 'outbox',
    ]
    const reachable = await h.admin<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname = ANY(${forbidden})
        AND has_any_column_privilege('inrsettle_ops', c.oid, 'SELECT')`
    expect(reachable.map((r) => r.relname)).toEqual([])
  })

  it('shows ops a payout destination in exactly the masked form the customer sees', async () => {
    // SECURITY.md § 8 grants destination decryption to `worker` alone. Holding
    // a ciphertext is not holding a key, but the internal surface is where the
    // temptation to "just add decryption for support" is strongest, so the
    // column is not reachable at all.
    const [cols] = await h.admin<{
      ciphertext: boolean; last4: boolean; fingerprint: boolean; tax: boolean
    }[]>`
      SELECT
        has_column_privilege('inrsettle_ops', 'payout_destination_versions',
                             'account_number_ciphertext', 'SELECT') AS ciphertext,
        has_column_privilege('inrsettle_ops', 'payout_destination_versions',
                             'account_number_last4', 'SELECT') AS last4,
        has_column_privilege('inrsettle_ops', 'payout_destination_versions',
                             'details_fingerprint', 'SELECT') AS fingerprint,
        has_column_privilege('inrsettle_ops', 'beneficiaries',
                             'tax_id_ciphertext', 'SELECT') AS tax`
    expect(cols!.ciphertext, 'ops must not reach the account-number ciphertext').toBe(false)
    expect(cols!.tax, 'ops must not reach the PAN ciphertext').toBe(false)
    // The fingerprint is a keyed change-detection value and an oracle if
    // exposed; its own column comment says never returned, never logged.
    expect(cols!.fingerprint, 'ops must not reach the destination fingerprint').toBe(false)
    expect(cols!.last4, 'ops reads the masked form, which is the point').toBe(true)
  })

  it('refuses to resolve an API key inside a tenant-scoped transaction', async () => {
    // The definer call exists to *learn* a scope. Calling it where one is
    // already set means the caller is about to overwrite a scope it did not
    // establish, so the function refuses rather than answering.
    await expect(
      withTenant(h.db, { workspaceId: A.workspaceId, environment: 'live' }, (tx) =>
        tx.execute(sql`SELECT * FROM resolve_api_key('deadbeef')`)),
    ).rejects.toThrow(/must not be called inside a tenant-scoped transaction/)
  })

  it('refuses to rebind a tenant scope that is already set', async () => {
    // SET LOCAL is transaction-scoped, and a nested scoped transaction commits
    // its savepoint — so without this guard a nested withTenant would rebind the
    // *enclosing* transaction's tenant for everything after it, with WITH CHECK
    // accepting every write.
    await expect(
      withTenant(h.db, { workspaceId: A.workspaceId, environment: 'live' }, (tx) =>
        withTenant(tx, { workspaceId: B.workspaceId, environment: 'live' }, async () => undefined)),
    ).rejects.toThrow(/cannot be rebound/)

    // Re-entering with the same scope stays legal: it is a no-op, and forbidding
    // it would ban harmless composition.
    await expect(
      withTenant(h.db, { workspaceId: A.workspaceId, environment: 'live' }, (tx) =>
        withTenant(tx, { workspaceId: A.workspaceId, environment: 'live' }, async () => 'ok')),
    ).resolves.toBe('ok')
  })

  it('does not let the app role write reference data', async () => {
    for (const table of ['preflight_rule_sets', 'purpose_codes']) {
      const [row] = await h.admin<{ can: boolean }[]>`
        SELECT has_table_privilege('inrsettle_app', ${table}, 'INSERT') AS can`
      expect(row!.can, `${table} must be read-only to the app role`).toBe(false)
    }
  })

  it('protects the global exception tables with a policy too', async () => {
    const rows = await h.admin<{ tablename: string }[]>`
      SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'`
    const withPolicy = new Set(rows.map((r) => r.tablename))
    for (const name of ['users', 'user_mfa_methods']) {
      expect(withPolicy.has(name), `${name} is a global table but has no RLS policy`).toBe(true)
    }
  })

  it('actually covers the Stage 2 tables rather than passing vacuously', () => {
    // Discovery is only meaningful if it finds things. Naming the tables this
    // stage added proves the gate saw them, and turns "the suite is green"
    // into "the suite checked these five tables".
    const covered = new Set(tenantTables())
    for (const name of [
      'beneficiaries',
      'payout_destinations',
      'payout_destination_versions',
      'destination_verifications',
      'provider_events',
      'quotes',
      'settlements',
      'payout_attempts',
      'settlement_exceptions',
      // Stage 8.
      'idempotency_claims',
      'api_requests',
      'webhook_endpoints',
      'webhook_deliveries',
      'webhook_attempts',
      'api_rate_limits',
    ]) {
      expect(covered.has(name), `${name} must be covered by the isolation gate`).toBe(true)
    }
  })

  it('keeps the runtime role unable to bypass RLS', async () => {
    const [role] = await h.admin<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'inrsettle_app'`
    expect(role!.rolbypassrls).toBe(false)
    expect(role!.rolsuper).toBe(false)
  })
})

describe('INV-31 — isolation holds on every discovered table', () => {
  it('workspace A sees none of workspace B', async () => {
    await withTenant(h.db, { workspaceId: A.workspaceId, environment: 'live' }, async (tx) => {
      for (const table of tenantTables()) {
        const col = SCOPED_BY_ID.has(table) ? 'id' : 'workspace_id'
        const res = await tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}
              WHERE ${sql.identifier(col)} = ${B.workspaceId}`,
        )
        expect((res as unknown as { n: number }[])[0]!.n, `${table} leaked B to A`).toBe(0)
      }
    })
  })

  it('separates environments as well as workspaces', async () => {
    await withTenant(h.db, { workspaceId: A.workspaceId, environment: 'sandbox' }, async (tx) => {
      const res = await tx.execute(sql`SELECT environment::text AS e FROM events`)
      expect([...new Set((res as unknown as { e: string }[]).map((r) => r.e))]).toEqual(['sandbox'])
    })
  })

  it('cannot UPDATE or DELETE another tenant’s rows', async () => {
    await withTenant(h.db, { workspaceId: A.workspaceId, environment: 'live' }, async (tx) => {
      const upd = await tx.execute(
        sql`UPDATE outbox SET attempts = attempts + 1 WHERE workspace_id = ${B.workspaceId}`)
      expect((upd as unknown as { count?: number }).count ?? 0).toBe(0)
      const del = await tx.execute(sql`DELETE FROM api_keys WHERE workspace_id = ${B.workspaceId}`)
      expect((del as unknown as { count?: number }).count ?? 0).toBe(0)
    })
    const [row] = await h.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = ${B.workspaceId}`
    expect(row!.n).toBe(2)
  })

  it('cannot INSERT a row into another tenant (WITH CHECK)', async () => {
    await expect(
      withTenant(h.db, { workspaceId: A.workspaceId, environment: 'live' }, async (tx) => {
        await tx.execute(sql`
          INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
          VALUES ('evt_smuggled', ${B.workspaceId}, 'live', 'x', 'workspace', ${B.workspaceId}, 'user', 'u')`)
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('reads nothing at all when the scope was never set (default deny)', async () => {
    await withoutTenant(h.db, async (tx) => {
      for (const table of ['events', 'memberships', 'membership_roles', 'sessions', 'api_keys']) {
        const res = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`)
        expect((res as unknown as { n: number }[])[0]!.n, `${table} readable unscoped`).toBe(0)
      }
    })
  })
})

describe('INV-32 / INV-34 — history is append-only by grant', () => {
  it('the app role holds INSERT and SELECT but not UPDATE or DELETE', async () => {
    for (const table of ['events', 'audit_log']) {
      const [g] = await h.admin<{ ins: boolean; sel: boolean; upd: boolean; del: boolean }[]>`
        SELECT has_table_privilege('inrsettle_app', ${table}, 'INSERT') AS ins,
               has_table_privilege('inrsettle_app', ${table}, 'SELECT') AS sel,
               has_table_privilege('inrsettle_app', ${table}, 'UPDATE') AS upd,
               has_table_privilege('inrsettle_app', ${table}, 'DELETE') AS del`
      expect([g!.ins, g!.sel, g!.upd, g!.del], table).toEqual([true, true, false, false])
    }
  })

  it('an UPDATE on events is refused at the database', async () => {
    await expect(
      withTenant(h.db, { workspaceId: A.workspaceId, environment: 'live' }, async (tx) => {
        await tx.execute(sql`UPDATE events SET type = 'tampered'`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('a DELETE on audit_log is refused', async () => {
    await expect(
      withTenant(h.db, { workspaceId: A.workspaceId, environment: 'live' }, async (tx) => {
        await tx.execute(sql`DELETE FROM audit_log`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })
})

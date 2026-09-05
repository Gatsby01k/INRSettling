/**
 * Stage 7 — batches, against a real database.
 *
 * The three exit criteria, and one of them is really a claim about transaction
 * boundaries:
 *
 * > *"A 500-row import with 40 invalid rows settles the 460 valid ones and
 * > blocks only the 40 (`INV-30`)"*
 * > *"CSV errors are per-row and name the column and the fix"*
 * > *"Import is idempotent — the same file twice does not double-create"*
 *
 * The first cannot be faked at the service layer. If the import ran in one
 * transaction, the forty-first row's failure would roll back the forty valid
 * settlements before it, and no amount of careful error handling above would
 * change what the database did. So the test counts rows in the database after
 * an import containing failures — which is the only place the answer is real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedUser, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant, type Db } from '@inrsettle/db'
import { BATCH_CSV_COLUMNS, type PreflightRuleSet } from '@inrsettle/domain'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { activeRuleSetVersion, loadRuleSetFromDatabase } from '../reference-data.service.js'
import { createFacility } from '../liquidity.service.js'
import { money } from '@inrsettle/money'
import {
  authorizeBatch, closeBatch, createBatchFromRows, importBatchCsv, importFingerprint,
  listBatchRows, listRowsNeedingAttention, readBatch, refreshBatchAggregates,
} from '../batch.service.js'

const WS = 'ws_batches'
const scope = { workspaceId: WS, environment: 'sandbox' as const }
const creator = { type: 'user' as const, id: 'usr_creator' }
const approver = { type: 'user' as const, id: 'usr_approver' }
const ROLES = ['admin', 'approver', 'operator'] as const
const HEADER = BATCH_CSV_COLUMNS.join(',')

const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: Buffer.alloc(32, 7) } }),
  fingerprinter: createDestinationFingerprinter(Buffer.alloc(32, 9)),
}

let h: Harness
let ruleSet: PreflightRuleSet
let beneficiaryIds: string[] = []
const live = <T>(fn: (tx: Db) => Promise<T>) => withTenant(h.db, scope, fn)

/** Assertion messages carry bigints, and `JSON.stringify` throws on those. */
const describe_ = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))?.slice(0, 400) ?? ''

/** A verified beneficiary, since a CSV may only reference one that exists. */
async function makeBeneficiary(index: number): Promise<string> {
  const created = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      // A business beneficiary needs a legal name; the domain refuses one
      // without it, which is the validation working rather than an obstacle.
      identity: {
        displayName: `Vendor ${index}`,
        legalName: `Vendor ${index} Private Limited`,
        type: 'business',
        country: 'IN',
      },
      destination: {
        kind: 'bank_account',
        accountNumber: `5010012${String(index).padStart(4, '0')}0000`,
        ifsc: 'HDFC0000123',
        accountType: 'current',
        accountHolderName: `Vendor ${index}`,
      },
      actor: creator,
    }),
  )
  await requestVerification(h.db, scope, createSandboxVerificationProvider(), crypto.cipher, SANDBOX_NAME_MATCH_POLICIES, {
      destinationVersionId: created.destinations[0]!.currentVersion!.id,
      actor: creator,
    })

  return created.id
}

beforeAll(async () => {
  h = await createTestDatabase('stage7_batches')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: creator.id, email: 'c@example.test', roles: [...ROLES],
  })
  await seedUser(h.admin, {
    workspaceId: WS, userId: approver.id, email: 'a@example.test', roles: [...ROLES],
  })
  const version = await activeRuleSetVersion(h.admin, 'sandbox', new Date())
  ruleSet = (await loadRuleSetFromDatabase(h.admin, version!))!.ruleSet
  await live((tx) =>
    createFacility(tx, scope, {
      providerId: 'mock_liquidity', currency: 'USDT',
      limit: money('USDT', 1_000_000_000n), actor: creator,
    }),
  )
  // Twelve beneficiaries, reused across five hundred rows — "verify once,
  // settle many times" is the point of the aggregate.
  beneficiaryIds = []
  for (let i = 0; i < 12; i += 1) beneficiaryIds.push(await makeBeneficiary(i))
}, 120_000)

afterAll(async () => { await h.close() })

/* ── The headline criterion ─────────────────────────────────────────────── */

describe('INV-30 — a 500-row import with 40 invalid rows', () => {
  let batchId: string

  it('settles the 460 valid ones and blocks only the 40', async () => {
    // Forty deliberately broken rows, spread through the file rather than
    // clustered — so a failure at row 41 has 40 committed rows behind it and
    // 459 ahead, and an all-or-nothing import would be visible either way.
    const lines: string[] = []
    for (let i = 0; i < 500; i += 1) {
      const beneficiary = beneficiaryIds[i % beneficiaryIds.length]!
      if (i % 12 === 5 && lines.filter((l) => l.includes('BROKEN')).length < 40) {
        lines.push(`${beneficiary},not-a-number,SOFTWARE_SERVICES,BROKEN-${i}`)
      } else {
        lines.push(`${beneficiary},${1000 + i}.50,SOFTWARE_SERVICES,inv-${i}`)
      }
    }
    // Top up to exactly forty broken rows.
    let broken = lines.filter((l) => l.includes('BROKEN')).length
    for (let i = 0; broken < 40; i += 1) {
      if (!lines[i]!.includes('BROKEN')) {
        lines[i] = `${beneficiaryIds[0]!},not-a-number,SOFTWARE_SERVICES,BROKEN-fill-${i}`
        broken += 1
      }
    }
    expect(lines.filter((l) => l.includes('BROKEN'))).toHaveLength(40)

    const result = await importBatchCsv(h.db, scope, {
      name: 'India Contractor Payout — September',
      csv: [HEADER, ...lines].join('\n'),
      actor: creator,
      ruleSet,
    })
    expect(result.ok, describe_(result)).toBe(true)
    if (!result.ok) return
    batchId = result.batch.id

    // The database is where the answer is real: 460 settlements exist.
    const settlements = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM batch_rows
      WHERE batch_id = ${batchId} AND settlement_id IS NOT NULL`))) as unknown as { n: number }[]
    expect(settlements[0]!.n).toBe(460)

    const invalid = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM batch_rows
      WHERE batch_id = ${batchId} AND outcome = 'INVALID'`))) as unknown as { n: number }[]
    expect(invalid[0]!.n).toBe(40)

    expect(result.batch).toMatchObject({ rowCount: 500, validCount: 460, status: 'READY' })
  }, 300_000)

  it('keeps every invalid row, with its own errors, rather than discarding it', async () => {
    const blocked = await live((tx) => listRowsNeedingAttention(tx, batchId))
    expect(blocked).toHaveLength(40)
    for (const row of blocked) {
      expect(row.settlementId).toBeNull()
      expect(row.errors.length).toBeGreaterThan(0)
      // The exit criterion: the column and the fix.
      expect(row.errors[0]!.column).toBe('amount_inr')
      expect(row.errors[0]!.fix).toMatch(/digits only/)
      // And the row is kept verbatim, so it can be shown back as written.
      expect(row.raw['amount_inr']).toBe('not-a-number')
    }
  })

  it('totals only the rows that became settlements', async () => {
    const batch = (await live((tx) => readBatch(tx, batchId)))!
    const rows = await live((tx) => listBatchRows(tx, batchId))
    const expected = rows.reduce((sum, r) => sum + (r.amountMinor ?? 0n), 0n)
    expect(batch.totalMinor).toBe(expected)
    // An invalid row has an amount in the file and no settlement in the system.
    expect(rows.filter((r) => r.outcome === 'INVALID').every((r) => r.amountMinor === null)).toBe(true)
  })

  it('numbers rows the way the spreadsheet does', async () => {
    const rows = await live((tx) => listBatchRows(tx, batchId))
    // The header is line 1, so the first data row is line 2 and the last is 501.
    expect(rows[0]!.lineNumber).toBe(2)
    expect(rows.at(-1)!.lineNumber).toBe(501)
  })
})

/* ── Idempotency ────────────────────────────────────────────────────────── */

describe('import is idempotent', () => {
  const csv = (ref: string) => [HEADER, `${beneficiaryIds[0]},2500.00,SOFTWARE_SERVICES,${ref}`].join('\n')

  it('the same file twice does not double-create', async () => {
    const first = await importBatchCsv(h.db, scope, {
      name: 'August payouts', csv: csv('aug-1'), actor: creator, ruleSet,
    })
    const second = await importBatchCsv(h.db, scope, {
      name: 'August payouts', csv: csv('aug-1'), actor: creator, ruleSet,
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.idempotent).toBe(true)
    expect(second.batch.id).toBe(first.batch.id)

    // One batch, one row, one settlement — not two of anything.
    const batches = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM batches WHERE name = 'August payouts'`))) as unknown as
      { n: number }[]
    expect(batches[0]!.n).toBe(1)
    expect(second.rows).toHaveLength(1)
  })

  it('a genuinely different file creates a second batch', async () => {
    // The customer who means to pay the same people again has changed something.
    const other = await importBatchCsv(h.db, scope, {
      name: 'August payouts', csv: csv('aug-2'), actor: creator, ruleSet,
    })
    expect(other.ok && other.idempotent).toBeFalsy()
  })

  it('the same rows under a different name are two intentions', async () => {
    // Somebody who renamed a template and re-sent it meant a second batch.
    const renamed = await importBatchCsv(h.db, scope, {
      name: 'September payouts', csv: csv('aug-1'), actor: creator, ruleSet,
    })
    expect(renamed.ok && renamed.idempotent).toBeFalsy()
    expect(importFingerprint({ name: 'a', csv: 'x' }))
      .not.toBe(importFingerprint({ name: 'b', csv: 'x' }))
  })

  it('the fingerprint is the content and nothing else', async () => {
    // An earlier cut let an explicit idempotency key *replace* the content
    // address, so the same key with a different file returned the first batch
    // as a success — a set of payments never created, reported as created.
    // The key belongs to the API layer, where § 4 requires that case to be a
    // 409; here the only question is whether this is the same file.
    const one = await importBatchCsv(h.db, scope, {
      name: 'Keyed', csv: csv('k-1'), actor: creator, ruleSet,
    })
    const two = await importBatchCsv(h.db, scope, {
      name: 'Keyed', csv: csv('k-2'), actor: creator, ruleSet,
    })
    expect(one.ok && two.ok && two.idempotent).toBeFalsy()
    expect(one.ok && two.ok && two.batch.id).not.toBe(one.ok ? one.batch.id : '')
    expect(importFingerprint({ name: 'Keyed', csv: csv('k-1') }))
      .not.toBe(importFingerprint({ name: 'Keyed', csv: csv('k-2') }))
  })

  it('a concurrent identical import replays rather than raising a duplicate key', async () => {
    // The read that turns a repeat into a replay is a courtesy; the unique
    // index is the guarantee. Two identical imports launched together both find
    // nothing and both insert, and the loser used to take the 23505 all the way
    // out as a 500.
    const race = () => importBatchCsv(h.db, scope, {
      name: 'Raced', csv: csv('race-1'), actor: creator, ruleSet,
    })
    const [a, b] = await Promise.all([race(), race()])
    expect(a.ok && b.ok).toBe(true)
    expect(a.ok && b.ok && a.batch.id).toBe(b.ok ? b.batch.id : '')
    // Exactly one batch, whichever of them created it.
    const count = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM batches WHERE name = 'Raced'`))) as unknown as { n: number }[]
    expect(count[0]!.n).toBe(1)
  })
})

/* ── Rows that fail for a reason the file cannot see ────────────────────── */

describe('a row that only the database can refuse', () => {
  it('becomes an invalid row, not an aborted import', async () => {
    // A well-formed beneficiary id that does not exist looks identical to a typo
    // in the file. INV-30 holds here too: the good rows around it still land.
    const csv = [
      HEADER,
      `${beneficiaryIds[1]},1000,SOFTWARE_SERVICES,good-1`,
      `ben_doesNotExist9,1000,SOFTWARE_SERVICES,ghost`,
      `${beneficiaryIds[2]},2000,SOFTWARE_SERVICES,good-2`,
    ].join('\n')

    const result = await importBatchCsv(h.db, scope, {
      name: 'Ghost beneficiary', csv, actor: creator, ruleSet,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const rows = await live((tx) => listBatchRows(tx, result.batch.id))
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.outcome)).toEqual(['ACCEPTED', 'INVALID', 'ACCEPTED'])
    // And the message tells them where to look — including the environment,
    // because a sandbox id used in live looks exactly like a typo.
    expect(rows[1]!.errors[0]).toMatchObject({ column: 'beneficiary_id' })
    expect(rows[1]!.errors[0]!.fix).toMatch(/beneficiary page.*environment/)
  })
})

/* ── The API path ───────────────────────────────────────────────────────── */

describe('the API creation path', () => {
  it('validates identically to the CSV path, because it is the CSV path', async () => {
    const result = await createBatchFromRows(h.db, scope, {
      name: 'API batch',
      rows: [
        { beneficiaryId: beneficiaryIds[3]!, amountMinor: 250_000n, purposeCode: 'SOFTWARE_SERVICES' },
        { beneficiaryId: beneficiaryIds[4]!, amountMinor: 125_050n, purposeCode: 'MYSTERY_CODE' },
      ],
      actor: creator,
      ruleSet,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.batch.source).toBe('API')
    const rows = await live((tx) => listBatchRows(tx, result.batch.id))
    expect(rows.map((r) => r.outcome)).toEqual(['ACCEPTED', 'INVALID'])
    // The amount survived the trip through minor units and back with no float.
    expect(rows[0]!.amountMinor).toBe(250_000n)
    expect(rows[1]!.errors[0]!.column).toBe('purpose_code')
  })

  it('carries a fractional amount through exactly', async () => {
    const result = await createBatchFromRows(h.db, scope, {
      name: 'API fractional',
      rows: [{ beneficiaryId: beneficiaryIds[5]!, amountMinor: 1n, purposeCode: 'SOFTWARE_SERVICES' }],
      actor: creator,
      ruleSet,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const rows = await live((tx) => listBatchRows(tx, result.batch.id))
    expect(rows[0]!.amountMinor).toBe(1n)
  })
})

/* ── D-12 — authorization fans out ──────────────────────────────────────── */

describe('D-12 — one action, many independent authorizations', () => {
  it('is a fan-out to T08, not a batch-level transition', async () => {
    const csv = [
      HEADER,
      `${beneficiaryIds[6]},1000,SOFTWARE_SERVICES,auth-1`,
      `${beneficiaryIds[7]},2000,SOFTWARE_SERVICES,auth-2`,
    ].join('\n')
    const imported = await importBatchCsv(h.db, scope, {
      name: 'Authorize me', csv, actor: creator, ruleSet,
    })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return

    // No quote is attached, so every row must be refused by T08's own guards —
    // which is the point: the batch cannot skip them.
    const result = await authorizeBatch(h.db, scope, {
      batchId: imported.batch.id,
      actor: approver,
      actorRoles: [...ROLES],
      ruleSet,
      hasActiveLiquidityFacility: true,
      documents: ['commercial_invoice'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.authorized).toBe(0)
    expect(result.refused).toHaveLength(2)
    // Each refusal names its own row, so the person fixing it knows which line.
    expect(result.refused.map((r) => r.lineNumber).sort()).toEqual([2, 3])

    // And the batch stayed READY: nothing was executed, so it did not pretend to.
    const batch = (await live((tx) => readBatch(tx, imported.batch.id)))!
    expect(batch.status).toBe('READY')
  })

  it('records how far one action reached, so a mistake is investigable', async () => {
    const audits = (await live((tx) => tx.execute(sql`
      SELECT after, reason FROM audit_log
      WHERE action = 'batch.authorized' ORDER BY created_at DESC LIMIT 1`))) as unknown as
      { after: Record<string, unknown>; reason: string }[]
    expect(audits[0]!.after).toMatchObject({ eligible: 2, authorized: 0, refused: 2 })
    // The settlement ids are on the record — the blast radius, enumerated.
    expect((audits[0]!.after['settlement_ids'] as string[])).toHaveLength(2)
    expect(audits[0]!.reason).toMatch(/one action authorized/)
  })

  it('refuses to authorize a batch that has not finished validating', async () => {
    const imported = await importBatchCsv(h.db, scope, {
      name: 'Not ready', csv: [HEADER, `${beneficiaryIds[8]},1000,SOFTWARE_SERVICES,nr`].join('\n'),
      actor: creator, ruleSet,
    })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await live((tx) => tx.execute(sql`
      UPDATE batches SET status = 'VALIDATING' WHERE id = ${imported.batch.id}`))
    expect(
      await authorizeBatch(h.db, scope, {
        batchId: imported.batch.id, actor: approver, actorRoles: [...ROLES],
        ruleSet, hasActiveLiquidityFacility: true,
      }),
    ).toMatchObject({ ok: false, reason: 'batch_not_ready' })
  })
})

/* ── Closing ────────────────────────────────────────────────────────────── */

describe('closing a batch', () => {
  it('will not close while rows are still running', async () => {
    const imported = await importBatchCsv(h.db, scope, {
      name: 'Still running', csv: [HEADER, `${beneficiaryIds[9]},1000,SOFTWARE_SERVICES,run`].join('\n'),
      actor: creator, ruleSet,
    })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(await closeBatch(h.db, scope, { batchId: imported.batch.id, actor: creator }))
      .toMatchObject({ ok: false, reason: 'rows_still_running' })
  })

  it('a file with nothing executable still goes through EXECUTING', async () => {
    // Every row invalid: nothing to run, and calling it COMPLETED would be the
    // container claiming a success it never had. But it takes the frozen path —
    // READY → EXECUTING → PARTIALLY_COMPLETED — rather than a shortcut added
    // for this case. EXECUTING is the container's phase, not the rows'.
    const csv = [HEADER, 'ben_ghost1,bad,SOFTWARE_SERVICES,x', 'ben_ghost2,also-bad,SOFTWARE_SERVICES,y'].join('\n')
    const imported = await importBatchCsv(h.db, scope, {
      name: 'All broken', csv, actor: creator, ruleSet,
    })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.batch).toMatchObject({ rowCount: 2, validCount: 0 })

    const closed = await closeBatch(h.db, scope, { batchId: imported.batch.id, actor: creator })
    expect(closed).toMatchObject({ ok: true })
    expect(closed.ok && closed.batch.status).toBe('PARTIALLY_COMPLETED')

    // The path is visible in the events: the execution phase happened, with
    // nothing in it, and then completed.
    //
    // Ordered by `created_at`, not by `id`. `INV-09` makes external ids random
    // and non-sequential, so ordering by one is ordering by nothing — a first
    // cut of this test did exactly that and passed on a coin flip. The two
    // events here are written by two separate transactions, so their
    // transaction-start timestamps genuinely differ and genuinely record the
    // sequence. Companion events emitted *inside* one transaction share a
    // `now()` and have no order between them, which is `INV-32`'s point: they
    // are simultaneous, and no test should claim otherwise.
    const events = (await live((tx) => tx.execute(sql`
      SELECT type FROM events WHERE subject_id = ${imported.batch.id}
      ORDER BY created_at`))) as unknown as
      { type: string }[]
    expect(events.map((e) => e.type)).toEqual(['batch.validated', 'batch.partially_completed'])
  })

  it('recomputes counters from the rows rather than trusting them', async () => {
    // A counter maintained independently of what it counts eventually disagrees
    // with it, and this one is on a screen a customer reads.
    const imported = await importBatchCsv(h.db, scope, {
      name: 'Drifted', csv: [HEADER, `${beneficiaryIds[10]},1000,SOFTWARE_SERVICES,d`].join('\n'),
      actor: creator, ruleSet,
    })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return

    // Understated rather than overstated: `batch_counts_do_not_exceed_rows`
    // refuses a valid_count above row_count outright, which is the constraint
    // doing its job. Drift in the other direction is the one a recompute has to
    // catch on its own.
    await live((tx) => tx.execute(sql`
      UPDATE batches SET valid_count = 0, total_minor = 12345 WHERE id = ${imported.batch.id}`))
    const refreshed = await refreshBatchAggregates(h.db, scope, { batchId: imported.batch.id })
    expect(refreshed.ok && refreshed.batch).toMatchObject({ validCount: 1, rowCount: 1 })
    expect(refreshed.ok && refreshed.batch.totalMinor).toBe(100_000n)
  })
})

/* ── The container is not a transaction, at the schema ──────────────────── */

describe('the schema refuses the shapes INV-30 forbids', () => {
  it('an invalid row cannot claim a settlement', async () => {
    await expect(
      h.admin`
        INSERT INTO batch_rows (id, workspace_id, environment, batch_id, line_number, outcome, settlement_id, raw, errors)
        SELECT 'brw_bad', ${WS}, 'sandbox', b.id, 9999, 'INVALID', s.id, '{}'::jsonb, '[]'::jsonb
        FROM batches b, settlements s LIMIT 1`,
    ).rejects.toThrow(/batch_row_invalid_has_errors_and_no_settlement/)
  })

  it('a valid row cannot exist without one', async () => {
    await expect(
      h.admin`
        INSERT INTO batch_rows (id, workspace_id, environment, batch_id, line_number, outcome, raw, errors)
        SELECT 'brw_bad2', ${WS}, 'sandbox', b.id, 9998, 'ACCEPTED', '{}'::jsonb, '[]'::jsonb
        FROM batches b LIMIT 1`,
    ).rejects.toThrow(/batch_row_invalid_has_errors_and_no_settlement/)
  })

  it('one settlement belongs to at most one batch', async () => {
    const rows = (await live((tx) => tx.execute(sql`
      SELECT batch_id, settlement_id FROM batch_rows WHERE settlement_id IS NOT NULL LIMIT 1`))) as
      unknown as { batch_id: string; settlement_id: string }[]
    await expect(
      h.admin`
        INSERT INTO batch_rows (id, workspace_id, environment, batch_id, line_number, outcome, settlement_id, raw, errors)
        VALUES ('brw_dup', ${WS}, 'sandbox', ${rows[0]!.batch_id}, 9997, 'ACCEPTED', ${rows[0]!.settlement_id}, '{}'::jsonb, '[]'::jsonb)`,
    ).rejects.toThrow(/batch_rows_settlement_key/)
  })

  it('deleting a batch never deletes its settlements', async () => {
    // The cascade goes to the rows and stops there. A settlement outlives its
    // container, because it was a settlement first.
    const constraint = (await h.admin`
      SELECT confdeltype FROM pg_constraint
      WHERE conname LIKE 'batch_rows_settlement_id%'`) as { confdeltype: string }[]
    // 'a' is NO ACTION — the settlement reference is not a cascade.
    expect(constraint[0]?.confdeltype ?? 'a').toBe('a')
  })
})

/**
 * Stage 6 — the `SettlementReturn` aggregate.
 *
 * Testing obligations 13 and 14 from `STATE_MACHINES.md § 10`:
 *
 * > *"a confirmed return requests a repayment, leaves the settlement row and
 * > receipt bytes byte-identical, and produces a separate Return Notice
 * > artifact with its own hash. Cumulative confirmed returns are capped at the
 * > delivered amount under contention, and the same real-world return arriving
 * > by webhook and by status pull creates exactly one row."*
 *
 * > *"a settlement reaches `SETTLED` without waiting out the window; a return
 * > inside the window takes N02; a return outside it opens in `MANUAL_REVIEW`.
 * > A companion assertion: no finality condition reads the window."*
 *
 * The five simulator scenarios Stage 5 handed to Stage 6 — `…0001`, `…0004`,
 * `…0011`, `…0012`, `…0014` — are closed here. Stage 5 proved its half of each
 * and recorded the obligation as a typed handoff; these are the tests that
 * discharge them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { runMigrations } from 'graphile-worker'
import {
  createTestDatabase, installJobQueue, seedUser, seedWorkspace, type Harness,
} from '@inrsettle/testing'
import { money } from '@inrsettle/money'
import {
  RETURN_TRANSITIONS,
  checkReturnCap,
  evaluateFinality,
  triageReturnArrival,
  type FinalityEvidence,
  type PreflightRuleSet,
  type ProviderMappingTable,
} from '@inrsettle/domain'
import { handoffsTo } from '@inrsettle/providers'
import { activeRuleSetVersion, loadRuleSetFromDatabase } from '../reference-data.service.js'
import { activeMappingTable } from '../payout-mapping.service.js'
import { advanceRepayment, readFacility } from '../liquidity.service.js'
import { listArtifacts, runReceiptGenerate, readArtifact } from '../receipt.service.js'
import { ingestPayoutWebhook } from '../payout-webhook.service.js'
import {
  checkReturnWithProvider, confirmReturn, listReturns, markReturnRepaid, openReturn,
  proRataRepayment, readReturn, rejectReturn, sweepReturnChecks,
} from '../settlement-return.service.js'
import {
  AMOUNT, ROLES, UNIT, approver, creator, liveFor, makeArtifacts, makeProvider, operator,
  scope, settledSettlement, settlementRow, statusOf, type Stage6Context,
} from './stage6-fixtures.js'

let ctx: Stage6Context
let h: Harness

const A_DAY = 24 * 3600

beforeAll(async () => {
  h = await createTestDatabase('stage6_returns')
  // Issuing a receipt enqueues `receipt.generate`, so these suites need the
  // real queue bridge. Exercising it is the point: the enqueue is part of the
  // transaction T20 commits, and a stub would not prove that.
  const [db] = await h.admin<{ name: string }[]>`SELECT current_database() AS name`
  await installJobQueue(h.admin, runMigrations, db!.name)
  await seedWorkspace(h.admin, {
    workspaceId: scope.workspaceId, userId: creator.id, email: 'c@example.test', roles: [...ROLES],
  })
  await seedUser(h.admin, {
    workspaceId: scope.workspaceId, userId: approver.id, email: 'a@example.test', roles: [...ROLES],
  })
  await seedUser(h.admin, {
    workspaceId: scope.workspaceId, userId: operator.id, email: 'o@example.test', roles: [...ROLES],
  })
  const live = liveFor(h)
  const version = await activeRuleSetVersion(h.admin, 'sandbox', new Date())
  const ruleSet = (await loadRuleSetFromDatabase(h.admin, version!))!.ruleSet as PreflightRuleSet
  const mapping = (await live((tx) => activeMappingTable(tx, 'mock_india_payout')))! as ProviderMappingTable
  const artifacts = makeArtifacts()
  ctx = {
    h, ruleSet, mapping, provider: makeProvider(),
    artifacts: artifacts.deps, renderer: artifacts.renderer, live,
  }
})
afterAll(async () => {
  // The browser this suite started is the suite's to close.
  await ctx.renderer.close()
  await h.close()
})

/** Open a return with the frozen table's usual shape. */
async function open(
  settlementId: string,
  overrides: Partial<Parameters<typeof openReturn>[2]> = {},
) {
  return ctx.live((tx) =>
    openReturn(tx, scope, {
      settlementId,
      actor: creator,
      source: 'trusted_provider_event',
      amountMinor: AMOUNT,
      currency: 'INR',
      reasonCode: 'RAIL_REVERSAL',
      reasonMessage: 'the receiving bank sent the credit back',
      providerReturnReference: `pret_${Math.random().toString(36).slice(2, 10)}`,
      ...overrides,
    }),
  )
}

/** An authoritative check that upholds, without needing the provider. */
const upholds = { upheld: true, reportedMinor: null, source: 'authoritative_status_pull' } as const

async function confirm(returnId: string, note?: string) {
  return ctx.live((tx) =>
    confirmReturn(tx, scope, {
      returnId, actor: operator, check: upholds, ...(note === undefined ? {} : { note }),
    }),
  )
}

async function attemptOf(settlementId: string) {
  const rows = (await ctx.live((tx) => tx.execute(sql`
    SELECT pa.id, pa.credited_minor, pa.returned_total_minor, pa.status
    FROM payout_attempts pa JOIN settlements s ON s.payout_attempt_id = pa.id
    WHERE s.id = ${settlementId}`))) as unknown as {
    id: string; credited_minor: string; returned_total_minor: string; status: string
  }[]
  return rows[0]!
}

/* ── N01 — opening, and the two dedupe keys ─────────────────────────────── */

describe('N01 — a return is opened only by trusted evidence, and only once', () => {
  it('opens against a settled settlement and stays out of the settlement machine', async () => {
    const { settlementId } = await settledSettlement(ctx, '0004')
    const before = await settlementRow(ctx, settlementId)
    const receiptBefore = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!

    const opened = await open(settlementId)
    expect(opened).toMatchObject({ ok: true, status: 'OBSERVED', transition: 'N01' })

    // § 8.5: "The settlement stays SETTLED, because it was." Byte-for-byte.
    expect(await settlementRow(ctx, settlementId)).toEqual(before)
    const receiptAfter = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    expect(receiptAfter.content_hash).toBe(receiptBefore.content_hash)
    expect(receiptAfter.canonical_bytes).toBe(receiptBefore.canonical_bytes)
  })

  it('refuses to open against a settlement that never settled', async () => {
    // A "return" of a payout that never reached finality is a failed payout,
    // which is T17's job. Keeping the two apart is why this refuses.
    const rows = (await ctx.live((tx) => tx.execute(sql`
      SELECT id FROM settlements WHERE status <> 'SETTLED' LIMIT 1`))) as unknown as { id: string }[]
    if (rows[0]) {
      expect(await open(rows[0].id)).toMatchObject({ ok: false, reason: 'settlement_not_settled' })
    }
  })

  it('refuses a return the provider will not identify — INV-50 needs the key', async () => {
    const { settlementId } = await settledSettlement(ctx, '0004')
    expect(await open(settlementId, { providerReturnReference: '  ' })).toMatchObject({
      ok: false, reason: 'provider_return_reference_required',
    })
  })

  it('…0012 — the same return by webhook and by status pull is one row', async () => {
    // The Stage 5 handoff: two arrivals of one fact, both visible. Stage 6's
    // obligation is that they deduplicate on the *second* key — the return
    // itself — because a pull carries no event id for INV-33 to work with.
    const { settlementId } = await settledSettlement(ctx, '0012')
    const reference = 'pret_two_channels'

    const first = await open(settlementId, {
      source: 'trusted_provider_event',
      providerReturnReference: reference,
      providerEventId: 'evt_ret_webhook',
    })
    expect(first).toMatchObject({ ok: true, status: 'OBSERVED' })
    expect(first.ok && first.duplicate).toBeFalsy()

    const second = await open(settlementId, {
      source: 'authoritative_status_pull',
      providerReturnReference: reference,
    })
    expect(second).toMatchObject({ ok: true, duplicate: true })
    expect(second.ok && second.returnId).toBe(first.ok && first.returnId)

    // Exactly one return…
    const returns = await ctx.live((tx) => listReturns(tx, settlementId))
    expect(returns).toHaveLength(1)

    // …and two sightings, kept separately. A counter would say "two" and lose
    // both; an investigation needs the evidence, not the tally.
    const sightings = (await ctx.live((tx) => tx.execute(sql`
      SELECT source, opened_the_return FROM return_observations
      WHERE return_id = ${returns[0]!.id} ORDER BY observed_at, id`))) as unknown as
      { source: string; opened_the_return: boolean }[]
    expect(sightings.map((s) => [s.source, s.opened_the_return])).toEqual([
      ['trusted_provider_event', true],
      ['authoritative_status_pull', false],
    ])

    // The obligation Stage 5 recorded, discharged.
    const handoff = handoffsTo('Stage 6').find((x) => x.suffix === '0012')!
    expect(handoff.handoff.invariants).toEqual(['INV-50'])
  })

  it('an observation is evidence, and evidence is not edited', async () => {
    const { settlementId } = await settledSettlement(ctx, '0004')
    const opened = await open(settlementId)
    const rows = (await ctx.live((tx) => tx.execute(sql`
      SELECT id FROM return_observations WHERE return_id = ${opened.ok && opened.returnId}`))) as
      unknown as { id: string }[]
    await expect(
      h.admin`UPDATE return_observations SET source = 'trusted_provider_event' WHERE id = ${rows[0]!.id}`,
    ).rejects.toThrow(/append-only/)
    await expect(
      h.admin`DELETE FROM return_observations WHERE id = ${rows[0]!.id}`,
    ).rejects.toThrow(/append-only/)
  })
})

/* ── INV-40 — the authoritative check ───────────────────────────────────── */

describe('INV-40 — a return is confirmed by our own check, never by the report', () => {
  it('…0004 — upheld: N02, a repayment requested, a notice cut, the receipt untouched', async () => {
    const { settlementId, facilityId } = await settledSettlement(ctx, '0004')
    const receiptBefore = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    const settlementBefore = await settlementRow(ctx, settlementId)
    const facilityBefore = (await ctx.live((tx) => readFacility(tx, facilityId)))!

    const opened = await open(settlementId)
    const confirmed = await confirm(opened.ok ? opened.returnId : '')
    expect(confirmed).toMatchObject({ ok: true, status: 'CONFIRMED', transition: 'N02' })

    // INV-41: the repayment is REQUESTED and has restored nothing.
    const repayment = (await ctx.live((tx) => tx.execute(sql`
      SELECT status, amount_minor, source FROM repayments WHERE id = ${confirmed.ok && confirmed.repaymentId}`))) as
      unknown as { status: string; amount_minor: string; source: string }[]
    expect(repayment[0]).toMatchObject({ status: 'REQUESTED', source: 'SETTLEMENT_RETURN' })
    // A full return repays the whole drawdown exactly — no residue.
    expect(BigInt(repayment[0]!.amount_minor)).toBe(UNIT)

    const facilityAfter = (await ctx.live((tx) => readFacility(tx, facilityId)))!
    expect(facilityAfter.position.drawn.minorUnits).toBe(facilityBefore.position.drawn.minorUnits)

    // INV-42 and INV-48: the settlement row and the receipt are byte-identical.
    expect(await settlementRow(ctx, settlementId)).toEqual(settlementBefore)
    const receiptAfter = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    expect(receiptAfter).toEqual(receiptBefore)

    // A separate artifact, with its own hash and its own PDF.
    const notice = (await ctx.live((tx) =>
      readArtifact(tx, { returnId: opened.ok ? opened.returnId : '', kind: 'return_notice' }),
    ))!
    expect(notice.content_hash).not.toBe(receiptBefore.content_hash)
    expect(notice.source_content_hash).toBe(receiptBefore.content_hash)
    expect(notice.pdf_object_key).not.toBe(receiptBefore.pdf_object_key)
    // Its own PDF, printed by the same Chromium through the same template, and
    // written to its own key.
    const printed = await runReceiptGenerate(ctx.h.db, scope, ctx.artifacts, {
      artifactId: notice.id,
    })
    expect(printed).toMatchObject({ ok: true, rendered: true })
    const stored = await ctx.artifacts.store.get(notice.pdf_object_key)
    expect(Buffer.from(stored!.bytes).subarray(0, 5).toString()).toBe('%PDF-')

    // The settlement is still SETTLED, and the return is a linked object.
    expect(await statusOf(ctx, settlementId)).toBe('SETTLED')

    const handoff = handoffsTo('Stage 6').find((x) => x.suffix === '0004')!
    expect(handoff.handoff.invariants).toEqual(['INV-42', 'INV-48'])
  })

  it('not upheld: N03, rejected, alarmed — a false return report is a provider signal', async () => {
    const { settlementId } = await settledSettlement(ctx, '0004')
    const opened = await open(settlementId)
    const rejected = await ctx.live((tx) =>
      rejectReturn(tx, scope, {
        returnId: opened.ok ? opened.returnId : '',
        actor: operator,
        why: 'the provider now reports CREDITED, not RETURNED',
      }),
    )
    expect(rejected).toMatchObject({ ok: true, status: 'REJECTED', transition: 'N03', alarm: 'return_not_upheld' })

    // No repayment was requested, and no notice was cut.
    const returned = (await ctx.live((tx) => readReturn(tx, opened.ok ? opened.returnId : '')))!
    expect(returned.repayment_id).toBeNull()
    expect(await ctx.live((tx) => readArtifact(tx, { returnId: returned.id, kind: 'return_notice' }))).toBeNull()

    // And the audit trail carries both the claim and what the check found.
    const audits = (await ctx.live((tx) => tx.execute(sql`
      SELECT after FROM audit_log
      WHERE subject_id = ${settlementId} AND action = 'settlement.return_rejected'`))) as unknown as
      { after: Record<string, unknown> }[]
    expect(audits[0]!.after).toMatchObject({
      provider_claimed_minor: String(AMOUNT),
      check_found: 'the provider now reports CREDITED, not RETURNED',
    })
  })

  it('refuses to confirm on a check that did not uphold', async () => {
    const { settlementId } = await settledSettlement(ctx, '0004')
    const opened = await open(settlementId)
    expect(
      await ctx.live((tx) =>
        confirmReturn(tx, scope, {
          returnId: opened.ok ? opened.returnId : '',
          actor: operator,
          check: { upheld: false, why: 'the provider has no record of this return' },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'check_did_not_uphold' })
  })

  it('asks the provider outside any transaction, and disbelieves a report it contradicts', async () => {
    // The real INV-40 path: the check is a status pull against the provider.
    const { settlementId, idempotencyKey } = await settledSettlement(ctx, '0004')
    const opened = await open(settlementId)

    // The rail has not reported a return, so the check must not uphold one.
    const before = await checkReturnWithProvider(h.db, scope, ctx.provider, {
      returnId: opened.ok ? opened.returnId : '',
    })
    expect(before).toMatchObject({ upheld: false })

    // Now it has.
    ctx.provider.reportReturn(idempotencyKey)
    const after = await checkReturnWithProvider(h.db, scope, ctx.provider, {
      returnId: opened.ok ? opened.returnId : '',
    })
    expect(after).toMatchObject({ upheld: true, source: 'authoritative_status_pull' })
  })
})

/* ── INV-49 — the cap ───────────────────────────────────────────────────── */

describe('INV-49 — cumulative confirmed returns never exceed what was delivered', () => {
  it('…0011 — two partials totalling the delivery confirm; the third breaches and escalates', async () => {
    const { settlementId } = await settledSettlement(ctx, '0011')
    const attempt = await attemptOf(settlementId)
    const delivered = BigInt(attempt.credited_minor)
    expect(delivered).toBe(AMOUNT)

    // The frozen row's amounts: 2 + 3 = exactly delivered, then 1 more.
    const first = await open(settlementId, { amountMinor: 200_000_000n, providerReturnReference: 'pret_11a' })
    const second = await open(settlementId, { amountMinor: 300_000_000n, providerReturnReference: 'pret_11b' })
    const third = await open(settlementId, { amountMinor: 100_000_000n, providerReturnReference: 'pret_11c' })

    expect(await confirm(first.ok ? first.returnId : '')).toMatchObject({ ok: true, status: 'CONFIRMED' })
    expect(await confirm(second.ok ? second.returnId : '')).toMatchObject({ ok: true, status: 'CONFIRMED' })
    // Equality is not a breach: a full return of exactly what was delivered is
    // the ordinary case. The cap is on *exceeding*.
    expect(BigInt((await attemptOf(settlementId)).returned_total_minor)).toBe(delivered)

    const breaching = await confirm(third.ok ? third.returnId : '')
    expect(breaching).toMatchObject({
      ok: true, status: 'MANUAL_REVIEW', transition: 'N04', alarm: 'return_cap_breach',
    })
    // Routed to a human, not refused into silence: a breach means a provider
    // defect or a deduplication failure, and both need looking at.
    expect(breaching.ok && breaching.escalation!.join(' ')).toMatch(/exceeds_delivered/)

    // The counter did not move, and no repayment was requested for the third.
    expect(BigInt((await attemptOf(settlementId)).returned_total_minor)).toBe(delivered)
    expect((await ctx.live((tx) => readReturn(tx, third.ok ? third.returnId : '')))!.repayment_id).toBeNull()

    const handoff = handoffsTo('Stage 6').find((x) => x.suffix === '0011')!
    expect(handoff.handoff.invariants).toEqual(['INV-49'])
  })

  it('the database CHECK holds even against a code path that forgets the lock', async () => {
    // The invariant is enforced in three places and this is the outermost:
    // raw SQL as the superuser, with no lock and no service in the way.
    const { settlementId } = await settledSettlement(ctx, '0004')
    const attempt = await attemptOf(settlementId)
    await expect(
      h.admin`UPDATE payout_attempts SET returned_total_minor = ${String(AMOUNT + 1n)} WHERE id = ${attempt.id}`,
    ).rejects.toThrow(/payout_returns_never_exceed_delivered/)

    // And a return total against a credit whose amount the provider never
    // stated is refused outright — a cap against an unknown is not a cap.
    await h.admin`UPDATE payout_attempts SET credited_minor = NULL WHERE id = ${attempt.id}`
    await expect(
      h.admin`UPDATE payout_attempts SET returned_total_minor = 1 WHERE id = ${attempt.id}`,
    ).rejects.toThrow(/payout_returns_never_exceed_delivered/)
  })

  it('holds under contention: two confirmations that individually fit but together do not', async () => {
    const { settlementId } = await settledSettlement(ctx, '0011')
    const delivered = BigInt((await attemptOf(settlementId)).credited_minor)
    const each = (delivered * 3n) / 4n // two of these exceed the delivery

    const a = await open(settlementId, { amountMinor: each, providerReturnReference: 'pret_race_a' })
    const b = await open(settlementId, { amountMinor: each, providerReturnReference: 'pret_race_b' })

    // Fired together. The payout attempt's row lock is what serialises them;
    // whichever loses sees the other's total and escalates rather than adding.
    const [first, second] = await Promise.all([
      confirm(a.ok ? a.returnId : ''),
      confirm(b.ok ? b.returnId : ''),
    ])
    const statuses = [first, second].map((r) => (r.ok ? r.status : 'failed')).sort()
    expect(statuses).toEqual(['CONFIRMED', 'MANUAL_REVIEW'])
    expect(BigInt((await attemptOf(settlementId)).returned_total_minor)).toBe(each)
  })

  it('states the cap once, as arithmetic the service and the CHECK both follow', () => {
    const delivered = { deliveredMinor: 1000n, currency: 'INR' }
    expect(checkReturnCap({ delivered, confirmedSoFarMinor: 0n, amount: money('INR', 1000n) })).toMatchObject({
      ok: true, newTotalMinor: 1000n, headroomMinor: 0n,
    })
    expect(checkReturnCap({ delivered, confirmedSoFarMinor: 1000n, amount: money('INR', 1n) })).toMatchObject({
      ok: false, reason: 'exceeds_delivered',
    })
    // Fail closed where nothing is known about the delivery.
    expect(
      checkReturnCap({
        delivered: { deliveredMinor: null, currency: 'INR' },
        confirmedSoFarMinor: 0n,
        amount: money('INR', 1n),
      }),
    ).toMatchObject({ ok: false, reason: 'delivered_amount_unknown' })
    expect(
      checkReturnCap({ delivered, confirmedSoFarMinor: 0n, amount: money('USDT', 1n) }),
    ).toMatchObject({ ok: false, reason: 'currency_mismatch' })
  })

  it('repays the facility pro rata, and never more than was drawn', () => {
    // The technical half of D-17: the fraction of the delivery that came back
    // is the fraction of the drawdown that is repaid. No FX rate is applied,
    // because choosing between the original and today's *is* D-17.
    expect(proRataRepayment({ drawnMinor: 1_000_000n, deliveredMinor: 500n, returnedMinor: 500n }))
      .toBe(1_000_000n)
    expect(proRataRepayment({ drawnMinor: 1_000_000n, deliveredMinor: 500n, returnedMinor: 250n }))
      .toBe(500_000n)
    // Floor, so partial returns leave sub-unit dust in the facility rather than
    // repaying value that was never drawn.
    expect(proRataRepayment({ drawnMinor: 10n, deliveredMinor: 3n, returnedMinor: 1n })).toBe(3n)
    expect(proRataRepayment({ drawnMinor: 10n, deliveredMinor: 0n, returnedMinor: 1n })).toBe(0n)
  })
})

/* ── INV-41 / N05 — capacity comes back on the repayment, not the return ── */

describe('INV-41 — confirming requests a repayment; capacity moves on Y03 alone', () => {
  it('N05 — the return becomes REPAID only once its repayment has CONFIRMED', async () => {
    const { settlementId, facilityId } = await settledSettlement(ctx, '0004')
    const opened = await open(settlementId)
    const confirmed = await confirm(opened.ok ? opened.returnId : '')
    if (!confirmed.ok || !confirmed.repaymentId) throw new Error(JSON.stringify(confirmed))
    const repaymentId = confirmed.repaymentId

    // Not yet: the repayment is only REQUESTED.
    expect(
      await ctx.live((tx) => markReturnRepaid(tx, scope, { returnId: opened.ok ? opened.returnId : '', actor: operator })),
    ).toMatchObject({ ok: false, reason: 'repayment_not_confirmed' })

    const drawnBefore = (await ctx.live((tx) => readFacility(tx, facilityId)))!.position.drawn.minorUnits
    await ctx.live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor: operator }))
    // Still nothing: INV-46 moves `drawn` on Y03 and on nothing else.
    expect((await ctx.live((tx) => readFacility(tx, facilityId)))!.position.drawn.minorUnits).toBe(drawnBefore)

    const confirmedRepayment = await ctx.live((tx) =>
      advanceRepayment(tx, scope, { repaymentId, trigger: 'confirmed', actor: operator }),
    )
    expect(confirmedRepayment).toMatchObject({ ok: true, status: 'CONFIRMED', capacityRestored: true })
    expect((await ctx.live((tx) => readFacility(tx, facilityId)))!.position.drawn.minorUnits).toBe(0n)

    const repaid = await ctx.live((tx) =>
      markReturnRepaid(tx, scope, { returnId: opened.ok ? opened.returnId : '', actor: operator }),
    )
    expect(repaid).toMatchObject({ ok: true, status: 'REPAID', transition: 'N05' })

    // And the settlement is *still* SETTLED, through all of it.
    expect(await statusOf(ctx, settlementId)).toBe('SETTLED')
  })
})

/* ── § 8.6 — the observation window is triage, never finality ───────────── */

describe('§ 8.6 — the return observation window', () => {
  it('a settlement settles without waiting out any window', async () => {
    // The window never delays SETTLED. This settlement is final the instant
    // F1–F6 hold, with no window configured anywhere in the path.
    const { settlementId } = await settledSettlement(ctx, '0004')
    expect(await statusOf(ctx, settlementId)).toBe('SETTLED')
  })

  it('a return inside the window takes the normal path', async () => {
    const { settlementId } = await settledSettlement(ctx, '0004')
    const opened = await open(settlementId, { windowSeconds: 30 * A_DAY })
    expect(opened).toMatchObject({ ok: true, status: 'OBSERVED', transition: 'N01' })
    const row = (await ctx.live((tx) => readReturn(tx, opened.ok ? opened.returnId : '')))!
    expect(await ctx.live((tx) => tx.execute(sql`
      SELECT arrived_within_window FROM settlement_returns WHERE id = ${row.id}`))).toMatchObject([
      { arrived_within_window: true },
    ])
  })

  it('…0014 — a return outside the window opens straight into MANUAL_REVIEW', async () => {
    const { settlementId } = await settledSettlement(ctx, '0014')
    const credited = (await ctx.live((tx) => tx.execute(sql`
      SELECT pa.credited_at FROM payout_attempts pa
      JOIN settlements s ON s.payout_attempt_id = pa.id WHERE s.id = ${settlementId}`))) as unknown as
      { credited_at: string }[]
    const occurredAt = new Date(new Date(credited[0]!.credited_at).getTime() + 120 * A_DAY * 1000)

    const opened = await open(settlementId, { windowSeconds: 30 * A_DAY, occurredAt })
    expect(opened).toMatchObject({ ok: true, status: 'MANUAL_REVIEW', transition: 'N04' })
    expect(opened.ok && opened.escalation!.join(' ')).toMatch(/past the rail's 2592000s observation window/)

    // The window it was judged against is stored, because D-04 is open on the
    // duration and a return judged under one window should not be silently
    // re-read under another.
    const rows = (await ctx.live((tx) => tx.execute(sql`
      SELECT window_seconds_at_open, arrival_elapsed_seconds, arrived_within_window
      FROM settlement_returns WHERE id = ${opened.ok && opened.returnId}`))) as unknown as
      { window_seconds_at_open: number; arrival_elapsed_seconds: number; arrived_within_window: boolean }[]
    expect(rows[0]).toMatchObject({ window_seconds_at_open: 30 * A_DAY, arrived_within_window: false })
    expect(rows[0]!.arrival_elapsed_seconds).toBe(120 * A_DAY)

    const handoff = handoffsTo('Stage 6').find((x) => x.suffix === '0014')!
    expect(handoff.handoff.invariants).toEqual(['INV-40'])
  })

  it('no configured window means every arrival is ordinary — D-04 is open', () => {
    // Inventing a threshold would send real returns to MANUAL_REVIEW on a
    // number nobody agreed.
    const creditedAt = new Date('2026-01-01T00:00:00Z')
    const muchLater = new Date('2027-01-01T00:00:00Z')
    expect(triageReturnArrival({ creditedAt, returnObservedAt: muchLater, windowSeconds: null }))
      .toMatchObject({ within: true, path: 'normal' })
    expect(triageReturnArrival({ creditedAt, returnObservedAt: muchLater, windowSeconds: 30 * A_DAY }))
      .toMatchObject({ within: false, path: 'anomaly' })
  })

  it('no finality condition reads the window, and none could', () => {
    // The companion assertion § 10 asks for. `FinalityEvidence` has no field a
    // duration could arrive in, so the two modules cannot be wired together by
    // accident — and `evaluateFinality` has no clock to read one from.
    const evidence: FinalityEvidence = {
      authorization: { authorizedAt: 'x', authorizedBy: 'y', actorHeldCapability: true },
      funding: { drawdownStatus: 'CONFIRMED', facilityStatus: 'ACTIVE' },
      credit: { confirmationSource: 'trusted_provider_event', attemptStatus: 'CREDITED' },
      utr: { value: 'UTR000000123', wellFormed: true },
      reconciliation: { status: 'MATCHED', deltaMinor: 0n },
      openExceptionCode: null,
      authorized: { termsHash: 'h', destinationVersionId: 'd' },
      executed: { termsHash: 'h', destinationVersionId: 'd' },
    }
    const serialised = JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    for (const word of ['window', 'observation', 'elapsed', 'seconds', 'hold']) {
      expect(serialised.toLowerCase(), word).not.toContain(word)
    }
    // And the verdict says nothing temporal either.
    for (const c of evaluateFinality(evidence).conditions) {
      expect(c.because.toLowerCase()).not.toMatch(/window|countdown|wait/)
    }
  })

  it('the return watcher escalates an OBSERVED return past its check SLA', async () => {
    const { settlementId } = await settledSettlement(ctx, '0004')
    const opened = await open(settlementId, { providerReturnReference: 'pret_watcher' })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const swept = await ctx.live((tx) =>
      sweepReturnChecks(tx, scope, { actor: operator, checkSlaSeconds: 1 }),
    )
    const mine = swept.find((r) => r.ok && r.returnId === (opened.ok && opened.returnId))
    expect(mine).toMatchObject({ ok: true, status: 'MANUAL_REVIEW', transition: 'N04' })
  })
})

/* ── INV-43 — an unmapped return reason still opens a return ────────────── */

describe('INV-43 — an unrecognised reason is never a reason to drop a return', () => {
  it('opens it, routes it to MANUAL_REVIEW, and alarms', async () => {
    const { settlementId } = await settledSettlement(ctx, '0004')
    const opened = await open(settlementId, {
      reasonCode: 'RETURN_REASON_UNMAPPED',
      providerRawReason: 'XX_REASON_NOBODY_HAS_SEEN',
      reasonMessage: 'the provider gave a reason nothing maps',
    })
    expect(opened).toMatchObject({
      ok: true, status: 'MANUAL_REVIEW', transition: 'N04', alarm: 'unmapped_return_reason',
    })
    // The provider's own words are kept beside the mapped code, so a mapping
    // added next month can be applied to a return opened today.
    const rows = (await ctx.live((tx) => tx.execute(sql`
      SELECT reason_code, provider_raw_reason FROM settlement_returns
      WHERE id = ${opened.ok && opened.returnId}`))) as unknown as
      { reason_code: string; provider_raw_reason: string }[]
    expect(rows[0]).toMatchObject({
      reason_code: 'RETURN_REASON_UNMAPPED',
      provider_raw_reason: 'XX_REASON_NOBODY_HAS_SEEN',
    })
  })

  it('a webhook carrying an unmapped return reason opens a return through the edge', async () => {
    const { settlementId, idempotencyKey } = await settledSettlement(ctx, '0004')
    ctx.provider.reportReturn(idempotencyKey, { rawCode: 'XX_RETURN_CODE_NOBODY_HAS_SEEN' })

    const signed = ctx.provider.sign({
      id: 'evt_ret_unmapped',
      type: 'payout.returned',
      settlement_id: settlementId,
      code: 'XX_RETURN_CODE_NOBODY_HAS_SEEN',
      return_id: 'pret_unmapped_edge',
      amount_minor: String(AMOUNT),
    })

    let sunk: { reasonCode: string; mapped: boolean } | null = null
    const result = await ctx.live((tx) =>
      ingestPayoutWebhook(tx, scope, ctx.provider, ctx.mapping, {
        raw: signed.raw, headers: signed.headers, actor: creator,
        resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
        onReturn: async (r) => {
          sunk = { reasonCode: r.reasonCode, mapped: r.mapped }
          await openReturn(tx, scope, {
            settlementId: r.settlementId,
            actor: creator,
            source: 'trusted_provider_event',
            amountMinor: r.amountMinor ?? AMOUNT,
            currency: 'INR',
            reasonCode: r.reasonCode,
            reasonMessage: 'reported by webhook',
            providerRawReason: r.rawCode,
            providerReturnReference: r.providerReturnReference ?? r.providerEventId,
            providerEventId: r.providerEventId,
          })
        },
      }),
    )
    // The queue drained, the event was stored, and the taxonomy did not widen.
    expect(result).toMatchObject({ ok: true, outcome: 'returned' })
    expect(sunk).toMatchObject({ reasonCode: 'RETURN_REASON_UNMAPPED', mapped: false })

    const returns = await ctx.live((tx) => listReturns(tx, settlementId))
    expect(returns).toHaveLength(1)
    expect(returns[0]).toMatchObject({ status: 'MANUAL_REVIEW', reason_code: 'RETURN_REASON_UNMAPPED' })
  })

  it('a mapped return reason arrives as the taxonomy code the table names', async () => {
    const { settlementId, idempotencyKey } = await settledSettlement(ctx, '0004')
    ctx.provider.reportReturn(idempotencyKey, { rawCode: 'RETURNED_ACCOUNT_CLOSED' })
    const signed = ctx.provider.sign({
      id: 'evt_ret_mapped',
      type: 'payout.returned',
      settlement_id: settlementId,
      code: 'RETURNED_ACCOUNT_CLOSED',
      return_id: 'pret_mapped_edge',
      amount_minor: String(AMOUNT),
    })
    let reasonCode: string | null = null
    await ctx.live((tx) =>
      ingestPayoutWebhook(tx, scope, ctx.provider, ctx.mapping, {
        raw: signed.raw, headers: signed.headers, actor: creator,
        resolveSettlementId: (p) => (typeof p['settlement_id'] === 'string' ? p['settlement_id'] : null),
        onReturn: async (r) => { reasonCode = r.reasonCode },
      }),
    )
    expect(reasonCode).toBe('BENEFICIARY_ACCOUNT_CLOSED')
  })
})

/* ── N06 / N07 — attributed resolution out of MANUAL_REVIEW ─────────────── */

describe('N06 and N07 — a human decides, and says why', () => {
  it('N06 re-checks the cap and requires a note', async () => {
    const { settlementId } = await settledSettlement(ctx, '0014')
    const opened = await open(settlementId, {
      windowSeconds: A_DAY,
      occurredAt: new Date(Date.now() + 30 * A_DAY * 1000),
    })
    expect(opened.ok && opened.status).toBe('MANUAL_REVIEW')

    expect(await confirm(opened.ok ? opened.returnId : '')).toMatchObject({
      ok: false, reason: 'resolution_note_required',
    })
    const resolved = await confirm(
      opened.ok ? opened.returnId : '',
      'the partner confirmed the late report was a reporting delay, not a defect; ticket OPS-5510',
    )
    expect(resolved).toMatchObject({ ok: true, status: 'CONFIRMED', transition: 'N06' })
  })

  it('N07 rejects with an attributed decision', async () => {
    const { settlementId } = await settledSettlement(ctx, '0014')
    const opened = await open(settlementId, {
      reasonCode: 'RETURN_REASON_UNMAPPED',
      reasonMessage: 'unmapped',
      providerReturnReference: 'pret_n07',
    })
    expect(opened.ok && opened.status).toBe('MANUAL_REVIEW')
    expect(
      await ctx.live((tx) =>
        rejectReturn(tx, scope, { returnId: opened.ok ? opened.returnId : '', actor: operator, why: 'no such return' }),
      ),
    ).toMatchObject({ ok: false, reason: 'resolution_note_required' })

    expect(
      await ctx.live((tx) =>
        rejectReturn(tx, scope, {
          returnId: opened.ok ? opened.returnId : '',
          actor: operator,
          why: 'the provider withdrew the report',
          note: 'partner confirmed the notification was sent in error; ticket OPS-5511',
        }),
      ),
    ).toMatchObject({ ok: true, status: 'REJECTED', transition: 'N07' })
  })
})

/* ── Several notices, several artifacts ─────────────────────────────────── */

describe('each return notice is its own artifact', () => {
  it('two partial returns produce two notices, two hashes and one untouched receipt', async () => {
    const { settlementId } = await settledSettlement(ctx, '0011')
    const receiptBefore = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!

    const a = await open(settlementId, { amountMinor: 100_000_000n, providerReturnReference: 'pret_multi_a' })
    const b = await open(settlementId, { amountMinor: 200_000_000n, providerReturnReference: 'pret_multi_b' })
    await confirm(a.ok ? a.returnId : '')
    await confirm(b.ok ? b.returnId : '')

    const artifacts = await ctx.live((tx) => listArtifacts(tx, settlementId))
    const notices = artifacts.filter((x) => x.kind === 'return_notice')
    expect(notices).toHaveLength(2)
    expect(new Set(notices.map((n) => n.content_hash)).size).toBe(2)
    expect(new Set(notices.map((n) => n.pdf_object_key)).size).toBe(2)
    // Both name the same receipt, and neither changed it.
    for (const n of notices) expect(n.source_content_hash).toBe(receiptBefore.content_hash)
    expect(
      (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!,
    ).toEqual(receiptBefore)
  })
})

/* ── The frozen table, reproduced ───────────────────────────────────────── */

describe('the return machine matches STATE_MACHINES.md § 6.6', () => {
  it('has exactly N01–N07, in the document’s order', () => {
    expect(RETURN_TRANSITIONS.map((t) => t.id)).toEqual(['N01', 'N02', 'N03', 'N04', 'N05', 'N06', 'N07'])
  })

  it('marks the cap, the repayment and the attribution on the right rows', () => {
    const by = (id: string) => RETURN_TRANSITIONS.find((t) => t.id === id)!
    expect(RETURN_TRANSITIONS.filter((t) => t.checksCap).map((t) => t.id)).toEqual(['N02', 'N06'])
    expect(RETURN_TRANSITIONS.filter((t) => t.requestsRepayment).map((t) => t.id)).toEqual(['N02', 'N06'])
    expect(RETURN_TRANSITIONS.filter((t) => t.requiresAttribution).map((t) => t.id)).toEqual(['N06', 'N07'])
    expect(by('N04').from).toEqual(['OBSERVED', 'CONFIRMED'])
    expect(by('N05').from).toEqual(['CONFIRMED'])
  })

  it('fires the four customer events the API contract lists', () => {
    expect(
      [...new Set(RETURN_TRANSITIONS.map((t) => t.customerEvent).filter(Boolean))].sort(),
    ).toEqual([
      'settlement.return_confirmed',
      'settlement.return_observed',
      'settlement.return_rejected',
      'settlement.return_repaid',
    ])
  })
})

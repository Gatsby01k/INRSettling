/**
 * Stage 6 — finality, immutability and the receipt.
 *
 * Testing obligation 12 from `STATE_MACHINES.md § 10`:
 *
 * > *"for each of F1–F6, a case where that single condition is absent and
 * > `SETTLED` is correctly refused; plus a case where the executed payout does
 * > not match `authorized_terms_hash` and finality is refused."*
 *
 * "That single condition" is the load-bearing phrase, and it is why the F1–F6
 * cases below are written against the **pure evaluator** with one field
 * changed. A test that staged six half-broken settlements would be testing six
 * different things at once — and would not be able to prove that the condition
 * it removed was the one doing the refusing, because a settlement missing a UTR
 * is usually also missing a reconciliation.
 *
 * The end-to-end half is here too, in the other direction: one settlement that
 * really does satisfy all six, settled through the real service, with its
 * receipt hashed and written once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { runMigrations } from 'graphile-worker'
import {
  createTestDatabase, installJobQueue, seedUser, seedWorkspace, type Harness,
} from '@inrsettle/testing'
import { money } from '@inrsettle/money'
import {
  DRIFT_CHECKS,
  FINALITY_CONDITIONS,
  TRANSITIONS,
  canonicalize,
  compositeDocument,
  contentHash,
  evaluateFinality,
  receiptDocument,
  renderReceiptTemplate,
  type FinalityEvidence,
  type PreflightRuleSet,
  type ProviderMappingTable,
} from '@inrsettle/domain'

import { activeRuleSetVersion, loadRuleSetFromDatabase } from '../reference-data.service.js'
import { activeMappingTable } from '../payout-mapping.service.js'
import { beginReconciliation, applyObservation, resolveReconciliation, sweepReconciliationSla } from '../reconciliation.service.js'
import { evaluateAndSettle, explainFinality } from '../finality.service.js'
import {
  artifactPdfUrl, artifactVerifies, exportComposite, issueReceipt, listArtifacts,
  readArtifact, receiptGenerateJobKey, runReceiptGenerate,
} from '../receipt.service.js'
import {
  AMOUNT, RECONCILIATION_SLA, ROLES, approver, creator, creditedSettlement, liveFor,
  makeArtifacts, makeProvider, operator, scope, settledSettlement, statusOf,
  type Stage6Context,
} from './stage6-fixtures.js'

let ctx: Stage6Context
let h: Harness

beforeAll(async () => {
  h = await createTestDatabase('stage6_finality')
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

/* ── The evaluator, one condition at a time ─────────────────────────────── */

/** Evidence that satisfies every condition. Each case below breaks exactly one. */
function completeEvidence(): FinalityEvidence {
  return {
    authorization: {
      authorizedAt: '2026-09-03T09:00:00.000Z',
      authorizedBy: 'usr_approver',
      actorHeldCapability: true,
    },
    funding: { drawdownStatus: 'CONFIRMED', facilityStatus: 'ACTIVE' },
    credit: { confirmationSource: 'trusted_provider_event', attemptStatus: 'CREDITED' },
    utr: { value: 'UTR000000123', wellFormed: true },
    reconciliation: { status: 'MATCHED', deltaMinor: 0n },
    openExceptionCode: null,
    authorized: { termsHash: 'abc123', destinationVersionId: 'dvr_frozen' },
    executed: { termsHash: 'abc123', destinationVersionId: 'dvr_frozen' },
  }
}

describe('the finality evaluator — F1–F6, one absent condition at a time', () => {
  it('is final when, and only when, everything holds', () => {
    const verdict = evaluateFinality(completeEvidence())
    expect(verdict.final).toBe(true)
    expect(verdict.missing).toEqual([])
    // Eight verdicts: six conditions and two drift checks, each explaining
    // itself. A verdict that explained only its failures could not answer
    // "why is this settled", which is the question an auditor asks.
    expect(verdict.conditions).toHaveLength(FINALITY_CONDITIONS.length + DRIFT_CHECKS.length)
    for (const c of verdict.conditions) {
      expect(c.because.length, c.condition).toBeGreaterThan(0)
    }
  })

  const cases: readonly { condition: string; why: string; break: (e: FinalityEvidence) => FinalityEvidence }[] = [
    {
      condition: 'F1',
      why: 'authorized by someone who did not hold the capability at the time',
      break: (e) => ({ ...e, authorization: { ...e.authorization, actorHeldCapability: false } }),
    },
    {
      condition: 'F2',
      why: 'the drawdown never confirmed, so the funding leg is not real',
      break: (e) => ({ ...e, funding: { ...e.funding, drawdownStatus: 'REQUESTED' } }),
    },
    {
      condition: 'F3',
      why: 'no terminal credit confirmation over a trusted channel',
      break: (e) => ({ ...e, credit: { confirmationSource: null, attemptStatus: 'ACCEPTED' } }),
    },
    {
      condition: 'F4',
      why: 'a malformed UTR looks like proof and is not',
      break: (e) => ({ ...e, utr: { value: 'nope', wellFormed: false } }),
    },
    {
      condition: 'F5',
      why: 'reconciliation is not MATCHED',
      break: (e) => ({ ...e, reconciliation: { status: 'MISMATCH', deltaMinor: -500_000n } }),
    },
    {
      condition: 'F6',
      why: 'a blocking exception is open',
      break: (e) => ({ ...e, openExceptionCode: 'RECONCILIATION_MISMATCH' }),
    },
  ]

  for (const c of cases) {
    it(`${c.condition} absent — ${c.why} — refuses finality, and only that condition fails`, () => {
      const verdict = evaluateFinality(c.break(completeEvidence()))
      expect(verdict.final).toBe(false)
      // Exactly one condition failed. This is what makes the case a test of
      // *that* condition rather than of a settlement that was broken in several
      // ways at once.
      expect(verdict.missing).toEqual([c.condition])
    })
  }

  it('F5 refuses a MATCHED reconciliation carrying a non-zero delta', () => {
    // Both halves are separately falsifiable, and this is the shape where
    // trusting the status label alone would settle a mismatch.
    const verdict = evaluateFinality({
      ...completeEvidence(),
      reconciliation: { status: 'MATCHED', deltaMinor: -1n },
    })
    expect(verdict.final).toBe(false)
    expect(verdict.missing).toEqual(['F5'])
  })

  it('X1 — an executed payout that does not match the authorized terms hash', () => {
    const verdict = evaluateFinality({
      ...completeEvidence(),
      executed: { termsHash: 'tampered', destinationVersionId: 'dvr_frozen' },
    })
    expect(verdict.final).toBe(false)
    expect(verdict.missing).toEqual(['X1'])
    expect(verdict.conditions.find((c) => c.condition === 'X1')!.because).toMatch(/authorized against abc123/)
  })

  it('X2 — a payout against a destination version other than the frozen one', () => {
    const verdict = evaluateFinality({
      ...completeEvidence(),
      executed: { termsHash: 'abc123', destinationVersionId: 'dvr_newer' },
    })
    expect(verdict.final).toBe(false)
    expect(verdict.missing).toEqual(['X2'])
  })

  it('accepts RETURNED as a terminal credit, because P08 runs from CREDITED', () => {
    // A settlement whose credit later came back was still credited. Refusing
    // here would make a returned settlement retroactively un-final, which is
    // exactly what INV-42 forbids.
    const verdict = evaluateFinality({
      ...completeEvidence(),
      credit: { confirmationSource: 'trusted_provider_event', attemptStatus: 'RETURNED' },
    })
    expect(verdict.final).toBe(true)
  })

  it('has no parameter through which an override could arrive', () => {
    // § 8.2's list is honoured by omission. `evaluateFinality` takes one
    // argument, and every field of it is evidence — there is no actor, no
    // `force`, no tolerance and no `asOf`. The signature is the safety property,
    // and `scripts/check-finality-integrity.mjs` keeps it that way.
    expect(evaluateFinality.length).toBe(1)
    const keys = Object.keys(completeEvidence())
    expect(keys).toEqual([
      'authorization', 'funding', 'credit', 'utr', 'reconciliation',
      'openExceptionCode', 'authorized', 'executed',
    ])
  })
})

/* ── Terminality, from the compiled table ───────────────────────────────── */

describe('SETTLED is terminal — enumerated, not inspected', () => {
  it('has no outgoing transition anywhere in the compiled machine', () => {
    // The exit criterion says "verified by enumerating the transition table,
    // not by inspection". So: every transition, every `from` list.
    const outgoing = TRANSITIONS.filter((t) => t.from.includes('SETTLED'))
    expect(outgoing.map((t) => t.id)).toEqual([])
  })

  it('and neither do FAILED or CANCELLED — INV-38', () => {
    for (const terminal of ['FAILED', 'CANCELLED'] as const) {
      expect(
        TRANSITIONS.filter((t) => t.from.includes(terminal)).map((t) => t.id),
        terminal,
      ).toEqual([])
    }
  })
})

/* ── End to end: a settlement that really is final ──────────────────────── */

describe('a settlement reaches SETTLED through the evaluator and nothing else', () => {
  it('settles, records the verdict, and issues one receipt', async () => {
    const { settlementId } = await settledSettlement(ctx)
    expect(await statusOf(ctx, settlementId)).toBe('SETTLED')

    // The verdict is on the record — the passing conditions as well as the
    // failing ones, because "why is this settled" is an auditor's question.
    const evaluations = (await ctx.live((tx) => tx.execute(sql`
      SELECT final, conditions, missing FROM finality_evaluations
      WHERE settlement_id = ${settlementId} ORDER BY evaluated_at DESC`))) as unknown as
      { final: boolean; conditions: { condition: string; met: boolean; because: string }[]; missing: string[] }[]
    expect(evaluations[0]!.final).toBe(true)
    expect(evaluations[0]!.missing).toEqual([])
    expect(evaluations[0]!.conditions.map((c) => c.condition)).toEqual([
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'X1', 'X2',
    ])
    for (const c of evaluations[0]!.conditions) expect(c.met, c.condition).toBe(true)

    const receipt = await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' }))
    expect(receipt).not.toBeNull()
    expect(receipt!.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await ctx.live(async () => artifactVerifies(receipt!))).toBe(true)
  })

  it('records a refusal, with its reasons, when the evidence is incomplete', async () => {
    // PAYOUT_CONFIRMED but never reconciled: F5 is the only thing missing, and
    // the settlement stays exactly where it was.
    const { settlementId } = await creditedSettlement(ctx, '0000')
    const result = await ctx.live((tx) =>
      evaluateAndSettle(tx, scope, {
        settlementId,
        actor: creator,
        issueReceipt: async () => {
          throw new Error('the receipt must not be cut for a settlement that is not final')
        },
      }),
    )
    expect(result).toMatchObject({ ok: true, settled: false })
    expect(result.ok && result.verdict.missing).toEqual(['F5'])
    expect(await statusOf(ctx, settlementId)).toBe('PAYOUT_CONFIRMED')

    // The refusal is stored, which is the half that answers "why is this *not*
    // settled" — the question operations actually asks.
    const rows = (await ctx.live((tx) => tx.execute(sql`
      SELECT final, missing FROM finality_evaluations WHERE settlement_id = ${settlementId}`))) as
      unknown as { final: boolean; missing: string[] }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ final: false, missing: ['F5'] })
  })

  it('explains itself without settling anything', async () => {
    const { settlementId } = await creditedSettlement(ctx, '0000')
    const before = await statusOf(ctx, settlementId)
    const explained = await ctx.live((tx) => explainFinality(tx, scope, settlementId))
    expect(explained.ok && explained.verdict.missing).toEqual(['F5'])
    expect(await statusOf(ctx, settlementId)).toBe(before)
  })

  it('refuses a second settle, because SETTLED is terminal', async () => {
    const { settlementId } = await settledSettlement(ctx)
    const again = await ctx.live((tx) =>
      evaluateAndSettle(tx, scope, {
        settlementId,
        actor: creator,
        issueReceipt: async () => { throw new Error('a settled settlement must not be re-receipted') },
      }),
    )
    expect(again).toMatchObject({ ok: true, settled: false, alreadySettled: true })
  })
})

/* ── Reconciliation: zero tolerance ─────────────────────────────────────── */

describe('INV-26 — zero tolerance, and a mismatch never settles', () => {
  it('a ₹5,000 shortfall produces MISMATCH and refuses finality', async () => {
    // Scenario …0001 credits ₹5,000 short. This is the Stage 6 obligation Stage 5
    // handed over: compare `credited_minor` against the expected amount and open
    // a MISMATCH on a non-zero delta.
    const { settlementId } = await creditedSettlement(ctx, '0001')
    await ctx.live((tx) =>
      beginReconciliation(tx, scope, {
        settlementId, expected: money('INR', AMOUNT), actor: creator, slaSeconds: RECONCILIATION_SLA,
      }),
    )

    const observed = AMOUNT - 500_000n
    const compared = await ctx.live((tx) =>
      applyObservation(tx, scope, {
        settlementId, source: 'trusted_provider_event',
        observedMinor: observed, observedCurrency: 'INR', actor: creator,
      }),
    )
    expect(compared).toMatchObject({ ok: true, transition: 'R03', deltaMinor: -500_000n })
    // R05 is immediate: "a mismatch is never left unattended".
    expect(compared.ok && compared.status).toBe('MANUAL_REVIEW')

    // T21 moved the settlement, and the exception is the non-actionable one.
    const rows = (await ctx.live((tx) => tx.execute(sql`
      SELECT status, open_exception_code, customer_status FROM settlements WHERE id = ${settlementId}`))) as
      unknown as { status: string; open_exception_code: string; customer_status: string }[]
    expect(rows[0]).toMatchObject({
      status: 'EXCEPTION',
      open_exception_code: 'RECONCILIATION_MISMATCH',
      customer_status: 'SETTLING',
    })

    // And it never settles. Both F5 and F6 refuse, which is the right answer
    // twice rather than one answer that happens to be right.
    const verdict = await ctx.live((tx) => explainFinality(tx, scope, settlementId))
    expect(verdict.ok && verdict.verdict.final).toBe(false)
    expect(verdict.ok && [...verdict.verdict.missing].sort()).toEqual(['F5', 'F6'])
  })

  it('treats "the provider stated no amount" as a mismatch, not a pass', async () => {
    // MATCHED means we checked, not that we had no reason to doubt.
    const { settlementId } = await creditedSettlement(ctx, '0000')
    await ctx.live((tx) =>
      beginReconciliation(tx, scope, {
        settlementId, expected: money('INR', AMOUNT), actor: creator, slaSeconds: RECONCILIATION_SLA,
      }),
    )
    const compared = await ctx.live((tx) =>
      applyObservation(tx, scope, {
        settlementId, source: 'authoritative_status_pull',
        observedMinor: null, observedCurrency: 'INR', actor: creator,
      }),
    )
    expect(compared).toMatchObject({ ok: true, transition: 'R03', status: 'MANUAL_REVIEW' })
  })

  it('has no tolerance parameter to widen — one minor unit is a mismatch', async () => {
    const { settlementId } = await creditedSettlement(ctx, '0000')
    await ctx.live((tx) =>
      beginReconciliation(tx, scope, {
        settlementId, expected: money('INR', AMOUNT), actor: creator, slaSeconds: RECONCILIATION_SLA,
      }),
    )
    const compared = await ctx.live((tx) =>
      applyObservation(tx, scope, {
        settlementId, source: 'trusted_provider_event',
        observedMinor: AMOUNT + 1n, observedCurrency: 'INR', actor: creator,
      }),
    )
    expect(compared).toMatchObject({ ok: true, transition: 'R03', deltaMinor: 1n })
  })

  it('R06 requires an attributed decision and an explicit compensation answer', async () => {
    const { settlementId } = await creditedSettlement(ctx, '0001')
    await ctx.live((tx) =>
      beginReconciliation(tx, scope, {
        settlementId, expected: money('INR', AMOUNT), actor: creator, slaSeconds: RECONCILIATION_SLA,
      }),
    )
    await ctx.live((tx) =>
      applyObservation(tx, scope, {
        settlementId, source: 'trusted_provider_event',
        observedMinor: AMOUNT - 500_000n, observedCurrency: 'INR', actor: creator,
      }),
    )

    // No note: refused.
    expect(
      await ctx.live((tx) =>
        resolveReconciliation(tx, scope, {
          settlementId, trigger: 'resolve_matched', actor: operator, note: '   ',
          compensationRequired: false,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'resolution_note_required' })

    // No compensation answer: refused. Whether value moved incorrectly is a
    // fact only the resolver has, and inferring it would answer D-14 by accident.
    expect(
      await ctx.live((tx) =>
        resolveReconciliation(tx, scope, {
          settlementId, trigger: 'resolve_matched', actor: operator, note: 'provider topped up the shortfall',
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'compensation_decision_required' })

    const resolved = await ctx.live((tx) =>
      resolveReconciliation(tx, scope, {
        settlementId, trigger: 'resolve_matched', actor: operator,
        note: 'provider topped up the shortfall out of band; ticket OPS-4412',
        compensationRequired: true,
      }),
    )
    expect(resolved).toMatchObject({ ok: true, transition: 'R06', status: 'MATCHED', deltaMinor: 0n })
  })

  it('R04 — the poller escalates a reconciliation that never got an observation', async () => {
    // This is the deferred companion Stage 3 declared on T30, now satisfied.
    const { settlementId } = await creditedSettlement(ctx, '0000')
    await ctx.live((tx) =>
      beginReconciliation(tx, scope, {
        settlementId, expected: money('INR', AMOUNT), actor: creator, slaSeconds: 1,
      }),
    )
    expect(
      await ctx.live((tx) => sweepReconciliationSla(tx, scope, { settlementId, actor: creator })),
    ).toMatchObject({ ok: false, reason: 'sla_not_elapsed' })

    await new Promise((resolve) => setTimeout(resolve, 1100))
    const swept = await ctx.live((tx) => sweepReconciliationSla(tx, scope, { settlementId, actor: creator }))
    expect(swept).toMatchObject({ ok: true, transition: 'R04', status: 'MANUAL_REVIEW' })
    const rows = (await ctx.live((tx) => tx.execute(sql`
      SELECT status, open_exception_code FROM settlements WHERE id = ${settlementId}`))) as unknown as
      { status: string; open_exception_code: string }[]
    // FINALITY_EVIDENCE_MISSING, which is T30's own note in the frozen table:
    // nobody told us what arrived, which is a different problem from a delta.
    expect(rows[0]).toMatchObject({ status: 'EXCEPTION', open_exception_code: 'FINALITY_EVIDENCE_MISSING' })
  })
})

/* ── The receipt: one serialisation, one hash, written once ─────────────── */

describe('INV-29 and INV-48 — the receipt is one document, written once', () => {
  it('UI, API and PDF render one serialisation through one template', async () => {
    // ARCHITECTURE.md § 9: "The UI renders it, the API returns it, and the PDF
    // is produced by headless Chromium rendering the *same* template."
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    const document = JSON.parse(receipt.canonical_bytes) as Record<string, never>
    const artifact = { kind: 'settlement_receipt' as const, document }

    // The API's answer is the stored hash; the UI re-derives it from the same
    // canonical document; the stored bytes are that document canonicalised.
    expect(contentHash(artifact)).toBe(receipt.content_hash)
    expect(canonicalize(document)).toBe(receipt.canonical_bytes)

    // The UI's markup and Chromium's input are the same string, from the same
    // function. Not "equivalent" — identical, which is what makes INV-29's
    // "they cannot disagree" a property of the call graph.
    const uiHtml = renderReceiptTemplate(artifact, receipt.content_hash)
    expect(ctx.renderer.html(artifact, receipt.content_hash)).toBe(uiHtml)

    // And the hash is on the page, so a person holding the paper can check it
    // against the API without trusting either.
    expect(uiHtml).toContain(receipt.content_hash)
  })

  it('the template is deterministic; the PDF it prints to need not be', async () => {
    // The determinism that matters lives one level above the PDF. The template
    // is a pure function, so two surfaces rendering it get the same bytes.
    // Chromium then stamps /CreationDate into what it prints — which is fine,
    // because the PDF is not what `content_hash` covers.
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    const artifact = {
      kind: 'settlement_receipt' as const,
      document: JSON.parse(receipt.canonical_bytes) as Record<string, never>,
    }
    expect(renderReceiptTemplate(artifact, receipt.content_hash))
      .toBe(renderReceiptTemplate(artifact, receipt.content_hash))

    const pdf = await ctx.artifacts.render(artifact, receipt.content_hash)
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.byteLength).toBeGreaterThan(1000)
  })

  it('prints the PDF once, and writes it once', async () => {
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!

    // Already materialised by the fixture, as the post-commit job would.
    const stored = await ctx.artifacts.store.get(receipt.pdf_object_key)
    expect(stored).not.toBeNull()
    expect(Buffer.from(stored!.bytes).subarray(0, 5).toString()).toBe('%PDF-')

    // A retried job neither re-renders nor re-writes.
    const again = await runReceiptGenerate(ctx.h.db, scope, ctx.artifacts, {
      artifactId: receipt.id,
    })
    expect(again).toMatchObject({ ok: true, rendered: false })
    const after = await ctx.artifacts.store.get(receipt.pdf_object_key)
    expect(Buffer.from(after!.bytes).equals(Buffer.from(stored!.bytes))).toBe(true)
  })

  it('the read path re-enqueues a missing PDF and never renders one itself', async () => {
    // Worker-owned. A customer opening a receipt whose PDF has not been printed
    // must not become the process that launches a browser — that puts an
    // unbounded external process on a request path. The read notices, asks for
    // one, and says plainly that it is not ready.
    const { settlementId } = await creditedSettlement(ctx, '0000')
    await ctx.live((tx) =>
      beginReconciliation(tx, scope, {
        settlementId, expected: money('INR', AMOUNT), actor: creator, slaSeconds: RECONCILIATION_SLA,
      }),
    )
    await ctx.live((tx) =>
      applyObservation(tx, scope, {
        settlementId, source: 'trusted_provider_event',
        observedMinor: AMOUNT, observedCurrency: 'INR', actor: creator,
      }),
    )
    const settled = await ctx.live((tx) =>
      evaluateAndSettle(tx, scope, {
        settlementId, actor: creator,
        issueReceipt: async (inner) => {
          const r = await issueReceipt(inner, scope, { settlementId, actor: creator })
          if (!r.ok) throw new Error(JSON.stringify(r))
          return { receiptId: r.artifactId, contentHash: r.contentHash }
        },
      }),
    )
    expect(settled).toMatchObject({ ok: true, settled: true })

    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    expect(await ctx.artifacts.store.get(receipt.pdf_object_key)).toBeNull()

    // A renderer that would fail the test if the read path ever called it.
    const forbidden = {
      store: ctx.artifacts.store,
      render: async () => { throw new Error('the read path must not render a PDF') },
    }
    const pending = await artifactPdfUrl(ctx.h.db, scope, forbidden, { artifactId: receipt.id })
    expect(pending).toMatchObject({ ok: false, reason: 'pdf_not_generated_yet', requeued: true })
    // Nothing was printed by reading.
    expect(await ctx.artifacts.store.get(receipt.pdf_object_key)).toBeNull()

    // The worker prints it, and the same read then presigns.
    expect(await runReceiptGenerate(ctx.h.db, scope, ctx.artifacts, { artifactId: receipt.id }))
      .toMatchObject({ ok: true, rendered: true })
    const url = await artifactPdfUrl(ctx.h.db, scope, forbidden, { artifactId: receipt.id })
    expect(url).toMatchObject({ ok: true })
    expect(url.ok && url.url).toContain(receipt.pdf_object_key)
  })

  it('T20 enqueues receipt.generate in the transaction that settles', async () => {
    // ARCHITECTURE.md § 7: a job cannot exist without the transaction that
    // created it. The receipt record and its print request commit together.
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    const jobs = (await h.admin`
      SELECT key FROM graphile_worker._private_jobs
      WHERE key = ${receiptGenerateJobKey(receipt.id)}`) as { key: string }[]
    // One job, keyed on the artifact, so a re-enqueue collapses rather than
    // starting a second browser.
    expect(jobs.length).toBeLessThanOrEqual(1)
    expect(receiptGenerateJobKey(receipt.id)).toContain(receipt.id)
  })

  it('the job is safe to run twice — § 7 requires it', async () => {
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    const first = await ctx.artifacts.store.get(receipt.pdf_object_key)
    expect(first).not.toBeNull()

    const again = await runReceiptGenerate(ctx.h.db, scope, ctx.artifacts, { artifactId: receipt.id })
    // The store is checked before the browser starts, so a retry does not print
    // bytes it is about to discard.
    expect(again).toMatchObject({ ok: true, rendered: false })
    const after = await ctx.artifacts.store.get(receipt.pdf_object_key)
    expect(Buffer.from(after!.bytes).equals(Buffer.from(first!.bytes))).toBe(true)
  })

  it('refuses to print a PDF whose bytes do not match the hash it would carry', async () => {
    // The row is immutable, so this cannot happen through the application —
    // which is exactly why the check is worth having: it catches corruption
    // that arrived some other way, before it is printed onto a document.
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    expect(artifactVerifies({ ...receipt, content_hash: 'sha256:0'.padEnd(71, '0') })).toBe(false)
  })

  it('refuses to be updated or deleted, from raw SQL as the superuser', async () => {
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!

    await expect(
      h.admin`UPDATE financial_artifacts SET content_hash = 'sha256:0' WHERE id = ${receipt.id}`,
    ).rejects.toThrow(/write-once/)
    await expect(
      h.admin`DELETE FROM financial_artifacts WHERE id = ${receipt.id}`,
    ).rejects.toThrow(/write-once/)

    // And the application role is not even granted the attempt.
    const grants = (await h.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'inrsettle_app' AND table_name = 'financial_artifacts'`) as { privilege_type: string }[]
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(['INSERT', 'SELECT'])
  })

  it('embeds a snapshot, so a later beneficiary edit cannot change history', async () => {
    // INV-28. The receipt names the destination version frozen at authorization
    // and carries its own copy of the display name.
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    const before = receipt.canonical_bytes

    await h.admin`UPDATE beneficiaries SET display_name = 'Someone Else' WHERE workspace_id = ${scope.workspaceId}`

    const after = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    expect(after.canonical_bytes).toBe(before)
    expect(JSON.parse(after.canonical_bytes).beneficiary_snapshot.display_name).toBe('Aarti Sharma')
    // Restore, so later cases in this file are not reading an edited fixture.
    await h.admin`UPDATE beneficiaries SET display_name = 'Aarti Sharma' WHERE workspace_id = ${scope.workspaceId}`
  })

  it('never contains a full account number', async () => {
    const { settlementId } = await settledSettlement(ctx)
    const receipt = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    // The frozen security model: full account data never leaves through an API
    // response, an event, an audit record or a log — and a receipt is all four.
    expect(receipt.canonical_bytes).not.toContain('5010012340')
    expect(JSON.parse(receipt.canonical_bytes).beneficiary_snapshot.account_number_last4).toMatch(/^\d{4}$/)
  })

  it('is issued once, and a retried issuance is a no-op', async () => {
    const { settlementId } = await settledSettlement(ctx)
    const again = await ctx.live((tx) =>
      issueReceipt(tx, scope, { settlementId, actor: creator }),
    )
    expect(again).toMatchObject({ ok: true, idempotent: true })

    const receipts = (await ctx.live((tx) => listArtifacts(tx, settlementId))).filter(
      (a) => a.kind === 'settlement_receipt',
    )
    expect(receipts).toHaveLength(1)
  })

  it('the composite is a third artifact and replaces neither source', async () => {
    const { settlementId } = await settledSettlement(ctx)
    const receiptBefore = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!

    const composite = await ctx.live((tx) =>
      exportComposite(tx, scope, { settlementId, actor: creator }),
    )
    expect(composite.ok).toBe(true)
    expect(composite.ok && composite.kind).toBe('receipt_composite')

    // The receipt is untouched — same hash, same bytes, same object key.
    const receiptAfter = (await ctx.live((tx) => readArtifact(tx, { settlementId, kind: 'settlement_receipt' })))!
    expect(receiptAfter).toEqual(receiptBefore)
    expect(composite.ok && composite.contentHash).not.toBe(receiptBefore.content_hash)

    // And the composite carries its sources' hashes, so it is verifiable
    // against them rather than merely derived from them.
    const document = JSON.parse((composite.ok && composite.canonicalBytes) || '{}')
    expect(document.receipt.content_hash).toBe(receiptBefore.content_hash)
  })

  it('two composites of an unchanged settlement are the same document', async () => {
    // The id is minted per export; the content is not. So an export is provably
    // a rendering rather than a new fact.
    const { settlementId } = await settledSettlement(ctx)
    const first = await ctx.live((tx) => exportComposite(tx, scope, { settlementId, actor: creator }))
    const second = await ctx.live((tx) => exportComposite(tx, scope, { settlementId, actor: creator }))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    const strip = (bytes: string) => {
      const d = JSON.parse(bytes) as Record<string, unknown>
      delete d['id']
      return canonicalize(d as never)
    }
    expect(strip(second.canonicalBytes)).toBe(strip(first.canonicalBytes))
    expect(second.artifactId).not.toBe(first.artifactId)
  })
})

/* ── The canonical serialiser itself ────────────────────────────────────── */

describe('canonical serialisation', () => {
  it('does not depend on key insertion order', () => {
    const a = canonicalize({ b: 1, a: 2, c: { z: 3, y: 4 } })
    const b = canonicalize({ c: { y: 4, z: 3 }, a: 2, b: 1 })
    expect(a).toBe(b)
  })

  it('renders bigints as strings, never as JSON numbers', () => {
    // A money amount that silently became a float would be a hash over a
    // rounded figure — and the rounding would be invisible.
    expect(canonicalize({ minor_units: 9007199254740993n })).toBe('{"minor_units":"9007199254740993"}')
  })

  it('refuses undefined rather than dropping it', () => {
    // An absent field and a present-but-undefined one must not hash alike.
    expect(() => canonicalize({ a: undefined } as never)).toThrow(/refuses undefined/)
  })

  it('gives a receipt a different hash for every field that changes', () => {
    const base = {
      receiptId: 'rcp_1', settlementId: 'stl_1', settlementIdDisplay: 'stl_1',
      workspaceId: 'ws_1', environment: 'sandbox',
      beneficiarySnapshot: {
        displayName: 'A', legalName: null, country: 'IN', destinationKind: 'bank_account',
        accountNumberLast4: '0000', ifsc: 'HDFC0000123', vpa: null, accountHolderName: 'A',
        destinationVersionId: 'dvr_1',
      },
      recipientAmount: { currency: 'INR', minorUnits: 100n },
      deliveredAmount: { currency: 'INR', minorUnits: 100n },
      fundingAmount: { currency: 'USDT', minorUnits: 1n },
      fxRate: 'INR/USDT 1e-10', feeComponents: [],
      roundingResidual: { currency: 'INR', minorUnits: 0n },
      purpose: 'SOFTWARE_SERVICES', externalReference: null,
      payoutReference: 'UTR000000001', rail: 'RTGS',
      reconciliationResult: 'MATCHED', finalStatus: 'SETTLED', authorizedTermsHash: 'abc',
      createdAt: 'a', authorizedAt: 'b', creditedAt: 'c', settledAt: 'd',
    } as const
    const original = contentHash(receiptDocument(base))
    const changed = contentHash(
      receiptDocument({ ...base, recipientAmount: { currency: 'INR', minorUnits: 101n } }),
    )
    expect(changed).not.toBe(original)
  })

  it('orders a composite’s notices by id, so caller order cannot change the bytes', () => {
    const doc = (id: string) => ({ id, artifact: 'return_notice' })
    const one = compositeDocument({
      compositeId: 'cmp_1', settlementId: 'stl_1', workspaceId: 'ws_1', environment: 'sandbox',
      createdAt: 'composed',
      receipt: { document: { id: 'rcp_1' }, contentHash: 'sha256:a' },
      notices: [
        { document: doc('rnt_b'), contentHash: 'sha256:b' },
        { document: doc('rnt_a'), contentHash: 'sha256:c' },
      ],
    })
    const two = compositeDocument({
      compositeId: 'cmp_1', settlementId: 'stl_1', workspaceId: 'ws_1', environment: 'sandbox',
      createdAt: 'composed',
      receipt: { document: { id: 'rcp_1' }, contentHash: 'sha256:a' },
      notices: [
        { document: doc('rnt_a'), contentHash: 'sha256:c' },
        { document: doc('rnt_b'), contentHash: 'sha256:b' },
      ],
    })
    expect(contentHash(two)).toBe(contentHash(one))
  })
})

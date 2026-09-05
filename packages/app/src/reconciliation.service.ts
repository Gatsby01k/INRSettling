/**
 * Reconciliation — Stage 6. `R01`–`R07`, `T19`–`T21`, `T30`, `INV-26`, `INV-27`.
 *
 * The comparison engine is in the domain and takes no tolerance parameter; this
 * file is the transaction around it. Two rules shape everything below:
 *
 * **The settlement side and the reconciliation side move together, or not at
 * all.** `T21` opens a `RECONCILIATION_MISMATCH` exception on the settlement
 * and `R03` puts the reconciliation in `MISMATCH`; a crash between them would
 * leave a settlement in exception with a reconciliation that says `PENDING`, and
 * the poller would then escalate a mismatch that had already been escalated. One
 * transaction, both sides.
 *
 * **`MATCHED` is not finality.** `R02` says the amounts agree. `T20` says the
 * settlement is `SETTLED`, and only the finality evaluator can say that —
 * reconciliation is `F5`, one of six conditions. This file therefore never
 * drives `T20` itself; it hands off to `finality.service.ts`, which is the only
 * component that can.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import { money, type Money } from '@inrsettle/money'
import {
  compareObservation,
  evaluateReconciliationTransition,
  type Observation,
  type ObservationSource,
  type PrincipalRef,
  type ReconciliationStatus,
  type ReconciliationTrigger,
  type TenantScope,
} from '@inrsettle/domain'
import { applyTransition } from './settlement-transition.service.js'
import { eventSink } from './events.js'
import { databaseNow } from './quote.service.js'

export type ReconciliationResult =
  | {
      ok: true
      reconciliationId: string
      status: ReconciliationStatus
      transition: string
      deltaMinor: bigint
      /** True where this call also moved the settlement. */
      settlementMoved?: boolean
      idempotent?: boolean
    }
  | { ok: false; reason: string; detail?: unknown }

interface ReconciliationRow {
  id: string
  settlement_id: string
  status: ReconciliationStatus
  expected_minor: string | number | bigint
  observed_minor: string | number | bigint | null
  delta_minor: string | number | bigint
  currency: string
  opened_at: Date
  sla_seconds: number
}

const RECONCILIATION_COLUMNS = sql`
  id, settlement_id, status, expected_minor, observed_minor, delta_minor, currency,
  opened_at, sla_seconds`

async function lockReconciliation(tx: Db, settlementId: string): Promise<ReconciliationRow | null> {
  const rows = (await tx.execute(sql`
    SELECT ${RECONCILIATION_COLUMNS} FROM reconciliations
    WHERE settlement_id = ${settlementId} FOR UPDATE`)) as unknown as ReconciliationRow[]
  return rows[0] ?? null
}

export async function readReconciliation(
  tx: Db,
  settlementId: string,
): Promise<ReconciliationRow | null> {
  const rows = (await tx.execute(sql`
    SELECT ${RECONCILIATION_COLUMNS} FROM reconciliations
    WHERE settlement_id = ${settlementId}`)) as unknown as ReconciliationRow[]
  return rows[0] ?? null
}

/* ── T19 + R01 — begin ──────────────────────────────────────────────────── */

/**
 * Open reconciliation on a confirmed payout — `T19` and `R01` in one commit.
 *
 * `expected` is the recipient amount the settlement was authorized for, passed
 * by the caller from the frozen terms rather than recomputed here. Recomputing
 * it would mean the comparison's own inputs could drift from what was
 * authorized, and then a mismatch would be a bug in this file rather than a
 * fact about the money.
 *
 * The SLA is required with no default. A default would decide `R04`'s deadline
 * by accident, and the first person to notice would be an operator wondering
 * why nothing escalated.
 */
export async function beginReconciliation(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    expected: Money
    actor: PrincipalRef
    slaSeconds: number
  },
): Promise<ReconciliationResult> {
  if (input.slaSeconds <= 0) {
    return { ok: false, reason: 'sla_seconds_must_be_positive' }
  }

  const existing = await lockReconciliation(tx, input.settlementId)
  if (existing) {
    // One reconciliation per settlement. A retried job lands here, and carrying
    // on is correct; starting a second one would give the settlement two
    // answers and no way to choose.
    return {
      ok: true,
      reconciliationId: existing.id,
      status: existing.status,
      transition: 'R01',
      deltaMinor: BigInt(existing.delta_minor),
      idempotent: true,
    }
  }

  const evaluated = evaluateReconciliationTransition(null, 'begin')
  if (!evaluated.ok) return { ok: false, reason: 'invalid_transition', detail: evaluated }

  const id = newId('reconciliation')
  await tx.insert(schema.reconciliations).values({
    id,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    settlementId: input.settlementId,
    status: 'PENDING',
    expectedMinor: input.expected.minorUnits,
    deltaMinor: 0n,
    currency: input.expected.currency,
    slaSeconds: input.slaSeconds,
  })

  const moved = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'begin_reconciliation',
    actor: input.actor,
    guards: {},
    statusEventPayload: { reconciliation_id: id, expected_minor: String(input.expected.minorUnits) },
  })
  if (!moved.ok) return { ok: false, reason: moved.reason, detail: moved }

  return { ok: true, reconciliationId: id, status: 'PENDING', transition: 'R01', deltaMinor: 0n, settlementMoved: true }
}

/* ── R02 / R03 — the observation ────────────────────────────────────────── */

/**
 * Compare an authoritative observation against what was expected.
 *
 * `R02` on an exact match, `R03` on anything else. What this function does
 * *not* do on a match is settle the settlement: `MATCHED` satisfies `F5`, and
 * five other conditions have to hold before `T20`. The caller runs the finality
 * evaluator next, and the evaluator is where "settled" is decided.
 *
 * On a mismatch it does two things in one commit — `R03` then `R05`. The frozen
 * table marks `R05` *"automatic; a mismatch is never left unattended"*, so
 * leaving `MISMATCH` as a resting state would be leaving it unattended by
 * construction. `T21` moves the settlement into `RECONCILIATION_MISMATCH` at
 * the same time.
 */
export async function applyObservation(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    source: ObservationSource
    /** `null` is a real answer — the provider stated no figure (`INV-26`). */
    observedMinor: bigint | null
    observedCurrency: string
    actor: PrincipalRef
  },
): Promise<ReconciliationResult> {
  const current = await lockReconciliation(tx, input.settlementId)
  if (!current) return { ok: false, reason: 'reconciliation_not_found' }

  if (current.status !== 'PENDING') {
    // An observation arriving after the question was answered is stale, not
    // wrong. Re-comparing would let a second provider message overwrite a
    // MATCHED result, which is a path to settling a mismatch.
    return {
      ok: true,
      reconciliationId: current.id,
      status: current.status,
      transition: current.status === 'MATCHED' ? 'R02' : 'R03',
      deltaMinor: BigInt(current.delta_minor),
      idempotent: true,
    }
  }

  const expected = money(current.currency as never, BigInt(current.expected_minor))
  const observation: Observation = {
    source: input.source,
    observedAmount:
      input.observedMinor === null
        ? null
        : money(input.observedCurrency as never, input.observedMinor),
    observedAt: new Date().toISOString(),
  }
  const verdict = compareObservation(expected, observation)
  const evaluated = evaluateReconciliationTransition('PENDING', verdict.trigger)
  if (!evaluated.ok) return { ok: false, reason: 'invalid_transition', detail: evaluated }

  const now = await databaseNow(tx)
  await tx
    .update(schema.reconciliations)
    .set({
      status: evaluated.to,
      observedMinor: input.observedMinor,
      deltaMinor: verdict.delta.minorUnits,
      source: input.source,
      evaluatedAt: now,
    })
    .where(eq(schema.reconciliations.id, current.id))

  const events = eventSink(tx)
  await events.audit(scope, {
    actor: input.actor,
    action: 'reconciliation.evaluated',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    after: {
      reconciliation_id: current.id,
      transition: evaluated.transition.id,
      status: evaluated.to,
      expected_minor: String(current.expected_minor),
      observed_minor: input.observedMinor === null ? null : String(input.observedMinor),
      delta_minor: String(verdict.delta.minorUnits),
      source: input.source,
      ...(verdict.kind === 'mismatch' ? { why: verdict.why } : {}),
    },
  })

  if (verdict.kind === 'matched') {
    // Deliberately no settlement transition here. F5 is satisfied; finality is
    // not, and this file is not allowed to decide that it is.
    return {
      ok: true,
      reconciliationId: current.id,
      status: 'MATCHED',
      transition: 'R02',
      deltaMinor: 0n,
    }
  }

  // R05, immediately: "a mismatch is never left unattended".
  await tx
    .update(schema.reconciliations)
    .set({ status: 'MANUAL_REVIEW' })
    .where(eq(schema.reconciliations.id, current.id))
  await events.audit(scope, {
    actor: input.actor,
    action: 'reconciliation.escalated',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    after: { reconciliation_id: current.id, transition: 'R05', status: 'MANUAL_REVIEW' },
    reason: 'a mismatch is never left unattended (R05)',
  })

  // T21 — the settlement side of the same fact.
  const moved = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'reconciled_mismatch',
    actor: input.actor,
    guards: { non_zero_delta: true },
    exceptionCode: 'RECONCILIATION_MISMATCH',
    companions: [
      {
        type: 'settlement.reconciled',
        subjectType: 'settlement',
        subjectId: input.settlementId,
        payload: {
          reconciliation_id: current.id,
          delta_minor: String(verdict.delta.minorUnits),
          why: verdict.why,
        },
      },
    ],
    statusEventPayload: {
      reconciliation_id: current.id,
      delta_minor: String(verdict.delta.minorUnits),
    },
  })
  if (!moved.ok) return { ok: false, reason: moved.reason, detail: moved }

  return {
    ok: true,
    reconciliationId: current.id,
    status: 'MANUAL_REVIEW',
    transition: 'R03',
    deltaMinor: verdict.delta.minorUnits,
    settlementMoved: true,
  }
}

/* ── R04 + T30 — the reconciliation poller ──────────────────────────────── */

/**
 * Escalate a reconciliation that never got an observation — `R04`, driving `T30`.
 *
 * This closes the typed deferred companion Stage 3 declared on `T30`. Stage 3
 * built the settlement side and recorded, in the transition table itself, that
 * `R04` was owed by Stage 6 — *"a prose note is something a later reader has to
 * find and believe; a typed field is something a test can assert"*. This is the
 * function that makes it true, and `resume-integrity.test.ts` asserts the
 * companion is now satisfied rather than merely declared.
 *
 * As with the payout SLA sweeper, there is no injectable clock. *"No
 * authoritative observation within SLA"* is a fact about elapsed time, and a
 * sweeper that accepted an `asOf` would let a caller declare it.
 */
export async function sweepReconciliationSla(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<ReconciliationResult> {
  const current = await lockReconciliation(tx, input.settlementId)
  if (!current) return { ok: false, reason: 'reconciliation_not_found' }
  if (current.status !== 'PENDING') {
    return { ok: false, reason: 'reconciliation_not_pending', detail: { status: current.status } }
  }

  const now = await databaseNow(tx)
  const elapsedSeconds = (now.getTime() - new Date(current.opened_at).getTime()) / 1000
  if (elapsedSeconds < current.sla_seconds) {
    return { ok: false, reason: 'sla_not_elapsed', detail: { elapsedSeconds } }
  }

  const evaluated = evaluateReconciliationTransition('PENDING', 'observation_overdue')
  if (!evaluated.ok) return { ok: false, reason: 'invalid_transition', detail: evaluated }

  await tx
    .update(schema.reconciliations)
    .set({ status: 'MANUAL_REVIEW', evaluatedAt: now })
    .where(eq(schema.reconciliations.id, current.id))

  await eventSink(tx).audit(scope, {
    actor: input.actor,
    action: 'reconciliation.observation_overdue',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    after: {
      reconciliation_id: current.id,
      transition: 'R04',
      elapsed_seconds: Math.floor(elapsedSeconds),
      sla_seconds: current.sla_seconds,
    },
    reason: 'no authoritative observation within the reconciliation SLA',
  })

  const moved = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'reconciliation_stalled',
    actor: input.actor,
    guards: { reconciliation_sla_elapsed: true },
    // FINALITY_EVIDENCE_MISSING, not RECONCILIATION_MISMATCH. T30's own note in
    // the frozen table says so, and the distinction is real: a mismatch means
    // we compared and the figures disagreed; this means nobody ever told us
    // what arrived. The resolution paths differ — obtain the evidence, versus
    // decide what to do about a delta — so conflating them would send an
    // operator looking for a discrepancy that does not exist.
    exceptionCode: 'FINALITY_EVIDENCE_MISSING',
    statusEventPayload: { reconciliation_id: current.id, transition: 'R04' },
  })
  if (!moved.ok) return { ok: false, reason: moved.reason, detail: moved }

  return {
    ok: true,
    reconciliationId: current.id,
    status: 'MANUAL_REVIEW',
    transition: 'R04',
    deltaMinor: BigInt(current.delta_minor),
    settlementMoved: true,
  }
}

/* ── R06 / R07 — the attributed resolution ──────────────────────────────── */

/**
 * Resolve a reconciliation in `MANUAL_REVIEW` — `INV-27`.
 *
 * > *"resolved only by an explicit, attributed operator decision that itself
 * > creates an event and, where value moved incorrectly, a compensating
 * > financial entry."*
 *
 * `compensationRequired` is asked for rather than inferred, and it is required
 * on `R06`. Whether value moved incorrectly is a fact only the person looking at
 * it has; a service that guessed would be answering `D-14` — the partial-credit
 * policy — by accident, and `D-14` is open.
 *
 * `R06` does not settle anything either. It makes `F5` satisfiable; the finality
 * evaluator still has to run, and the other five conditions still have to hold.
 */
export async function resolveReconciliation(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    trigger: Extract<ReconciliationTrigger, 'resolve_matched' | 'resolve_unresolvable'>
    actor: PrincipalRef
    note: string
    /** `R06` only, and required there. Never inferred. */
    compensationRequired?: boolean
  },
): Promise<ReconciliationResult> {
  const current = await lockReconciliation(tx, input.settlementId)
  if (!current) return { ok: false, reason: 'reconciliation_not_found' }

  const evaluated = evaluateReconciliationTransition(current.status, input.trigger)
  if (!evaluated.ok) {
    return { ok: false, reason: 'invalid_transition', detail: { from: current.status, trigger: input.trigger } }
  }
  if (input.note.trim().length === 0) {
    return { ok: false, reason: 'resolution_note_required' }
  }
  if (evaluated.transition.requiresCompensationDecision && input.compensationRequired === undefined) {
    return {
      ok: false,
      reason: 'compensation_decision_required',
      detail: {
        why:
          'INV-27 requires a compensating entry where value moved incorrectly; ' +
          'whether it did is a fact the resolver asserts, not one this service can infer',
      },
    }
  }

  // R06 declares the amounts agree after all, so the row must say so: a MATCHED
  // reconciliation carrying a non-zero delta is exactly the shape F5 checks
  // both halves for. The database CHECK refuses it anyway; setting it here means
  // the resolution states what it means rather than relying on being refused.
  const matched = evaluated.to === 'MATCHED'
  const now = await databaseNow(tx)
  await tx
    .update(schema.reconciliations)
    .set({
      status: evaluated.to,
      resolvedAt: now,
      resolvedBy: input.actor.id,
      resolutionNote: input.note,
      ...(input.compensationRequired === undefined
        ? {}
        : { compensationRequired: input.compensationRequired }),
      ...(matched ? { deltaMinor: 0n, observedMinor: BigInt(current.expected_minor) } : {}),
    })
    .where(eq(schema.reconciliations.id, current.id))

  await eventSink(tx).audit(scope, {
    actor: input.actor,
    action: `reconciliation.${input.trigger}`,
    subjectType: 'settlement',
    subjectId: input.settlementId,
    before: { status: current.status, delta_minor: String(current.delta_minor) },
    after: {
      reconciliation_id: current.id,
      transition: evaluated.transition.id,
      status: evaluated.to,
      compensation_required: input.compensationRequired ?? null,
    },
    reason: input.note,
  })

  return {
    ok: true,
    reconciliationId: current.id,
    status: evaluated.to,
    transition: evaluated.transition.id,
    deltaMinor: matched ? 0n : BigInt(current.delta_minor),
  }
}

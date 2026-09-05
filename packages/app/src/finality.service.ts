/**
 * The finality evaluator's transaction — Stage 6. `STATE_MACHINES.md § 8`.
 *
 * > *"`SETTLED` is created by exactly one component — the finality evaluator."*
 *
 * The evaluator itself is a pure function in the domain with no clock, no
 * override and no database. This file is the one place that gathers its
 * evidence, records its verdict, and — only on a unanimous one — drives `T20`.
 *
 * ## Three things this file deliberately does not have
 *
 * **No `force`, no `override`, no `skipConditions`.** (GATE-EXEMPT: this line
 * names the things that do not exist.) `§ 8.2` lists what must never create
 * finality, ending with *"an operator's belief, however senior the operator"*.
 * Every item on that list is a parameter somebody could have added, so the
 * defence is that none of them exists — in the domain's signature, in this
 * function's input, or anywhere between them.
 * `scripts/check-finality-integrity.mjs` fails the build if one appears.
 *
 * **No clock, and nothing that reads one.** *"F1–F6 are evidentiary, not
 * temporal."* The return observation window is `§ 8.6` triage on a different
 * aggregate; it is not imported here, and it could not be used if it were,
 * because `FinalityEvidence` has no field a duration could arrive in.
 *
 * **No path that writes `SETTLED` other than through `applyTransition`.** The
 * machine owns the status column, and `MACHINE_OWNED_COLUMNS` refuses a patch
 * that reaches for it.
 *
 * ## Why every evaluation is persisted, including the failures
 *
 * *"Every evaluation persists which conditions passed and which did not, so any
 * question about why a settlement is or is not final has a recorded answer."* A
 * table holding only successes answers *"why is this settled"* and not *"why is
 * this still not settled"* — and the second is the question operations actually
 * asks.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  authorizedTermsHash,
  evaluateFinality,
  instructionFromCanonicalObject,
  isWellFormedUtr,
  type FinalityEvidence,
  type FinalityVerdict,
  type PrincipalRef,
  type TenantScope,
} from '@inrsettle/domain'
import { applyTransition } from './settlement-transition.service.js'
import { eventSink } from './events.js'

export type FinalityResult =
  | {
      ok: true
      verdict: FinalityVerdict
      evaluationId: string
      /** True only where this call moved the settlement to `SETTLED`. */
      settled: boolean
      /** Set when the settlement was already `SETTLED` before this call. */
      alreadySettled?: boolean
    }
  | { ok: false; reason: string; detail?: unknown }

interface EvidenceRow {
  status: string
  authorized_at: Date | null
  authorized_by: string | null
  authorized_terms: unknown
  authorized_terms_hash: string | null
  destination_version_id: string | null
  open_exception_code: string | null
  drawdown_status: string | null
  facility_status: string | null
  attempt_status: string | null
  attempt_utr: string | null
  attempt_destination_version_id: string | null
  recon_status: string | null
  recon_delta_minor: string | number | bigint | null
  authorizer_held_capability: boolean
}

/**
 * Gather everything the evaluator may look at, under the settlement row lock.
 *
 * One query rather than several, because the evidence has to be a consistent
 * snapshot: reading the reconciliation, then the attempt, then the exception
 * leaves three windows in which one of them can change, and a verdict assembled
 * across those windows is a verdict about a state that never existed.
 *
 * `F1`'s capability check is answered from the audit trail rather than from
 * today's memberships. The condition is *"attributed to a principal that held
 * `settlement:authorize` **at the time**"*, and a principal whose roles changed
 * afterwards must not retroactively invalidate — or retroactively validate — an
 * authorization. Stage 3 enforced the capability at `T08` and audited the fact;
 * this reads that record.
 */
async function gatherEvidence(tx: Db, settlementId: string): Promise<EvidenceRow | null> {
  const rows = (await tx.execute(sql`
    SELECT s.status,
           s.authorized_at, s.authorized_by, s.authorized_terms, s.authorized_terms_hash,
           s.destination_version_id, s.open_exception_code,
           d.status  AS drawdown_status,
           f.status  AS facility_status,
           pa.status AS attempt_status,
           pa.utr    AS attempt_utr,
           pa.destination_version_id AS attempt_destination_version_id,
           r.status  AS recon_status,
           r.delta_minor AS recon_delta_minor,
           EXISTS (
             SELECT 1 FROM audit_log a
             WHERE a.subject_id = s.id
               AND a.action = 'settlement.authorize'
               AND a.actor_id = s.authorized_by
           ) AS authorizer_held_capability
    FROM settlements s
    LEFT JOIN drawdowns d            ON d.settlement_id = s.id AND d.status = 'CONFIRMED'
    LEFT JOIN liquidity_facilities f ON f.id = d.facility_id
    LEFT JOIN payout_attempts pa     ON pa.id = s.payout_attempt_id
    LEFT JOIN reconciliations r      ON r.settlement_id = s.id
    WHERE s.id = ${settlementId}
    FOR UPDATE OF s`)) as unknown as EvidenceRow[]
  return rows[0] ?? null
}

/**
 * Turn a row into the evidence the pure evaluator takes.
 *
 * `X1` is where the "recompute rather than trust" discipline lives. The
 * *authorized* hash is the column recorded at `T08`; the *executed* hash is
 * recomputed from the stored preimage. A row whose terms were edited **and**
 * whose hash was updated to match still fails, because the recomputation does
 * not consult the column it is being compared against.
 */
function toEvidence(row: EvidenceRow): FinalityEvidence {
  const instruction = instructionFromCanonicalObject(row.authorized_terms)
  // A preimage that will not parse fails X1 closed. An unverifiable commitment
  // is not a satisfied condition, and `null` here is never equal to the stored
  // hash, so it can only ever refuse.
  const recomputed = instruction === null ? null : authorizedTermsHash(instruction)

  return {
    authorization: {
      authorizedAt: row.authorized_at === null ? null : new Date(row.authorized_at).toISOString(),
      authorizedBy: row.authorized_by,
      actorHeldCapability: row.authorizer_held_capability === true,
    },
    funding: { drawdownStatus: row.drawdown_status, facilityStatus: row.facility_status },
    credit: {
      // F3 asks about the *channel*. A payout attempt only reaches CREDITED or
      // REJECTED through `applyPayoutOutcome`, which refuses untrusted evidence
      // outright — so a terminal credit on the row is, by construction, one
      // that arrived over a trusted channel or an authoritative pull.
      confirmationSource:
        row.attempt_status === 'CREDITED' || row.attempt_status === 'RETURNED'
          ? 'trusted_provider_event'
          : null,
      attemptStatus: row.attempt_status,
    },
    utr: { value: row.attempt_utr, wellFormed: isWellFormedUtr(row.attempt_utr) },
    reconciliation: {
      status: row.recon_status,
      deltaMinor: row.recon_delta_minor === null ? null : BigInt(row.recon_delta_minor),
    },
    openExceptionCode: row.open_exception_code,
    authorized: {
      termsHash: row.authorized_terms_hash,
      destinationVersionId: row.destination_version_id,
    },
    executed: {
      termsHash: recomputed,
      destinationVersionId: row.attempt_destination_version_id,
    },
  }
}

/**
 * Evaluate finality and, on a unanimous verdict, settle — `T20`.
 *
 * `issueReceipt` is injected rather than imported, and that is a deliberate
 * ordering constraint rather than a testing convenience: `T20`'s frozen
 * companion set is `settlement.reconciled` **and** `receipt.available`, and
 * `INV-32` refuses a status change that does not write exactly its declared
 * events. The receipt must therefore exist inside this transaction. Passing the
 * issuer in means this function cannot be called in a way that promises a
 * receipt event without a receipt behind it.
 */
export async function evaluateAndSettle(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    actor: PrincipalRef
    /** Issues the receipt inside this transaction. Returns its id and hash. */
    issueReceipt: (tx: Db) => Promise<{ receiptId: string; contentHash: string }>
  },
): Promise<FinalityResult> {
  const row = await gatherEvidence(tx, input.settlementId)
  if (!row) return { ok: false, reason: 'settlement_not_found' }

  const verdict = evaluateFinality(toEvidence(row))

  // Recorded before anything is decided, and recorded whatever the answer.
  const evaluationId = newId('finalityEvaluation')
  await tx.insert(schema.finalityEvaluations).values({
    id: evaluationId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    settlementId: input.settlementId,
    final: verdict.final,
    conditions: verdict.conditions as never,
    missing: [...verdict.missing],
  })

  if (row.status === 'SETTLED') {
    // Already final. `INV-38` makes SETTLED terminal, so there is nothing to do
    // and nothing to refuse — the evaluation above is still worth keeping as a
    // record that the question was asked again and the answer had not changed.
    return { ok: true, verdict, evaluationId, settled: false, alreadySettled: true }
  }

  if (!verdict.final) {
    await eventSink(tx).audit(scope, {
      actor: input.actor,
      action: 'settlement.finality_refused',
      subjectType: 'settlement',
      subjectId: input.settlementId,
      after: { evaluation_id: evaluationId, missing: verdict.missing },
      reason: verdict.conditions
        .filter((c) => !c.met)
        .map((c) => `${c.condition}: ${c.because}`)
        .join('; '),
    })
    return { ok: true, verdict, evaluationId, settled: false }
  }

  // The receipt is cut before the transition, because T20's companion set
  // promises `receipt.available` and an event announcing an artifact that does
  // not exist is worse than no event.
  const receipt = await input.issueReceipt(tx)

  const moved = await applyTransition(tx, scope, {
    settlementId: input.settlementId,
    trigger: 'reconciled_matched',
    actor: input.actor,
    guards: { finality_conditions_met: true },
    patch: { settledAt: new Date(), receiptId: receipt.receiptId },
    companions: [
      {
        type: 'settlement.reconciled',
        subjectType: 'settlement',
        subjectId: input.settlementId,
        payload: { evaluation_id: evaluationId, delta_minor: '0' },
      },
      {
        type: 'receipt.available',
        subjectType: 'settlement',
        subjectId: input.settlementId,
        payload: { receipt_id: receipt.receiptId, content_hash: receipt.contentHash },
      },
    ],
    statusEventPayload: {
      evaluation_id: evaluationId,
      receipt_id: receipt.receiptId,
      content_hash: receipt.contentHash,
    },
  })
  if (!moved.ok) return { ok: false, reason: moved.reason, detail: moved }

  return { ok: true, verdict, evaluationId, settled: true }
}

/**
 * Evaluate without settling — the read-only question.
 *
 * Exists because *"why is this not settled yet"* is asked far more often than
 * a settlement is settled, and answering it should not require a caller willing
 * to settle. Same evidence, same evaluator, no transition.
 */
export async function explainFinality(
  tx: Db,
  scope: TenantScope,
  settlementId: string,
): Promise<{ ok: true; verdict: FinalityVerdict } | { ok: false; reason: string }> {
  const row = await gatherEvidence(tx, settlementId)
  if (!row) return { ok: false, reason: 'settlement_not_found' }
  void scope
  return { ok: true, verdict: evaluateFinality(toEvidence(row)) }
}

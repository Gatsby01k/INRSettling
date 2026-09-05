/**
 * The settlement transition service — the **only** writer of
 * `settlements.status`.
 *
 * Nothing else in the system updates that column. Not a route handler, not a
 * worker, not a UI component, not a migration, not an ops helper. A test greps
 * the tree to keep that true, and the database's pairing trigger makes a
 * bypass fail even from raw SQL.
 *
 * Every status-changing transaction does the same six things, in this order:
 *
 *   1. takes the settlement row lock, so concurrent transitions serialise;
 *   2. asserts the expected source state and evaluates the frozen guards;
 *   3. writes the new status (and the derived customer status);
 *   4. writes exactly one status event;
 *   5. writes zero or more companion events;
 *   6. records the actor and audits.
 *
 * All of it in one transaction. The caller supplies the guard answers, because
 * the domain must not read the database and the application must not decide
 * what the machine allows.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  customerStatusColumn,
  evaluateTransition,
  isStatusEvent,
  type CompanionEvent,
  type ExceptionCode,
  type GuardContext,
  type PrincipalRef,
  type SettlementStatus,
  type TenantScope,
  type Trigger,
} from '@inrsettle/domain'
import { eventSink } from './events.js'

/**
 * Columns this service computes for itself. A caller that supplies one is not
 * setting a field — it is overwriting the machine's own answer, which is the
 * same thing as not having a machine.
 *
 * The concrete hole this closes: `patch` used to be spread *after* `status`, so
 * `applyTransition({ trigger: 'resolve_resume', patch: { status: 'SETTLED' } })`
 * would run every guard for T22, pass them, and then write `SETTLED`. The event
 * would say the settlement resumed; the row would say it had paid out. That is
 * exactly the state-machine bypass the transition service exists to prevent,
 * available to any caller, with no raw SQL required.
 *
 * Note what is *not* here. `authorizedTerms`, `pointOfNoReturnAt` and
 * `destinationVersionId` are legitimately caller-supplied — they are the payload
 * of a transition, not the machine's bookkeeping — and the database freezes each
 * one the moment it is written (INV-16, INV-36). Protecting them here as well
 * would only mean authorization could not write the terms it authorizes.
 *
 * Both spellings are listed. Drizzle takes camelCase keys, so `status` is the
 * live attack; `exception_entered_from` would be silently dropped rather than
 * applied. A caller that sends it still believed it was doing something, and a
 * refusal tells them the truth where a silent no-op would not.
 */
const MACHINE_OWNED_COLUMNS: ReadonlySet<string> = new Set([
  'status',
  'customerStatus',
  'customer_status',
  'version',
  'exceptionEnteredFrom',
  'exception_entered_from',
  'openExceptionCode',
  'open_exception_code',
])

export type TransitionFailure =
  | { reason: 'settlement_not_found' }
  | { reason: 'protected_field'; fields: readonly string[] }
  | { reason: 'invalid_transition'; from: SettlementStatus; trigger: Trigger }
  | { reason: 'guard_failed'; transition: string; failed: readonly string[] }
  | { reason: 'guard_unanswered'; transition: string; unanswered: readonly string[] }
  | { reason: 'resume_target_unknown'; transition: string }
  | { reason: 'stale_version'; expected: number; actual: number }
  | { reason: 'illegal_companion'; events: readonly string[] }

export type TransitionOutcome =
  | {
      ok: true
      transition: string
      from: SettlementStatus
      /** Null when the transition is an annotation (T26). */
      to: SettlementStatus | null
      version: number
    }
  | ({ ok: false } & TransitionFailure)

export interface CompanionEmission {
  readonly type: CompanionEvent
  readonly subjectType: string
  readonly subjectId: string
  readonly payload?: Record<string, unknown>
}

export interface ApplyTransitionInput {
  readonly settlementId: string
  readonly trigger: Trigger
  readonly actor: PrincipalRef
  /** Answers to the frozen guards, gathered by the caller under this same lock. */
  readonly guards: GuardContext
  /** Optimistic check. When supplied, a concurrent change is refused. */
  readonly expectedVersion?: number
  /** Companions this transition emits. Validated against the frozen table. */
  readonly companions?: readonly CompanionEmission[]
  /**
   * Additional columns the transition sets — its payload. Never `status`,
   * `customerStatus`, `version`, `exceptionEnteredFrom` or `openExceptionCode`:
   * those are computed here, and supplying one is refused rather than obeyed.
   */
  readonly patch?: Record<string, unknown>
  readonly statusEventPayload?: Record<string, unknown>
  /** For a transition into EXCEPTION. */
  readonly exceptionCode?: ExceptionCode
  readonly reason?: string
}

/**
 * Apply one transition.
 *
 * Returns a result rather than throwing on refusal. A refusal that records
 * something — and several do — must not roll back the record of the refusal.
 * That rule was learned in Stage 1 and is applied here from the start.
 */
export async function applyTransition(
  tx: Db,
  scope: TenantScope,
  input: ApplyTransitionInput,
): Promise<TransitionOutcome> {
  // (0) Refuse a patch that reaches for the machine's own columns. Checked
  //     before the lock is taken, because it is a fact about the call rather
  //     than about the row, and because a caller trying this deserves a refusal
  //     rather than a lock it might hold while being wrong.
  const trespassing = Object.keys(input.patch ?? {}).filter((k) => MACHINE_OWNED_COLUMNS.has(k))
  if (trespassing.length > 0) {
    return { ok: false, reason: 'protected_field', fields: trespassing }
  }

  // (1) Serialize. Every transition on this settlement — and the cancellation
  //     annotation, and the dispatch boundary — take this same lock, which is
  //     what gives them a total order rather than a race.
  const locked = await tx.execute(sql`
    SELECT id, status, version, exception_entered_from, point_of_no_return_at,
           cancellation_requested_at, authorized_at
    FROM settlements
    WHERE id = ${input.settlementId}
    FOR UPDATE`)
  const rows = locked as unknown as {
    id: string
    status: SettlementStatus
    version: number
    exception_entered_from: SettlementStatus | null
    point_of_no_return_at: Date | null
    cancellation_requested_at: Date | null
    authorized_at: Date | null
  }[]
  const current = rows[0]
  if (!current) return { ok: false, reason: 'settlement_not_found' }

  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    return { ok: false, reason: 'stale_version', expected: input.expectedVersion, actual: current.version }
  }

  // (2) Ask the frozen table. The domain decides; this service only carries out.
  const evaluated = evaluateTransition({
    from: current.status,
    trigger: input.trigger,
    guards: input.guards,
    ...(current.exception_entered_from ? { exceptionEnteredFrom: current.exception_entered_from } : {}),
  })

  if (!evaluated.ok) {
    switch (evaluated.error) {
      case 'invalid_transition':
        return { ok: false, reason: 'invalid_transition', from: current.status, trigger: input.trigger }
      case 'guard_failed':
        return { ok: false, reason: 'guard_failed', transition: evaluated.transition, failed: evaluated.failed }
      case 'guard_unanswered':
        return {
          ok: false,
          reason: 'guard_unanswered',
          transition: evaluated.transition,
          unanswered: evaluated.unanswered,
        }
      case 'resume_target_unknown':
        return { ok: false, reason: 'resume_target_unknown', transition: evaluated.transition }
    }
  }

  // A companion the frozen table does not permit for this transition is a bug
  // in the caller, not a thing to let through: the table names the exact set.
  const permitted = new Set<string>(evaluated.permittedCompanions)
  const offered = input.companions ?? []
  const illegal = offered.filter((c) => !permitted.has(c.type))
  if (illegal.length > 0) {
    return { ok: false, reason: 'illegal_companion', events: illegal.map((c) => c.type) }
  }

  const events = eventSink(tx)
  const now = new Date()

  // (3) Write the new status, or — for T26 — only the annotation.
  let nextVersion = current.version
  if (evaluated.to !== null) {
    const openExceptionCode =
      evaluated.to === 'EXCEPTION' ? (input.exceptionCode ?? null) : null

    // The caller's payload goes in *first* and the machine's answers overwrite
    // it. With the guard above this is belt and braces — but the guard is a
    // list, and lists are edited by people, whereas this ordering is structural:
    // even a column someone forgets to protect cannot displace a computed one.
    const patch: Record<string, unknown> = {
      ...(input.patch ?? {}),
      status: evaluated.to,
      // (INV-18) Derived here and nowhere else.
      customerStatus: customerStatusColumn({
        status: evaluated.to,
        openExceptionCode,
      }),
      updatedAt: now,
    }
    if (evaluated.to === 'EXCEPTION') {
      patch['exceptionEnteredFrom'] = current.status
      patch['openExceptionCode'] = openExceptionCode
    } else if (current.status === 'EXCEPTION') {
      // Leaving an exception clears the open code but keeps where it came from,
      // because T22 needs it and history should not be erased by resolution.
      patch['openExceptionCode'] = null
    }

    await tx
      .update(schema.settlements)
      .set(patch as never)
      .where(and(eq(schema.settlements.id, input.settlementId), eq(schema.settlements.version, current.version)))
    nextVersion = current.version + 1
  } else if (input.patch) {
    // T26: an annotation. It changes fields but not status, and the pairing
    // trigger will require that no status event accompanies it.
    await tx
      .update(schema.settlements)
      .set(input.patch as never)
      .where(eq(schema.settlements.id, input.settlementId))
  }

  // (4) Exactly one status event, when and only when status moved.
  if (evaluated.statusEvent !== null) {
    await events.event(scope, {
      type: evaluated.statusEvent,
      subjectType: 'settlement',
      subjectId: input.settlementId,
      actor: input.actor,
      payload: {
        transition: evaluated.transition.id,
        from: current.status,
        to: evaluated.to,
        ...(input.statusEventPayload ?? {}),
      },
      deliver: true,
    })
  }

  // (5) Companions.
  for (const companion of offered) {
    await events.event(scope, {
      type: companion.type,
      subjectType: companion.subjectType,
      subjectId: companion.subjectId,
      actor: input.actor,
      payload: companion.payload ?? {},
      deliver: true,
    })
  }

  // (6) The actor, on the record.
  await events.audit(scope, {
    actor: input.actor,
    action: `settlement.${input.trigger}`,
    subjectType: 'settlement',
    subjectId: input.settlementId,
    before: { status: current.status, version: current.version },
    after: { status: evaluated.to ?? current.status, transition: evaluated.transition.id },
    ...(input.reason ? { reason: input.reason } : {}),
  })

  return {
    ok: true,
    transition: evaluated.transition.id,
    from: current.status,
    to: evaluated.to,
    version: nextVersion,
  }
}

/**
 * A companion helper for the common shapes, so call sites do not hand-build
 * event envelopes and drift.
 */
export const companion = {
  quoteLocked: (quoteId: string): CompanionEmission => ({
    type: 'quote.locked',
    subjectType: 'quote',
    subjectId: quoteId,
  }),
  quoteConsumed: (quoteId: string, settlementId: string): CompanionEmission => ({
    type: 'quote.consumed',
    subjectType: 'quote',
    subjectId: quoteId,
    payload: { settlement_id: settlementId },
  }),
  quoteExpired: (quoteId: string): CompanionEmission => ({
    type: 'quote.expired',
    subjectType: 'quote',
    subjectId: quoteId,
  }),
  preflightCompleted: (settlementId: string, payload: Record<string, unknown>): CompanionEmission => ({
    type: 'settlement.preflight_completed',
    subjectType: 'settlement',
    subjectId: settlementId,
    payload,
  }),
  cancellationRequested: (settlementId: string): CompanionEmission => ({
    type: 'settlement.cancellation_requested',
    subjectType: 'settlement',
    subjectId: settlementId,
  }),
}

/** Guard against a companion being passed off as a status event. */
export function assertCompanion(type: string): asserts type is CompanionEvent {
  if (isStatusEvent(type)) {
    throw new Error(`${type} is a status event and cannot be emitted as a companion (INV-32)`)
  }
}

/** Create a settlement (T01). Separate because there is no row to lock yet. */
export async function createSettlement(
  tx: Db,
  scope: TenantScope,
  input: {
    beneficiaryId: string
    destinationId?: string | undefined
    recipientAmountMinor: bigint
    fundingCurrency: string
    purposeCode?: string | undefined
    externalReference?: string | undefined
    idempotencyKey?: string | undefined
    replacesSettlementId?: string | undefined
    actor: PrincipalRef
  },
): Promise<{ id: string }> {
  const id = newId('settlement')
  await tx.insert(schema.settlements).values({
    id,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    beneficiaryId: input.beneficiaryId,
    destinationId: input.destinationId ?? null,
    recipientAmountMinor: input.recipientAmountMinor,
    recipientAmountCurrency: 'INR',
    fundingCurrency: input.fundingCurrency,
    purposeCode: input.purposeCode ?? null,
    externalReference: input.externalReference ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    replacesSettlementId: input.replacesSettlementId ?? null,
    status: 'DRAFT',
    // DRAFT has no customer status: drafts appear only in the composing surface.
    customerStatus: null,
    createdBy: input.actor.id,
  })

  const events = eventSink(tx)
  await events.event(scope, {
    type: 'settlement.created',
    subjectType: 'settlement',
    subjectId: id,
    actor: input.actor,
    payload: { transition: 'T01', to: 'DRAFT' },
    deliver: true,
  })
  await events.audit(scope, {
    actor: input.actor,
    action: 'settlement.create',
    subjectType: 'settlement',
    subjectId: id,
    after: { status: 'DRAFT', transition: 'T01' },
  })
  return { id }
}

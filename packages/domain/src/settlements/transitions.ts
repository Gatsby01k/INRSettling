/**
 * The settlement transition machine — `STATE_MACHINES.md § 4`, T01–T30.
 *
 * **This table is the only place the machine is defined.** Nothing else decides
 * what a settlement may do next: no route handler, no worker, no UI component,
 * no migration and no ops helper. Everything that changes a settlement's status
 * goes through `evaluateTransition` and then through the single application
 * writer that applies it.
 *
 * The table is *data*, not a switch statement, for three reasons that all
 * showed up in Stage 1 and Stage 2: a table can be checked for exhaustiveness,
 * it can be compared row-by-row against the frozen document by a test, and it
 * cannot grow a quiet extra branch in a code review.
 *
 * Guards are declared as *names* here and evaluated against a `GuardContext`.
 * The domain does not read the database; the application assembles the context
 * under the right row lock and hands it over, which is what keeps the machine
 * pure and the concurrency honest.
 */
import type { SettlementStatus, SettlementStatusEvent, CompanionEvent } from './status.js'

export const TRANSITION_IDS = [
  'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10',
  'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T18', 'T19', 'T20',
  'T21', 'T22', 'T23', 'T24', 'T25', 'T26', 'T27', 'T28', 'T29', 'T30',
] as const
export type TransitionId = (typeof TRANSITION_IDS)[number]

export const TRIGGERS = [
  'create',
  'run_preflight',
  'preflight_passed',
  'preflight_blocked',
  'requirement_resolved',
  'attach_quote',
  'quote_expired',
  'authorize',
  'begin_reservation',
  'reservation_succeeded',
  'reservation_failed',
  'request_drawdown',
  'drawdown_confirmed',
  'drawdown_failed',
  'dispatch_payout',
  'payout_credited',
  'payout_rejected',
  'payout_timeout',
  'begin_reconciliation',
  'reconciled_matched',
  'reconciled_mismatch',
  'resolve_resume',
  'resolve_fail',
  'resolve_cancel',
  'cancel',
  'request_cancellation',
  'cancellation_honoured',
  'reservation_expired',
  'drawdown_timeout',
  'reconciliation_stalled',
] as const
export type Trigger = (typeof TRIGGERS)[number]

/**
 * Named guards. Each is a question the application must answer from state it
 * holds under the settlement row lock.
 *
 * `later_stage` guards are the honest part: Stage 3 owns the machine, not the
 * liquidity or payout domains. Those guards are declared, required, and
 * answered by the caller — in production by Stage 4/5, in Stage 3 by an
 * explicit test harness. They are never quietly defaulted to true.
 */
export const GUARDS = [
  'workspace_active',
  'environment_valid',
  'beneficiary_amount_purpose_present',
  'no_blocking_requirements',
  'has_blocking_requirements',
  'requirement_changed',
  'quote_attachable',
  'quote_expired_by_server_clock',
  'quote_valid_for_authorization',
  'beneficiary_verified',
  'destination_version_verified',
  'actor_may_authorize',
  'preflight_still_passing',
  'active_liquidity_facility',
  'no_cancellation_pending',
  'facility_active',
  'sufficient_availability',
  'active_reservation_exists',
  'provider_event_verified',
  'rail_selected',
  'before_point_of_no_return',
  'utr_present_and_well_formed',
  'trusted_provider_event',
  'rail_sla_elapsed',
  'finality_conditions_met',
  'non_zero_delta',
  'resolution_attributed',
  'no_value_delivered',
  'actor_may_cancel',
  'cancellation_pending',
  'at_checkpoint',
  'reservation_ttl_reached',
  'drawdown_sla_elapsed',
  'reconciliation_sla_elapsed',
] as const
export type Guard = (typeof GUARDS)[number]

/**
 * Guards whose answer belongs to a stage after this one. Stage 3 models the
 * contract; Stage 4 and Stage 5 supply the truth. A harness that answers these
 * is a test fixture and says so.
 */
export const LATER_STAGE_GUARDS: readonly Guard[] = [
  'active_liquidity_facility',
  'facility_active',
  'sufficient_availability',
  'active_reservation_exists',
  'provider_event_verified',
  'rail_selected',
  'utr_present_and_well_formed',
  'trusted_provider_event',
  'rail_sla_elapsed',
  'finality_conditions_met',
  'non_zero_delta',
  'reservation_ttl_reached',
  'drawdown_sla_elapsed',
  'reconciliation_sla_elapsed',
]

export interface Transition {
  readonly id: TransitionId
  /** Empty for T01 (creation). */
  readonly from: readonly SettlementStatus[]
  readonly trigger: Trigger
  /**
   * `null` for T26, which is an annotation and not a transition: it records
   * intent without moving the machine, which is why it is the one row with no
   * status event.
   */
  readonly to: SettlementStatus | null
  readonly guards: readonly Guard[]
  readonly statusEvent: SettlementStatusEvent | null
  readonly companionEvents: readonly CompanionEvent[]
  /**
   * Companions the transition chooses between rather than emitting together —
   * T23, T24 and T27 pick one depending on how far funding progressed.
   */
  readonly companionChoice?: readonly CompanionEvent[]
  /**
   * Companions the frozen table names but this stage cannot emit, because the
   * aggregate they annotate does not exist yet.
   *
   * Declared rather than omitted. A companion silently dropped is a gap nobody
   * finds; a companion declared as deferred, with the stage that owes it, is a
   * contract — `deferredCompanionsFor()` lists them, a test asserts none is
   * emitted early, and Stage 6 has an explicit item to close rather than a
   * discovery to make.
   */
  readonly deferredCompanions?: readonly DeferredCompanion[]
  readonly note?: string
}

/**
 * A companion the frozen table requires and a later stage owes.
 *
 * The alternative was to invent the aggregate now so the event had something to
 * attach to. A `Reconciliation` record created solely to satisfy a Stage 3
 * checklist would be a fabrication that later has to be unpicked — worse than
 * an honest, typed gap.
 */
export interface DeferredCompanion {
  /** The identifier the frozen document uses, e.g. `R04`. */
  readonly ref: string
  /** The aggregate the event annotates, which does not exist yet. */
  readonly aggregate: string
  /** The stage that owns building it. */
  readonly owedBy: 'Stage 4' | 'Stage 5' | 'Stage 6'
  readonly why: string
}

/** The normative table. Row order matches `STATE_MACHINES.md § 4`. */
export const TRANSITIONS: readonly Transition[] = [
  {
    id: 'T01',
    from: [],
    trigger: 'create',
    to: 'DRAFT',
    guards: ['workspace_active', 'environment_valid'],
    statusEvent: 'settlement.created',
    companionEvents: [],
  },
  {
    id: 'T02',
    from: ['DRAFT'],
    trigger: 'run_preflight',
    to: 'PREFLIGHTING',
    guards: ['beneficiary_amount_purpose_present'],
    statusEvent: 'settlement.preflight_started',
    companionEvents: [],
  },
  {
    id: 'T03',
    from: ['PREFLIGHTING'],
    trigger: 'preflight_passed',
    to: 'READY',
    guards: ['no_blocking_requirements'],
    statusEvent: 'settlement.ready',
    companionEvents: ['settlement.preflight_completed'],
  },
  {
    id: 'T04',
    from: ['PREFLIGHTING'],
    trigger: 'preflight_blocked',
    to: 'ACTION_REQUIRED',
    guards: ['has_blocking_requirements'],
    statusEvent: 'settlement.action_required',
    companionEvents: ['settlement.preflight_completed'],
    note: 'The only transition into ACTION_REQUIRED (INV-37).',
  },
  {
    id: 'T05',
    from: ['ACTION_REQUIRED'],
    trigger: 'requirement_resolved',
    to: 'PREFLIGHTING',
    guards: ['requirement_changed'],
    statusEvent: 'settlement.preflight_started',
    companionEvents: [],
  },
  {
    id: 'T06',
    from: ['READY'],
    trigger: 'attach_quote',
    to: 'QUOTED',
    guards: ['quote_attachable'],
    statusEvent: 'settlement.quoted',
    companionEvents: ['quote.locked'],
  },
  {
    id: 'T07',
    from: ['QUOTED'],
    trigger: 'quote_expired',
    to: 'READY',
    guards: ['quote_expired_by_server_clock'],
    statusEvent: 'settlement.ready',
    companionEvents: ['quote.expired'],
  },
  {
    id: 'T08',
    from: ['QUOTED'],
    trigger: 'authorize',
    to: 'AUTHORIZED',
    guards: [
      'quote_valid_for_authorization',
      'beneficiary_verified',
      'destination_version_verified',
      'actor_may_authorize',
      'preflight_still_passing',
      'active_liquidity_facility',
    ],
    statusEvent: 'settlement.authorized',
    companionEvents: ['quote.consumed'],
  },
  {
    id: 'T09',
    from: ['AUTHORIZED'],
    trigger: 'begin_reservation',
    to: 'LIQUIDITY_RESERVING',
    guards: ['facility_active', 'no_cancellation_pending'],
    statusEvent: 'settlement.liquidity_reservation_started',
    companionEvents: [],
  },
  {
    id: 'T10',
    from: ['LIQUIDITY_RESERVING'],
    trigger: 'reservation_succeeded',
    to: 'LIQUIDITY_RESERVED',
    guards: ['sufficient_availability'],
    statusEvent: 'settlement.liquidity_reserved',
    companionEvents: ['facility.reservation_created'],
  },
  {
    id: 'T11',
    from: ['LIQUIDITY_RESERVING'],
    trigger: 'reservation_failed',
    to: 'EXCEPTION',
    guards: [],
    statusEvent: 'settlement.exception_opened',
    companionEvents: [],
  },
  {
    id: 'T12',
    from: ['LIQUIDITY_RESERVED'],
    trigger: 'request_drawdown',
    to: 'DRAWDOWN_REQUESTED',
    guards: ['active_reservation_exists', 'no_cancellation_pending'],
    statusEvent: 'settlement.drawdown_requested',
    companionEvents: [],
  },
  {
    id: 'T13',
    from: ['DRAWDOWN_REQUESTED'],
    trigger: 'drawdown_confirmed',
    to: 'DRAWDOWN_CONFIRMED',
    guards: ['provider_event_verified'],
    statusEvent: 'settlement.drawdown_confirmed',
    companionEvents: ['facility.drawdown_confirmed'],
  },
  {
    id: 'T14',
    from: ['DRAWDOWN_REQUESTED'],
    trigger: 'drawdown_failed',
    to: 'EXCEPTION',
    guards: ['provider_event_verified'],
    statusEvent: 'settlement.exception_opened',
    companionEvents: ['facility.reservation_released'],
  },
  {
    id: 'T15',
    from: ['DRAWDOWN_CONFIRMED'],
    trigger: 'dispatch_payout',
    to: 'PAYOUT_SUBMITTED',
    guards: [
      'rail_selected',
      'destination_version_verified',
      'no_cancellation_pending',
      'before_point_of_no_return',
    ],
    statusEvent: 'settlement.payout_submitted',
    companionEvents: [],
    note: 'The dispatch transaction. Its commit is the point of no return (INV-36).',
  },
  {
    id: 'T16',
    from: ['PAYOUT_SUBMITTED'],
    trigger: 'payout_credited',
    to: 'PAYOUT_CONFIRMED',
    guards: ['trusted_provider_event', 'utr_present_and_well_formed'],
    statusEvent: 'settlement.payout_confirmed',
    companionEvents: [],
  },
  {
    id: 'T17',
    from: ['PAYOUT_SUBMITTED'],
    trigger: 'payout_rejected',
    to: 'EXCEPTION',
    guards: ['trusted_provider_event'],
    statusEvent: 'settlement.exception_opened',
    companionEvents: [],
  },
  {
    id: 'T18',
    from: ['PAYOUT_SUBMITTED'],
    trigger: 'payout_timeout',
    to: 'EXCEPTION',
    guards: ['rail_sla_elapsed'],
    statusEvent: 'settlement.exception_opened',
    companionEvents: [],
    note: 'Never auto-retry (INV-24).',
  },
  {
    id: 'T19',
    from: ['PAYOUT_CONFIRMED'],
    trigger: 'begin_reconciliation',
    to: 'RECONCILING',
    guards: [],
    statusEvent: 'settlement.reconciliation_started',
    companionEvents: [],
  },
  {
    id: 'T20',
    from: ['RECONCILING'],
    trigger: 'reconciled_matched',
    to: 'SETTLED',
    guards: ['finality_conditions_met'],
    statusEvent: 'settlement.settled',
    companionEvents: ['settlement.reconciled', 'receipt.available'],
  },
  {
    id: 'T21',
    from: ['RECONCILING'],
    trigger: 'reconciled_mismatch',
    to: 'EXCEPTION',
    guards: ['non_zero_delta'],
    statusEvent: 'settlement.exception_opened',
    companionEvents: ['settlement.reconciled'],
  },
  {
    id: 'T22',
    from: ['EXCEPTION'],
    trigger: 'resolve_resume',
    to: null,
    guards: ['resolution_attributed'],
    statusEvent: 'settlement.exception_resolved',
    companionEvents: [],
    note: 'Resumes to exception_entered_from; the destination is data, not a constant.',
  },
  {
    id: 'T23',
    from: ['EXCEPTION'],
    trigger: 'resolve_fail',
    to: 'FAILED',
    guards: ['resolution_attributed', 'no_value_delivered'],
    statusEvent: 'settlement.failed',
    companionEvents: [],
    companionChoice: ['facility.reservation_released', 'facility.repayment_requested'],
  },
  {
    id: 'T24',
    from: ['EXCEPTION'],
    trigger: 'resolve_cancel',
    to: 'CANCELLED',
    guards: ['resolution_attributed', 'before_point_of_no_return'],
    statusEvent: 'settlement.cancelled',
    companionEvents: [],
    companionChoice: ['facility.reservation_released', 'facility.repayment_requested'],
  },
  {
    id: 'T25',
    from: ['DRAFT', 'READY', 'QUOTED', 'ACTION_REQUIRED'],
    trigger: 'cancel',
    to: 'CANCELLED',
    guards: ['actor_may_cancel'],
    statusEvent: 'settlement.cancelled',
    companionEvents: [],
    companionChoice: ['quote.expired'],
  },
  {
    id: 'T26',
    from: [
      'AUTHORIZED',
      'LIQUIDITY_RESERVING',
      'LIQUIDITY_RESERVED',
      'DRAWDOWN_REQUESTED',
      'DRAWDOWN_CONFIRMED',
    ],
    trigger: 'request_cancellation',
    to: null,
    guards: ['before_point_of_no_return', 'actor_may_cancel'],
    statusEvent: null,
    companionEvents: ['settlement.cancellation_requested'],
    note: 'An annotation, not a transition. No status change, so no status event.',
  },
  {
    id: 'T27',
    from: ['AUTHORIZED', 'LIQUIDITY_RESERVED', 'DRAWDOWN_CONFIRMED'],
    trigger: 'cancellation_honoured',
    to: 'CANCELLED',
    guards: ['cancellation_pending', 'at_checkpoint', 'before_point_of_no_return'],
    statusEvent: 'settlement.cancelled',
    companionEvents: [],
    companionChoice: ['facility.reservation_released', 'facility.repayment_requested'],
    note: 'From DRAWDOWN_CONFIRMED it is a repayment, never a release (INV-22).',
  },
  {
    id: 'T28',
    from: ['LIQUIDITY_RESERVED'],
    trigger: 'reservation_expired',
    to: 'EXCEPTION',
    guards: ['reservation_ttl_reached'],
    statusEvent: 'settlement.exception_opened',
    companionEvents: ['facility.reservation_expired'],
  },
  {
    id: 'T29',
    from: ['DRAWDOWN_REQUESTED'],
    trigger: 'drawdown_timeout',
    to: 'EXCEPTION',
    guards: ['drawdown_sla_elapsed'],
    statusEvent: 'settlement.exception_opened',
    companionEvents: [],
  },
  {
    id: 'T30',
    from: ['RECONCILING'],
    trigger: 'reconciliation_stalled',
    to: 'EXCEPTION',
    guards: ['reconciliation_sla_elapsed'],
    statusEvent: 'settlement.exception_opened',
    companionEvents: [],
    deferredCompanions: [
      {
        ref: 'R04',
        aggregate: 'Reconciliation',
        owedBy: 'Stage 6',
        why:
          'R04 annotates the reconciliation record, and reconciliation is Stage 6. ' +
          'Emitting it now would mean inventing a Reconciliation aggregate for a ' +
          'checklist, and an event about a record that does not exist is not evidence.',
      },
    ],
    note: 'Opens FINALITY_EVIDENCE_MISSING. Owes the R04 reconciliation companion to Stage 6.',
  },
]

/** Every companion the frozen table requires and a later stage still owes. */
export function deferredCompanions(): readonly {
  transition: TransitionId
  companion: DeferredCompanion
}[] {
  return TRANSITIONS.flatMap((t) =>
    (t.deferredCompanions ?? []).map((companion) => ({ transition: t.id, companion })),
  )
}

export function deferredCompanionsFor(stage: DeferredCompanion['owedBy']): readonly {
  transition: TransitionId
  companion: DeferredCompanion
}[] {
  return deferredCompanions().filter((d) => d.companion.owedBy === stage)
}

/* ── Evaluation ────────────────────────────────────────────────────────── */

/** Answers to the named guards, assembled by the application under a row lock. */
export type GuardContext = Partial<Record<Guard, boolean>>

export interface TransitionRequest {
  readonly from: SettlementStatus | null
  readonly trigger: Trigger
  readonly guards: GuardContext
  /** Required for T22, whose destination is `exception_entered_from`. */
  readonly exceptionEnteredFrom?: SettlementStatus | undefined
}

export type TransitionResult =
  | {
      readonly ok: true
      readonly transition: Transition
      /** Resolved destination. Null for T26, which does not move the machine. */
      readonly to: SettlementStatus | null
      readonly statusEvent: SettlementStatusEvent | null
      readonly requiredCompanions: readonly CompanionEvent[]
      readonly permittedCompanions: readonly CompanionEvent[]
    }
  | { readonly ok: false; readonly error: 'invalid_transition'; readonly from: SettlementStatus | null; readonly trigger: Trigger }
  | { readonly ok: false; readonly error: 'guard_failed'; readonly transition: TransitionId; readonly failed: readonly Guard[] }
  | { readonly ok: false; readonly error: 'guard_unanswered'; readonly transition: TransitionId; readonly unanswered: readonly Guard[] }
  | { readonly ok: false; readonly error: 'resume_target_unknown'; readonly transition: TransitionId }

/**
 * The single entry point. Anything not explicitly legal is `invalid_transition`
 * — there is no permissive branch and no default.
 *
 * A guard the caller did not answer is `guard_unanswered`, **not** a failure and
 * **not** a pass. Treating an unanswered guard as false would look safe and
 * would hide a caller that forgot to load state; treating it as true would be a
 * hole. Making it its own error means the omission is visible.
 */
export function evaluateTransition(request: TransitionRequest): TransitionResult {
  const candidates = TRANSITIONS.filter((t) => {
    if (t.trigger !== request.trigger) return false
    if (request.from === null) return t.from.length === 0
    return (t.from as readonly string[]).includes(request.from)
  })

  const transition = candidates[0]
  if (!transition || candidates.length > 1) {
    // More than one candidate would mean the table is ambiguous for this pair;
    // a test asserts that never happens, and refusing here is the safe reading.
    return { ok: false, error: 'invalid_transition', from: request.from, trigger: request.trigger }
  }

  const unanswered = transition.guards.filter((g) => request.guards[g] === undefined)
  if (unanswered.length > 0) {
    return { ok: false, error: 'guard_unanswered', transition: transition.id, unanswered }
  }

  const failed = transition.guards.filter((g) => request.guards[g] === false)
  if (failed.length > 0) {
    return { ok: false, error: 'guard_failed', transition: transition.id, failed }
  }

  let to: SettlementStatus | null = transition.to
  if (transition.id === 'T22') {
    if (!request.exceptionEnteredFrom) {
      return { ok: false, error: 'resume_target_unknown', transition: transition.id }
    }
    to = request.exceptionEnteredFrom
  }

  return {
    ok: true,
    transition,
    to,
    statusEvent: transition.statusEvent,
    requiredCompanions: transition.companionEvents,
    permittedCompanions: [...transition.companionEvents, ...(transition.companionChoice ?? [])],
  }
}

/** Every `(from, trigger)` pair the table accepts. Used by the exhaustive test. */
export function legalPairs(): readonly { from: SettlementStatus | null; trigger: Trigger }[] {
  const out: { from: SettlementStatus | null; trigger: Trigger }[] = []
  for (const t of TRANSITIONS) {
    if (t.from.length === 0) out.push({ from: null, trigger: t.trigger })
    for (const from of t.from) out.push({ from, trigger: t.trigger })
  }
  return out
}

export function transitionById(id: TransitionId): Transition {
  const found = TRANSITIONS.find((t) => t.id === id)
  if (!found) throw new Error(`no such transition ${id}`)
  return found
}

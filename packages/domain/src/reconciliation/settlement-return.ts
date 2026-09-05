/**
 * `SettlementReturn` — `DOMAIN.md § 6.10`, `STATE_MACHINES.md § 6.6` and `§ 8.4`.
 *
 * A credited payout can come back. `STATE_MACHINES.md § 8.4` is careful about
 * what that is:
 *
 * > *"a real, later, independent fact about a rails-level execution, modelled
 * > as its own aggregate."*
 *
 * Independent is the load-bearing word, and it shapes this whole file. A return
 * never touches the settlement: not its status, not its row, not its receipt
 * (`INV-42`, `INV-48`). Everything here is about a new object that *references*
 * a settled settlement and knows it may not modify it. The settlement stays
 * `SETTLED`, because it was — the money did arrive, and it came back afterwards,
 * and those are two facts rather than one revised one.
 *
 * Three rules the frozen documents state that this module makes structural:
 *
 * - **`INV-39`** — opened only by a trusted provider event or an authoritative
 *   pull. `ReturnEvidence` has no member for an operator's belief or a customer
 *   claim, which is the cheapest way to honour a prohibition.
 * - **`INV-49`** — confirmed returns can never exceed what was delivered. The
 *   arithmetic lives here as a pure function so the service, the database
 *   `CHECK` and the tests can all be checked against one statement of it.
 * - **`INV-50`** — one real-world return is one row, deduplicated on
 *   `(payout_attempt_id, provider_return_reference)`.
 */
import type { Money } from '@inrsettle/money'

export const RETURN_STATUSES = [
  'OBSERVED',
  'CONFIRMED',
  'REPAID',
  'REJECTED',
  'MANUAL_REVIEW',
] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]

export const RETURN_TRIGGERS = [
  'open',
  'upheld',
  'not_upheld',
  'escalate',
  'repaid',
  'resolve_upheld',
  'resolve_not_upheld',
] as const
export type ReturnTrigger = (typeof RETURN_TRIGGERS)[number]

export const RETURN_TRANSITION_IDS = ['N01', 'N02', 'N03', 'N04', 'N05', 'N06', 'N07'] as const
export type ReturnTransitionId = (typeof RETURN_TRANSITION_IDS)[number]

export interface ReturnTransition {
  readonly id: ReturnTransitionId
  readonly from: readonly ReturnStatus[]
  readonly trigger: ReturnTrigger
  readonly to: ReturnStatus
  readonly guard: string
  /** `N02`/`N06`: the cumulative cap must be re-checked under the row lock. */
  readonly checksCap?: true
  /** `N02` only: confirming *requests* a repayment (Y01) — `INV-41`. */
  readonly requestsRepayment?: true
  /** `N06`/`N07`: an attributed operator decision, never an inferred one. */
  readonly requiresAttribution?: true
  /** The customer-facing event this transition fires, where it fires one. */
  readonly customerEvent?: string
}

/** The normative table. Row order matches `STATE_MACHINES.md § 6.6`. */
export const RETURN_TRANSITIONS: readonly ReturnTransition[] = [
  {
    id: 'N01',
    from: [],
    trigger: 'open',
    to: 'OBSERVED',
    guard:
      'trusted provider event or authoritative pull (INV-39); deduplicated on (payout_attempt_id, provider_return_reference) (INV-50)',
    customerEvent: 'settlement.return_observed',
  },
  {
    id: 'N02',
    from: ['OBSERVED'],
    trigger: 'upheld',
    to: 'CONFIRMED',
    guard:
      'authoritative check upholds it (INV-40) and the cumulative cap holds under the payout-attempt row lock (INV-49). Requests a Repayment (Y01)',
    checksCap: true,
    requestsRepayment: true,
    customerEvent: 'settlement.return_confirmed',
  },
  {
    id: 'N03',
    from: ['OBSERVED'],
    trigger: 'not_upheld',
    to: 'REJECTED',
    guard: 'authoritative check does not substantiate it; alarms',
    customerEvent: 'settlement.return_rejected',
  },
  {
    id: 'N04',
    from: ['OBSERVED', 'CONFIRMED'],
    trigger: 'escalate',
    to: 'MANUAL_REVIEW',
    guard:
      'unmapped reason code (INV-43), arrival outside the return observation window (§8.6), a cap breach (INV-49), or check SLA elapsed — return watcher',
  },
  {
    id: 'N05',
    from: ['CONFIRMED'],
    trigger: 'repaid',
    to: 'REPAID',
    guard: 'its Repayment reached CONFIRMED (Y03/Y06)',
    customerEvent: 'settlement.return_repaid',
  },
  {
    id: 'N06',
    from: ['MANUAL_REVIEW'],
    trigger: 'resolve_upheld',
    to: 'CONFIRMED',
    guard: 'attributed decision; cap re-checked',
    checksCap: true,
    requestsRepayment: true,
    requiresAttribution: true,
    customerEvent: 'settlement.return_confirmed',
  },
  {
    id: 'N07',
    from: ['MANUAL_REVIEW'],
    trigger: 'resolve_not_upheld',
    to: 'REJECTED',
    guard: 'attributed decision',
    requiresAttribution: true,
    customerEvent: 'settlement.return_rejected',
  },
]

export type ReturnEvaluation =
  | { readonly ok: true; readonly transition: ReturnTransition; readonly to: ReturnStatus }
  | {
      readonly ok: false
      readonly error: 'invalid_transition'
      readonly from: ReturnStatus | null
      readonly trigger: ReturnTrigger
    }

export function evaluateReturnTransition(
  from: ReturnStatus | null,
  trigger: ReturnTrigger,
): ReturnEvaluation {
  const match = RETURN_TRANSITIONS.find(
    (t) => t.trigger === trigger && (from === null ? t.from.length === 0 : t.from.includes(from)),
  )
  if (!match) return { ok: false, error: 'invalid_transition', from, trigger }
  return { ok: true, transition: match, to: match.to }
}

/**
 * The statuses that count against the cap — `INV-49`.
 *
 * > *"the sum of `amount` over its returns in status `CONFIRMED` or `REPAID`"*
 *
 * `OBSERVED` deliberately does not count. A return that has been reported but
 * not upheld is a claim, and reserving delivered value against unverified
 * claims would let a provider defect block legitimate returns. `MANUAL_REVIEW`
 * does not count either, for the same reason and one more: a return is routed
 * there precisely *because* something about it is unresolved.
 */
export const CAP_COUNTING_STATUSES: readonly ReturnStatus[] = ['CONFIRMED', 'REPAID']

export function countsTowardCap(status: ReturnStatus): boolean {
  return CAP_COUNTING_STATUSES.includes(status)
}

/* ── The closed reason taxonomy ─────────────────────────────────────────── */

/**
 * Why a credit came back, as a **closed** set.
 *
 * The same discipline as the exception taxonomy in `STATE_MACHINES.md § 7`:
 * closed taxonomy, open mapping. A provider that invents a new return reason
 * tomorrow must not be able to break ingestion, so its vocabulary is mapped by
 * the versioned provider mapping table (`INV-43`) and anything unmapped routes
 * to `RETURN_REASON_UNMAPPED` — which is not a member of the taxonomy pretending
 * to explain something, but an explicit statement that we do not yet know.
 */
export const RETURN_REASON_CODES = [
  /** The beneficiary account was closed between the credit and the return. */
  'BENEFICIARY_ACCOUNT_CLOSED',
  /** The receiving bank rejected the credit on account details. */
  'BENEFICIARY_ACCOUNT_INVALID',
  /** The receiving bank rejected on name comparison, downstream of the rail. */
  'BENEFICIARY_NAME_MISMATCH',
  /** The account exists but cannot receive credits (frozen, dormant). */
  'BENEFICIARY_ACCOUNT_BLOCKED',
  /** The beneficiary or their bank refused the credit. */
  'REFUSED_BY_BENEFICIARY',
  /** A compliance or screening decision at the receiving institution. */
  'COMPLIANCE_AT_BENEFICIARY_BANK',
  /** The rail itself reversed the credit for its own reasons. */
  'RAIL_REVERSAL',
  /**
   * The provider sent a reason nothing maps. Not an explanation — an admission,
   * and one that routes the return to `MANUAL_REVIEW` (`§ 8.4` clause 5).
   */
  'RETURN_REASON_UNMAPPED',
] as const
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number]

export const UNMAPPED_RETURN_REASON: ReturnReasonCode = 'RETURN_REASON_UNMAPPED'

/* ── `INV-49` — the cap ─────────────────────────────────────────────────── */

/**
 * What is known about how much was delivered.
 *
 * `null` is a distinct case from zero and is fatal to a confirmation, which is
 * the fail-closed reading: Stage 5 records `credited_minor` as `null` when the
 * provider stated no figure, and a cap against an unknown delivered amount is
 * not a cap. Confirming into that gap would let a return of any size through.
 */
export interface DeliveredEvidence {
  readonly deliveredMinor: bigint | null
  readonly currency: string
}

export type CapVerdict =
  | { readonly ok: true; readonly newTotalMinor: bigint; readonly headroomMinor: bigint }
  | {
      readonly ok: false
      readonly reason:
        | 'delivered_amount_unknown'
        | 'currency_mismatch'
        | 'exceeds_delivered'
        | 'not_positive'
      readonly detail: Record<string, unknown>
    }

/**
 * May this return be confirmed against what was delivered?
 *
 * Pure, and stated once. `INV-49` is enforced in three places — this function,
 * the row lock in the service, and a database `CHECK` that holds *"even against
 * a code path that forgets the lock"* — and three enforcements of one rule are
 * safe only while they are three readings of the same sentence. Putting the
 * arithmetic here means the service and the tests cannot drift from it, and the
 * `CHECK` is the same inequality written in SQL.
 *
 * Equality is allowed on purpose: a full return of exactly what was delivered
 * is the ordinary case, not a breach. The cap is on *exceeding*.
 */
export function checkReturnCap(input: {
  delivered: DeliveredEvidence
  /** The total already confirmed or repaid against this attempt. */
  confirmedSoFarMinor: bigint
  /** The return being confirmed now. */
  amount: Money
}): CapVerdict {
  const { delivered, confirmedSoFarMinor, amount } = input

  if (amount.minorUnits <= 0n) {
    return { ok: false, reason: 'not_positive', detail: { amountMinor: amount.minorUnits } }
  }
  if (delivered.deliveredMinor === null) {
    // Fail closed. The provider credited and would not say how much, so there
    // is no figure to cap against — and a cap against nothing is not a cap.
    return {
      ok: false,
      reason: 'delivered_amount_unknown',
      detail: { why: 'the provider stated no credited amount, so no cap can be evaluated' },
    }
  }
  if (delivered.currency !== amount.currency) {
    return {
      ok: false,
      reason: 'currency_mismatch',
      detail: { delivered: delivered.currency, returned: amount.currency },
    }
  }

  const newTotalMinor = confirmedSoFarMinor + amount.minorUnits
  if (newTotalMinor > delivered.deliveredMinor) {
    return {
      ok: false,
      reason: 'exceeds_delivered',
      detail: {
        deliveredMinor: delivered.deliveredMinor,
        confirmedSoFarMinor,
        thisReturnMinor: amount.minorUnits,
        wouldTotalMinor: newTotalMinor,
        overByMinor: newTotalMinor - delivered.deliveredMinor,
      },
    }
  }
  return {
    ok: true,
    newTotalMinor,
    headroomMinor: delivered.deliveredMinor - newTotalMinor,
  }
}

/* ── `INV-50` — the second deduplication key ────────────────────────────── */

/**
 * The identity of a real-world return.
 *
 * `INV-33` already makes a redelivered provider *event* a no-op. This is the
 * harder case the invariant names: *"the same underlying return reaching us
 * through two different channels — a webhook and a status pull, or two
 * providers' event types describing one event."* Those arrive with different
 * event ids, or with no event id at all, so the first key cannot see them.
 *
 * The reference is the provider's own id for the return. It is required rather
 * than optional: a return with no provider reference cannot be deduplicated at
 * all, and accepting one would mean a status pull could mint a duplicate of a
 * return a webhook already opened. A provider that reports returns without
 * identifying them is telling us something we need to know before we trust its
 * return reporting.
 */
export interface ReturnIdentity {
  readonly payoutAttemptId: string
  readonly providerReturnReference: string
}

export function returnDedupeKey(identity: ReturnIdentity): string {
  return `${identity.payoutAttemptId}:${identity.providerReturnReference}`
}

/* ── `§ 8.6` — the return observation window ────────────────────────────── */

/**
 * How a return's arrival time is triaged. **This has nothing to do with
 * finality**, and the frozen document is emphatic about why:
 *
 * (GATE-EXEMPT+3: the next three lines quote the frozen document verbatim.)
 * > *"'Finality hold window' implies `SETTLED` is provisional until the window
 * > elapses — that there is some later moment when a settlement becomes *more*
 * > final. There is not."*
 *
 * So this function takes a credit time and a return time and answers one
 * question — ordinary or anomalous — and it is deliberately not reachable from
 * `evaluateFinality`, which takes no clock at all. The two modules cannot be
 * accidentally wired together because the finality evaluator has nowhere to put
 * a duration.
 *
 * `D-04` is open on the **duration per rail**, so no number appears here. The
 * window is supplied by the caller from configuration, exactly as the payout
 * rail SLAs are, and a caller with no configured window gets the anomaly-free
 * reading rather than an invented one — see `triageReturnArrival`.
 */
export type ArrivalTriage =
  | { readonly within: true; readonly path: 'normal'; readonly elapsedSeconds: number }
  | {
      readonly within: false
      readonly path: 'anomaly'
      readonly elapsedSeconds: number
      readonly windowSeconds: number
      readonly why: string
    }

export function triageReturnArrival(input: {
  creditedAt: Date
  returnObservedAt: Date
  /**
   * The rail's configured window. `null` means the partner has not supplied one
   * — `D-04` — and the honest response is to treat every arrival as ordinary
   * rather than to invent a threshold. An invented window would send real
   * returns to `MANUAL_REVIEW` on the strength of a number nobody agreed.
   */
  windowSeconds: number | null
}): ArrivalTriage {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((input.returnObservedAt.getTime() - input.creditedAt.getTime()) / 1000),
  )
  if (input.windowSeconds === null || elapsedSeconds <= input.windowSeconds) {
    return { within: true, path: 'normal', elapsedSeconds }
  }
  return {
    within: false,
    path: 'anomaly',
    elapsedSeconds,
    windowSeconds: input.windowSeconds,
    why:
      `the return was observed ${elapsedSeconds}s after the credit, past the rail's ` +
      `${input.windowSeconds}s observation window — the provider's own reporting is in question`,
  }
}

/**
 * The status a newly opened return starts in.
 *
 * `N01` always produces `OBSERVED`; this decides whether the return is then
 * immediately escalated by `N04`, and says why. Two grounds, both from `§ 8.4`
 * and `§ 8.6`, and neither of them temporal in the finality sense:
 *
 * - an unmapped reason code (clause 5: *"An unrecognised reason is never a
 *   reason to drop one"*);
 * - arrival outside the rail's observation window (`§ 8.6`).
 */
export interface OpeningVerdict {
  readonly escalateImmediately: boolean
  readonly reasons: readonly string[]
}

export function verdictOnOpening(input: {
  reasonCode: ReturnReasonCode
  triage: ArrivalTriage
}): OpeningVerdict {
  const reasons: string[] = []
  if (input.reasonCode === UNMAPPED_RETURN_REASON) {
    reasons.push('the provider return reason is not in the mapping table (INV-43)')
  }
  if (!input.triage.within) reasons.push(input.triage.why)
  return { escalateImmediately: reasons.length > 0, reasons }
}

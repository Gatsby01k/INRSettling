/**
 * The finality evaluator — `STATE_MACHINES.md § 8.1`.
 *
 * > *"`SETTLED` is created by exactly one component — the finality evaluator —
 * > and only when **all** of F1–F6 hold."*
 *
 * Three properties the frozen document asks for, and each is visible in the
 * shape of this file rather than promised in a comment:
 *
 * **Pure.** It takes evidence and returns a verdict. It reads no database, calls
 * no provider, and has no clock — because *"F1–F6 are evidentiary, not
 * temporal"*, and an evaluator with a clock is one that can be asked what time
 * it is, which is the first step towards waiting.
 *
 * **It explains itself.** Every condition returns a sentence saying what was
 * looked at and what was found, for the passing case as well as the failing
 * one. A verdict that explains only its failures cannot answer *"why is this
 * settled"*, and that is the question an auditor asks.
 *
 * **It is the only component that can produce the answer.** There is no
 * override argument, no `force`, no `skipConditions` (GATE-EXEMPT: this line
 * names what is absent). `§ 8.2` is a list of things that must never create
 * finality, and the cheapest way to honour it is to give the function no
 * parameter that could express any of them.
 */

export const FINALITY_CONDITIONS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] as const
export type FinalityCondition = (typeof FINALITY_CONDITIONS)[number]

export const FINALITY_CONDITION_TEXT: Readonly<Record<FinalityCondition, string>> = {
  F1: 'An AUTHORIZED transition exists, attributed to a principal that held settlement:authorize at the time',
  F2: 'The funding leg is real: a confirmed drawdown against an active liquidity facility',
  F3: 'A terminal credit confirmation was received over a trusted channel',
  F4: 'A UTR is present and well-formed for the credited payout',
  F5: 'Reconciliation is MATCHED with a delta of exactly zero',
  F6: 'No blocking exception is open on the settlement',
}

/**
 * The two drift assertions `§ 8.1` adds after F1–F6.
 *
 * > *"It additionally asserts that the executed payout matches
 * > `authorized_terms_hash` and the frozen `destination_version_id` — a drift
 * > between what was authorized and what was executed blocks finality rather
 * > than being reconciled away."*
 *
 * Kept separate from F1–F6 rather than folded into them, because the frozen
 * document keeps them separate and because they answer a different question.
 * F1–F6 ask *did the evidence arrive*; these ask *is the thing we executed the
 * thing we authorized*. A settlement can have flawless evidence for the wrong
 * payment.
 */
export const DRIFT_CHECKS = ['X1', 'X2'] as const
export type DriftCheck = (typeof DRIFT_CHECKS)[number]

export const DRIFT_CHECK_TEXT: Readonly<Record<DriftCheck, string>> = {
  X1: 'The executed payout is against the authorized terms hash frozen at authorization',
  X2: 'The executed payout is against the destination version frozen at authorization',
}

/**
 * Everything the evaluator is allowed to look at.
 *
 * Assembled by the application under the settlement row lock and handed over
 * whole. The domain never reaches back for a field it forgot, which is what
 * makes "same inputs, same verdict" true rather than aspirational.
 */
export interface FinalityEvidence {
  /** F1 */
  readonly authorization: {
    readonly authorizedAt: string | null
    readonly authorizedBy: string | null
    /** Whether that principal held `settlement:authorize` **at the time**. */
    readonly actorHeldCapability: boolean
  }
  /** F2 */
  readonly funding: {
    readonly drawdownStatus: string | null
    readonly facilityStatus: string | null
  }
  /** F3 — the channel, not the content. */
  readonly credit: {
    readonly confirmationSource: 'trusted_provider_event' | 'authoritative_status_pull' | null
    readonly attemptStatus: string | null
  }
  /** F4 */
  readonly utr: {
    readonly value: string | null
    readonly wellFormed: boolean
  }
  /** F5 */
  readonly reconciliation: {
    readonly status: string | null
    readonly deltaMinor: bigint | null
  }
  /** F6 */
  readonly openExceptionCode: string | null
  /** X1, X2 */
  readonly authorized: {
    readonly termsHash: string | null
    readonly destinationVersionId: string | null
  }
  readonly executed: {
    readonly termsHash: string | null
    readonly destinationVersionId: string | null
  }
}

export interface ConditionVerdict {
  readonly condition: FinalityCondition | DriftCheck
  readonly met: boolean
  /** What was looked at and what was found. Present whether it passed or not. */
  readonly because: string
}

export interface FinalityVerdict {
  /** True only when every condition and both drift checks hold. */
  readonly final: boolean
  readonly conditions: readonly ConditionVerdict[]
  /** The subset that failed, so the caller does not have to filter. */
  readonly missing: readonly (FinalityCondition | DriftCheck)[]
}

/**
 * Evaluate finality. Same inputs, same verdict, always.
 *
 * Note what is *not* a parameter: no actor, no override, no tolerance, no
 * `asOf`. The signature is the safety property.
 */
export function evaluateFinality(evidence: FinalityEvidence): FinalityVerdict {
  const conditions: ConditionVerdict[] = [
    f1(evidence),
    f2(evidence),
    f3(evidence),
    f4(evidence),
    f5(evidence),
    f6(evidence),
    x1(evidence),
    x2(evidence),
  ]
  const missing = conditions.filter((c) => !c.met).map((c) => c.condition)
  return { final: missing.length === 0, conditions, missing }
}

function f1(e: FinalityEvidence): ConditionVerdict {
  const { authorizedAt, authorizedBy, actorHeldCapability } = e.authorization
  if (authorizedAt === null || authorizedBy === null) {
    return { condition: 'F1', met: false, because: 'no AUTHORIZED transition is recorded on this settlement' }
  }
  if (!actorHeldCapability) {
    return {
      condition: 'F1',
      met: false,
      // Named rather than described: an authorization by someone who had lost
      // the capability is a specific, investigable event.
      because: `authorized by ${authorizedBy}, who did not hold settlement:authorize at ${authorizedAt}`,
    }
  }
  return {
    condition: 'F1',
    met: true,
    because: `authorized at ${authorizedAt} by ${authorizedBy}, who held settlement:authorize at the time`,
  }
}

function f2(e: FinalityEvidence): ConditionVerdict {
  const { drawdownStatus, facilityStatus } = e.funding
  // V1 has exactly one funding path (`D-10`, closed), so there is no branch
  // here for a settlement funded some other way. Adding one "for later" would
  // be building the very alternative the decision closed.
  if (drawdownStatus !== 'CONFIRMED') {
    return {
      condition: 'F2',
      met: false,
      because: `the drawdown is ${drawdownStatus ?? 'absent'}, not CONFIRMED`,
    }
  }
  if (facilityStatus !== 'ACTIVE') {
    return {
      condition: 'F2',
      met: false,
      because: `the funding facility is ${facilityStatus ?? 'absent'}, not ACTIVE`,
    }
  }
  return { condition: 'F2', met: true, because: 'a confirmed drawdown against an ACTIVE liquidity facility' }
}

function f3(e: FinalityEvidence): ConditionVerdict {
  const { confirmationSource, attemptStatus } = e.credit
  if (attemptStatus !== 'CREDITED' && attemptStatus !== 'RETURNED') {
    // RETURNED is accepted here because it is only reachable *from* CREDITED
    // (P08). A settlement whose credit later came back was still credited, and
    // pretending otherwise would make a returned settlement retroactively
    // un-final — which is exactly what `INV-42` forbids.
    return {
      condition: 'F3',
      met: false,
      because: `the payout attempt is ${attemptStatus ?? 'absent'}; no terminal credit confirmation`,
    }
  }
  if (confirmationSource === null) {
    return {
      condition: 'F3',
      met: false,
      because: 'the credit confirmation did not arrive over a trusted channel',
    }
  }
  return {
    condition: 'F3',
    met: true,
    because: `terminal credit confirmed via ${confirmationSource}`,
  }
}

function f4(e: FinalityEvidence): ConditionVerdict {
  if (e.utr.value === null || e.utr.value.length === 0) {
    return { condition: 'F4', met: false, because: 'no UTR is recorded for the credited payout' }
  }
  if (!e.utr.wellFormed) {
    // A malformed UTR is worse than an absent one: absent is visibly
    // incomplete, malformed looks like proof and is not.
    return { condition: 'F4', met: false, because: `the recorded UTR ${e.utr.value} is not well-formed` }
  }
  return { condition: 'F4', met: true, because: `UTR ${e.utr.value} is present and well-formed` }
}

function f5(e: FinalityEvidence): ConditionVerdict {
  const { status, deltaMinor } = e.reconciliation
  if (status === null) {
    return { condition: 'F5', met: false, because: 'no reconciliation exists for this settlement' }
  }
  if (status !== 'MATCHED') {
    return { condition: 'F5', met: false, because: `reconciliation is ${status}, not MATCHED` }
  }
  // Both halves checked, because they are separately falsifiable. A MATCHED row
  // carrying a non-zero delta is the one case where trusting the status label
  // would settle a mismatch.
  if (deltaMinor !== 0n) {
    return {
      condition: 'F5',
      met: false,
      because: `reconciliation is MATCHED but carries a delta of ${deltaMinor ?? 'unknown'} minor units`,
    }
  }
  return { condition: 'F5', met: true, because: 'reconciliation is MATCHED with a delta of exactly zero' }
}

function f6(e: FinalityEvidence): ConditionVerdict {
  if (e.openExceptionCode !== null) {
    return { condition: 'F6', met: false, because: `exception ${e.openExceptionCode} is open` }
  }
  return { condition: 'F6', met: true, because: 'no blocking exception is open' }
}

function x1(e: FinalityEvidence): ConditionVerdict {
  const { termsHash } = e.authorized
  if (termsHash === null) {
    return { condition: 'X1', met: false, because: 'no authorized terms hash was frozen at authorization' }
  }
  if (e.executed.termsHash !== termsHash) {
    return {
      condition: 'X1',
      met: false,
      because: `executed against terms ${e.executed.termsHash ?? 'none'}, authorized against ${termsHash}`,
    }
  }
  return { condition: 'X1', met: true, because: `executed against the authorized terms ${termsHash}` }
}

function x2(e: FinalityEvidence): ConditionVerdict {
  const { destinationVersionId } = e.authorized
  if (destinationVersionId === null) {
    return { condition: 'X2', met: false, because: 'no destination version was frozen at authorization' }
  }
  if (e.executed.destinationVersionId !== destinationVersionId) {
    return {
      condition: 'X2',
      met: false,
      because:
        `paid destination version ${e.executed.destinationVersionId ?? 'none'}, ` +
        `authorized ${destinationVersionId}`,
    }
  }
  return {
    condition: 'X2',
    met: true,
    because: `paid the destination version ${destinationVersionId} frozen at authorization`,
  }
}

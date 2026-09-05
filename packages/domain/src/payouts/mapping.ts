/**
 * Provider vocabulary → INRSettle taxonomy — `INV-43`.
 *
 * > *"Interpretation maps a provider's vocabulary — error codes, rejection
 * > reasons, return reasons, event types — onto INRSettle's closed taxonomies
 * > through a **versioned, provider-specific mapping table**, which is data,
 * > not code."*
 *
 * And the three rules for an input the table does not cover:
 *
 * 1. **Never throws and never poisons the queue.** The handler completes, the
 *    raw event stays persisted and acknowledged, and nothing behind it blocks.
 * 2. **Never invents a taxonomy code**, and never widens the taxonomy at
 *    runtime. Adding a *code* is a code change; adding a *mapping* is a data
 *    change.
 * 3. **Routes to the phase-appropriate safe default**, chosen from the one
 *    thing every provider does communicate — whether the instruction was
 *    rejected or its status is simply unknown.
 *
 * The reason this is a table rather than a `switch` is that a `switch` has a
 * `default:` branch, and the tempting thing to write there is a new code. A
 * table cannot do that: it can only fail to match, and failing to match has one
 * defined behaviour that is written down once, here.
 */
import type { ExceptionCode } from '../settlements/exceptions.js'
import { UNMAPPED_RETURN_REASON, type ReturnReasonCode } from '../reconciliation/settlement-return.js'

/** What a provider event is telling us, before we know which code it is. */
export const PROVIDER_OUTCOMES = ['accepted', 'credited', 'rejected', 'returned', 'unknown'] as const
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number]

export interface ProviderCodeMapping {
  /** The provider's own string, verbatim and case-sensitive. */
  readonly providerCode: string
  readonly outcome: ProviderOutcome
  /**
   * The INRSettle exception code this maps to, for a rejection. Must already
   * exist in the closed taxonomy — the type makes widening it impossible.
   */
  readonly exceptionCode?: ExceptionCode
  /**
   * The closed return-reason code this maps to, for `outcome: 'returned'`.
   *
   * Same discipline as `exceptionCode` one field up, and for the same reason:
   * `INV-43` calls out *"return reasons"* by name among the vocabularies a
   * provider table maps. A return whose reason nothing maps still opens — it
   * routes to `RETURN_REASON_UNMAPPED`, which is an admission rather than an
   * explanation, and `§ 8.4` clause 5 sends it straight to `MANUAL_REVIEW`.
   */
  readonly returnReason?: ReturnReasonCode
  /** Why this mapping is what it is, for the person who reads it in two years. */
  readonly note: string
}

export interface ProviderMappingTable {
  readonly providerId: string
  readonly version: string
  /**
   * Where this table came from. Same discipline as the preflight rule sets: a
   * sandbox fixture must never be mistaken for a real provider's contract.
   */
  readonly source: 'sandbox_fixture' | 'provider_documentation' | 'provider_contract'
  readonly codes: readonly ProviderCodeMapping[]
}

/**
 * The safe default for an unmapped input, by what we can still tell about it.
 *
 * Both defaults are **non-customer-actionable** on purpose. We do not know what
 * happened, so we cannot tell a customer what to do about it — and a card that
 * says "action required" with no action is worse than a delay note. Operations
 * picks it up; the customer sees `SETTLING` with a delay.
 */
export const UNMAPPED_REJECTION_DEFAULT: ExceptionCode = 'PAYOUT_REJECTED_PROVIDER'
export const UNMAPPED_UNKNOWN_DEFAULT: ExceptionCode = 'PAYOUT_STATUS_UNKNOWN'

export type Interpretation =
  | {
      readonly mapped: true
      readonly outcome: ProviderOutcome
      readonly exceptionCode?: ExceptionCode
      readonly returnReason?: ReturnReasonCode
      readonly mappingVersion: string
    }
  | {
      /**
       * Unmapped, and *deliberately not an error*. The caller must still
       * complete: persist, acknowledge, alarm, and act on the safe default.
       */
      readonly mapped: false
      readonly outcome: ProviderOutcome
      readonly exceptionCode: ExceptionCode
      readonly mappingVersion: string
      readonly rawCode: string
      readonly alarm: 'unmapped_provider_code'
    }

/**
 * Interpret a provider code.
 *
 * Never throws. That is not an implementation detail — it is the invariant. A
 * provider that ships a new error code on a Friday must not be able to stop the
 * event queue, and the way to guarantee that is for the interpretation function
 * to have no failure mode at all.
 *
 * `fallbackOutcome` is what the transport could still tell us: a webhook on a
 * rejection endpoint is a rejection even when its code is novel. Where even
 * that is unavailable the caller passes `'unknown'`, which is the safest
 * reading and the one that leads to a status pull rather than a decision.
 */
export function interpretProviderCode(
  table: ProviderMappingTable,
  rawCode: string,
  fallbackOutcome: ProviderOutcome = 'unknown',
): Interpretation {
  const found = table.codes.find((c) => c.providerCode === rawCode)
  if (found) {
    return {
      mapped: true,
      outcome: found.outcome,
      ...(found.exceptionCode ? { exceptionCode: found.exceptionCode } : {}),
      ...(found.returnReason ? { returnReason: found.returnReason } : {}),
      mappingVersion: table.version,
    }
  }

  return {
    mapped: false,
    outcome: fallbackOutcome,
    exceptionCode:
      fallbackOutcome === 'rejected' ? UNMAPPED_REJECTION_DEFAULT : UNMAPPED_UNKNOWN_DEFAULT,
    mappingVersion: table.version,
    rawCode,
    alarm: 'unmapped_provider_code',
  }
}

/**
 * Validate a mapping table at load time.
 *
 * A table is data, and data arrives from outside. Checking it on load is what
 * makes "the taxonomy stays closed" true of a table someone edits rather than
 * only of the enum: an entry naming a code that does not exist is rejected
 * before it can be consulted, not when it first matches at three in the morning.
 */
export function validateMappingTable(
  table: ProviderMappingTable,
  isExceptionCode: (v: string) => boolean,
): readonly string[] {
  const problems: string[] = []
  const seen = new Set<string>()

  if (table.version.trim().length === 0) problems.push('mapping table has no version')

  for (const entry of table.codes) {
    if (seen.has(entry.providerCode)) {
      problems.push(`duplicate mapping for provider code "${entry.providerCode}"`)
    }
    seen.add(entry.providerCode)

    if (entry.exceptionCode !== undefined && !isExceptionCode(entry.exceptionCode)) {
      problems.push(
        `mapping for "${entry.providerCode}" names ${entry.exceptionCode}, which is not in the closed taxonomy`,
      )
    }
    if (entry.outcome === 'rejected' && entry.exceptionCode === undefined) {
      problems.push(`mapping for "${entry.providerCode}" is a rejection but names no exception code`)
    }
    // A return mapping that names no reason is not an error — it lands on
    // RETURN_REASON_UNMAPPED and escalates, which is the defined behaviour.
    // What *is* an error is a reason on an entry that is not a return, because
    // that reason would never be read and the author would never find out.
    if (entry.returnReason !== undefined && entry.outcome !== 'returned') {
      problems.push(
        `mapping for "${entry.providerCode}" names a return reason but its outcome is ${entry.outcome}`,
      )
    }
    if (entry.note.trim().length < 10) {
      // A mapping with no reasoning is a mapping nobody can safely change.
      problems.push(`mapping for "${entry.providerCode}" has no usable note`)
    }
  }
  return problems
}

/**
 * The return reason an interpretation carries, or the explicit admission.
 *
 * Separate from `interpretProviderCode` rather than folded into it, because the
 * two answer different questions and the caller needs both: *what kind of event
 * is this* and *why does the provider say the money came back*. A mapped return
 * with no reason is as unmapped, for this purpose, as one whose code nothing
 * matched — in both cases nobody has written down what it means.
 */
export function returnReasonOf(interpretation: Interpretation): ReturnReasonCode {
  return ('returnReason' in interpretation && interpretation.returnReason) || UNMAPPED_RETURN_REASON
}

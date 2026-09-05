/**
 * The exception taxonomy — `STATE_MACHINES.md § 7`.
 *
 * **Closed.** Ten codes, and adding an eleventh is a code change that must
 * supply a phase, an actionability classification and customer copy for the
 * actionable case. There is no free text and there is no `OTHER`.
 *
 * "Closed taxonomy, open mapping" is the frozen resolution of the obvious
 * tension: a provider must not be able to break event processing by sending
 * something new. Those are separate layers, and only the first is Stage 3's.
 * The **provider-to-taxonomy mapping** is a versioned data table owned by the
 * provider layer; an unmapped provider code routes there to a phase-appropriate
 * default that is always non-customer-actionable. By the time a code reaches
 * this file it is already one of ours — the settlement domain accepts no other
 * kind, which is why there is no fallback here to be tempted by.
 */
import type { SettlementStatus } from './status.js'
import type { Requirement } from '../preflight/requirement.js'

export const EXCEPTION_PHASES = ['reservation', 'funding', 'payout', 'reconciliation', 'finality'] as const
export type ExceptionPhase = (typeof EXCEPTION_PHASES)[number]

export const EXCEPTION_CODES = [
  'LIQUIDITY_UNAVAILABLE',
  'FACILITY_SUSPENDED',
  'DRAWDOWN_FAILED',
  'DRAWDOWN_STATUS_UNKNOWN',
  'PAYOUT_REJECTED_DESTINATION',
  'PAYOUT_REJECTED_COMPLIANCE',
  'PAYOUT_REJECTED_PROVIDER',
  'PAYOUT_STATUS_UNKNOWN',
  'RECONCILIATION_MISMATCH',
  'FINALITY_EVIDENCE_MISSING',
] as const

export type ExceptionCode = (typeof EXCEPTION_CODES)[number]

export interface ExceptionDefinition {
  readonly code: ExceptionCode
  readonly phase: ExceptionPhase
  /**
   * Whether the *customer* can do something about it. This is metadata read by
   * the projection, not a UI decision: a non-actionable exception projects to
   * SETTLING with a delay note, because alarming someone about something they
   * cannot fix is worse than saying nothing.
   */
  readonly customerActionable: boolean
  /** What ops does. Internal; never customer copy. */
  readonly resolutionPath: string
  /**
   * What the customer is told — `STATE_MACHINES.md § 7`: "the four-field
   * customer copy from `PRODUCT.md § 7.1` when customer-actionable".
   *
   * An actionable exception therefore carries a full `Requirement`: a stable
   * code, a title, a sentence and one named action. A non-actionable one
   * carries a single sentence instead, because there is no action to offer and
   * a requirement without one would be a card with a dead button.
   *
   * The copy lives here, beside the actionability flag the projection reads, so
   * a surface cannot invent its own wording for an exception.
   */
  readonly customerCopy:
    | { readonly kind: 'requirement'; readonly requirement: Requirement }
    | { readonly kind: 'delay_note'; readonly detail: string }
}

export const EXCEPTION_TAXONOMY: readonly ExceptionDefinition[] = [
  {
    code: 'LIQUIDITY_UNAVAILABLE',
    phase: 'reservation',
    customerActionable: false,
    resolutionPath: 'Ops: raise limit, wait for headroom, or fail',
    customerCopy: {
      kind: 'delay_note',
      detail:
        'Your settlement is queued while we free up funding capacity. We will send it as soon as capacity is available.',
    },
  },
  {
    code: 'FACILITY_SUSPENDED',
    phase: 'reservation',
    customerActionable: false,
    resolutionPath: 'Ops: facility-level decision',
    customerCopy: {
      kind: 'delay_note',
      detail:
        'Your settlement is paused while we review your funding facility. Our team is on it.',
    },
  },
  {
    code: 'DRAWDOWN_FAILED',
    phase: 'funding',
    customerActionable: false,
    resolutionPath: 'Ops: retry via provider or fail',
    customerCopy: {
      kind: 'delay_note',
      detail:
        'We could not draw the funds for this settlement on the first attempt. Our team is working on it.',
    },
  },
  {
    code: 'DRAWDOWN_STATUS_UNKNOWN',
    phase: 'funding',
    customerActionable: false,
    resolutionPath: 'Ops: authoritative status pull',
    customerCopy: {
      kind: 'delay_note',
      detail:
        'We are confirming the funding step with our banking partner before we send the payout.',
    },
  },
  {
    code: 'PAYOUT_REJECTED_DESTINATION',
    phase: 'payout',
    customerActionable: true,
    resolutionPath: 'Correct the beneficiary, then create a replacement settlement',
    customerCopy: {
      kind: 'requirement',
      requirement: {
        code: 'payout_destination_rejected',
        severity: 'blocking',
        title: 'The bank could not accept these payout details',
        // Says plainly that the money is safe, and that the fix is a new
        // settlement rather than an edit — the instruction is frozen (INV-16),
        // so "fix and retry in place" is not something we can offer.
        detail:
          'No funds left your facility. Correct the payout details, then create a replacement settlement to the corrected destination.',
        action: { type: 'edit_beneficiary', beneficiaryId: '', field: 'payout_destination' },
      },
    },
  },
  {
    code: 'PAYOUT_REJECTED_COMPLIANCE',
    phase: 'payout',
    customerActionable: true,
    resolutionPath: 'Supply the named documentation, or ops decision',
    customerCopy: {
      kind: 'requirement',
      requirement: {
        code: 'payout_documentation_required',
        severity: 'blocking',
        title: 'The bank needs documentation for this settlement',
        detail:
          'No funds left your facility. Send us the paperwork for this payment and we will resubmit it for you.',
        action: { type: 'upload_document', documentType: 'compliance_evidence' },
      },
    },
  },
  {
    code: 'PAYOUT_REJECTED_PROVIDER',
    phase: 'payout',
    customerActionable: false,
    resolutionPath: 'Ops: replacement settlement or fail',
    customerCopy: {
      kind: 'delay_note',
      detail:
        'Our payout partner declined this transfer. Our team is arranging another route.',
    },
  },
  {
    code: 'PAYOUT_STATUS_UNKNOWN',
    phase: 'payout',
    customerActionable: false,
    resolutionPath: 'Ops: authoritative status pull (INV-24)',
    customerCopy: {
      kind: 'delay_note',
      detail:
        'We are confirming the final status of this payout with the bank before we mark it settled.',
    },
  },
  {
    code: 'RECONCILIATION_MISMATCH',
    phase: 'reconciliation',
    customerActionable: false,
    resolutionPath: 'Ops decision; policy is D-14',
    customerCopy: {
      kind: 'delay_note',
      detail:
        'The amounts we hold and the bank holds do not yet agree, so we are checking before confirming.',
    },
  },
  {
    code: 'FINALITY_EVIDENCE_MISSING',
    phase: 'finality',
    customerActionable: false,
    resolutionPath: 'Ops: obtain the missing condition, or escalate',
    customerCopy: {
      kind: 'delay_note',
      detail:
        'We are waiting on final confirmation from the bank before we mark this settled.',
    },
  },
]

export function isExceptionCode(value: string): value is ExceptionCode {
  return (EXCEPTION_CODES as readonly string[]).includes(value)
}

export function exceptionDefinition(code: ExceptionCode): ExceptionDefinition {
  const found = EXCEPTION_TAXONOMY.find((e) => e.code === code)
  // Unreachable while the type holds; thrown rather than defaulted, because a
  // default here would be the `OTHER` the taxonomy forbids.
  if (!found) throw new Error(`exception code ${code} is not in the closed taxonomy`)
  return found
}

export function isCustomerActionable(code: ExceptionCode): boolean {
  return exceptionDefinition(code).customerActionable
}

/**
 * The customer-facing requirement for an actionable exception, bound to the
 * settlement it is about.
 *
 * The taxonomy entry carries the copy but cannot carry the beneficiary id —
 * that is per-settlement — so the id is filled here rather than left blank for
 * a surface to patch. Returns null for a non-actionable code: there is no
 * requirement to raise when there is nothing the customer can do.
 */
export function exceptionRequirement(
  code: ExceptionCode,
  subject: { beneficiaryId: string },
): Requirement | null {
  const copy = exceptionDefinition(code).customerCopy
  if (copy.kind !== 'requirement') return null
  const { requirement } = copy
  return requirement.action.type === 'edit_beneficiary'
    ? { ...requirement, action: { ...requirement.action, beneficiaryId: subject.beneficiaryId } }
    : requirement
}

/** The one-sentence delay note for a non-actionable exception, else null. */
export function exceptionDelayNote(code: ExceptionCode): string | null {
  const copy = exceptionDefinition(code).customerCopy
  return copy.kind === 'delay_note' ? copy.detail : null
}

/**
 * An open exception on a settlement.
 *
 * `enteredFrom` is what T22 resumes to, which is why it is carried on the
 * exception rather than inferred: the machine has to know where it came from to
 * put it back.
 */
export interface SettlementException {
  readonly code: ExceptionCode
  readonly openedAt: Date
  readonly enteredFrom: SettlementStatus
  /**
   * Present only for an exception raised from a provider input the mapping did
   * not recognise. Stage 3 never sets these — the provider layer does — but the
   * shape is here because the settlement carries them.
   */
  readonly providerRawCode?: string | undefined
  readonly providerRawMessage?: string | undefined
  readonly providerEventId?: string | undefined
  readonly classification?: 'unmapped' | undefined
  readonly resolvedAt?: Date | undefined
  readonly resolvedBy?: string | undefined
  readonly resolutionReason?: string | undefined
}

/**
 * Which exception code a trigger opens.
 *
 * Stated as a table so the transitions that end in `EXCEPTION` cannot pick a
 * code by hand at the call site. `reservation_failed` is the one case where the
 * caller must distinguish, because "no headroom" and "facility suspended" are
 * different operational problems with the same trigger.
 */
export const TRIGGER_EXCEPTION_CODES: Readonly<Record<string, ExceptionCode>> = {
  drawdown_failed: 'DRAWDOWN_FAILED',
  drawdown_timeout: 'DRAWDOWN_STATUS_UNKNOWN',
  payout_timeout: 'PAYOUT_STATUS_UNKNOWN',
  reconciled_mismatch: 'RECONCILIATION_MISMATCH',
  reconciliation_stalled: 'FINALITY_EVIDENCE_MISSING',
  reservation_expired: 'LIQUIDITY_UNAVAILABLE',
}

/**
 * View models for the Stage 3 settlement surfaces.
 *
 * The rule this file exists to hold: **the customer-status projection is not
 * repeated here.** `projectCustomerStatus` lives in `@inrsettle/domain` and is
 * the only place five customer states are derived from seventeen internal ones
 * (`INV-18`). What happens below is presentation of an *already projected*
 * value — a label, a tone, a position on the rail — never a second derivation.
 * A projection defined twice is a projection that disagrees with itself, and
 * the disagreement shows up as a customer seeing one state in a list and
 * another on the detail screen.
 */
import type { StatusTone, ProgressStep } from '@inrsettle/ui'
import { formatMoney, money } from '@inrsettle/money'
import type {
  CustomerStatus, ExceptionCode, Requirement, ResolutionCode, SettlementStatus,
} from '@inrsettle/domain/browser'
import {
  cancellationAffordance,
  exceptionDelayNote,
  exceptionRequirement,
  projectCustomerStatus,
  resolutionDefinition,
} from '@inrsettle/domain/browser'

export interface CustomerStateBadge {
  tone: StatusTone
  label: string
  detail?: string
}

/**
 * How each of the five customer states is described. One entry per state and
 * no branching on internal status: if this function needed the internal status
 * to decide a label, the projection would be leaking.
 */
export function customerStateBadge(
  status: CustomerStatus,
  opts: { delayed?: boolean } = {},
): CustomerStateBadge {
  switch (status) {
    case 'READY':
      return { tone: 'ready', label: 'Ready to settle' }
    case 'SETTLING':
      return opts.delayed
        ? { tone: 'settling', label: 'Settling', detail: 'taking longer than usual' }
        : { tone: 'settling', label: 'Settling' }
    case 'SETTLED':
      return { tone: 'settled', label: 'Settled', detail: 'funds released' }
    case 'ACTION_REQUIRED':
      return { tone: 'action_required', label: 'Action required' }
    case 'CANCELLED':
      // D-03, closed for V1: FAILED and CANCELLED share this one customer
      // state, and the difference is carried by the resolution reason — not by
      // a second label, which would be a sixth state wearing a disguise.
      return { tone: 'cancelled', label: 'Cancelled', detail: 'no funds were sent' }
  }
}

/**
 * Where the settlement sits on the three-step rail.
 *
 * Only three of the five customer states are *on* the rail. `ACTION_REQUIRED`
 * and `CANCELLED` are not later steps — they are different outcomes — so this
 * returns null and the surface renders something else instead of pretending
 * the rail still applies.
 */
export function progressStep(status: CustomerStatus): ProgressStep | null {
  switch (status) {
    case 'READY':
      return 'READY'
    case 'SETTLING':
      return 'SETTLING'
    case 'SETTLED':
      return 'SETTLED'
    case 'ACTION_REQUIRED':
    case 'CANCELLED':
      return null
  }
}

/** What the settlement row needs to render, mapped once. */
export interface SettlementViewInput {
  status: SettlementStatus
  openExceptionCode?: ExceptionCode | null
  pointOfNoReturnAt: Date | null
  cancellationRequestedAt: Date | null
  /** The precise reason a terminal settlement ended (D-03). */
  resolutionCode?: ResolutionCode | null
}

export interface SettlementPresentation {
  customerStatus: CustomerStatus | null
  listed: boolean
  badge: CustomerStateBadge | null
  step: ProgressStep | null
  delayed: boolean
  affordance: ReturnType<typeof cancellationAffordance>
  /**
   * A non-actionable exception's one-sentence delay note. Present only when
   * there is genuinely nothing for the customer to do.
   */
  delayNote: string | null
  /**
   * An actionable exception's four-field requirement, ready for a
   * RequirementCard. Mutually exclusive with `delayNote` by construction.
   */
  requirement: Requirement | null
  /**
   * The one-sentence reason a terminal settlement ended. This is what carries
   * the FAILED/CANCELLED distinction now that D-03 is closed against a sixth
   * customer state.
   */
  resolutionMessage: string | null
}

export function presentSettlement(
  input: SettlementViewInput & { beneficiaryId?: string },
): SettlementPresentation {
  const projection = projectCustomerStatus({
    status: input.status,
    openExceptionCode: input.openExceptionCode ?? null,
  })
  const delayed = projection.listed ? projection.delayed === true : false
  const customerStatus = projection.customerStatus

  return {
    customerStatus,
    listed: projection.listed,
    badge: customerStatus ? customerStateBadge(customerStatus, { delayed }) : null,
    step: customerStatus ? progressStep(customerStatus) : null,
    delayed,
    affordance: cancellationAffordance({
      status: input.status,
      pointOfNoReturnAt: input.pointOfNoReturnAt,
      cancellationRequestedAt: input.cancellationRequestedAt,
    }),
    delayNote: input.openExceptionCode ? exceptionDelayNote(input.openExceptionCode) : null,
    requirement: input.openExceptionCode
      ? exceptionRequirement(input.openExceptionCode, { beneficiaryId: input.beneficiaryId ?? '' })
      : null,
    resolutionMessage: input.resolutionCode
      ? resolutionDefinition(input.resolutionCode).message
      : null,
  }
}

/** A row in the settlements list. */
export interface SettlementRow {
  id: string
  reference: string
  beneficiaryName: string
  /** Rendered by AmountDisplay, so it stays a Money all the way down. */
  recipientAmountMinor: bigint
  createdAt: Date
  presentation: SettlementPresentation
}

/* ── Stage 6 — how a return is surfaced (`STATE_MACHINES.md § 8.5`) ──────── */

/**
 * A return, as the customer sees it.
 *
 * `§ 8.5` is unusually prescriptive about this screen, and the reason is stated
 * in the same section as a *"known tension, accepted deliberately"*: a customer
 * scanning a list sees `SETTLED` on a settlement whose money came back. The
 * document takes that trade knowingly — mutating a final record, or projecting
 * the return onto `CANCELLED`, *"destroys the distinction between never
 * delivered and delivered then returned, and those have different consequences
 * for the customer's own books"* — and then spends four bullet points making
 * sure the return is impossible to miss instead.
 *
 * So this view model does one job: give the return **its own state**, next to a
 * settlement whose state has not changed and must not appear to have. The
 * settlement's badge still says Settled. The return's badge says what happened
 * to the money afterwards. Two facts, shown as two.
 */
export interface ReturnViewInput {
  id: string
  status: 'OBSERVED' | 'CONFIRMED' | 'REPAID' | 'REJECTED' | 'MANUAL_REVIEW'
  amountMinor: bigint
  reasonCode: string
  observedAt: Date
}

export interface ReturnNoticeView {
  id: string
  /**
   * Its own tone vocabulary, not `StatusTone`.
   *
   * `StatusTone` is the five customer *settlement* states, and a return is not
   * one of them — reusing it would be the first step towards a sixth settlement
   * state, which `D-03` closed against. A return has its own two-value scale:
   * something is still moving, or it is not.
   */
  tone: 'attention' | 'resolved'
  /** The four labels `§ 8.5` names, and no others. */
  label: 'Return reported' | 'Return confirmed' | 'Funds released' | 'Return not upheld'
  detail: string
  amountMinor: bigint
  observedAt: Date
  /** Whether this return still has somewhere to go. Drives `has_open_return`. */
  open: boolean
}

/**
 * The four states `§ 8.5` names, mapped from the five the machine has.
 *
 * `MANUAL_REVIEW` shows as *Return reported*, deliberately. The customer's
 * situation while an operator looks at it is exactly the situation while the
 * authoritative check runs: a return has been reported and nothing is settled
 * about it yet. Inventing a fifth customer-facing label for our internal triage
 * would tell them about our queue rather than about their money — the same
 * mistake `INV-18` exists to prevent one layer up.
 */
export function returnNotice(input: ReturnViewInput): ReturnNoticeView {
  const base = { id: input.id, amountMinor: input.amountMinor, observedAt: input.observedAt }
  switch (input.status) {
    case 'OBSERVED':
    case 'MANUAL_REVIEW':
      return {
        ...base,
        tone: 'attention',
        label: 'Return reported',
        detail: 'The receiving bank has reported returning this payment. We are confirming it.',
        open: true,
      }
    case 'CONFIRMED':
      return {
        ...base,
        tone: 'attention',
        label: 'Return confirmed',
        // No mention of the facility: PRODUCT.md § 12 keeps liquidity as
        // INRSettle's arrangement with a provider, never something the customer
        // operates. What they need to know is about their money, not our plumbing.
        detail: 'The payment was returned. The funds are on their way back.',
        open: true,
      }
    case 'REPAID':
      return {
        ...base,
        tone: 'resolved',
        label: 'Funds released',
        detail: 'The returned funds are back and available to settle.',
        open: false,
      }
    case 'REJECTED':
      return {
        ...base,
        tone: 'resolved',
        label: 'Return not upheld',
        detail: 'The reported return was not confirmed by the provider. The payment stands.',
        open: false,
      }
  }
}

/**
 * The list-row marker and the two filters `§ 8.5` requires.
 *
 * `hasConfirmedReturn` counts `REPAID` as well as `CONFIRMED`, because the
 * question a customer is asking with that filter is *"which of my settled
 * payments came back"* — and a repaid one came back. `hasOpenReturn` is the
 * operational question instead: which ones are still moving.
 */
export interface ReturnSummary {
  hasOpenReturn: boolean
  hasConfirmedReturn: boolean
  /** Shown on the row itself, so a return cannot be missed in a list. */
  marker: 'returned' | 'return_reported' | null
}

export function summariseReturns(returns: readonly ReturnViewInput[]): ReturnSummary {
  const hasOpenReturn = returns.some((r) => r.status === 'OBSERVED' || r.status === 'MANUAL_REVIEW' || r.status === 'CONFIRMED')
  const hasConfirmedReturn = returns.some((r) => r.status === 'CONFIRMED' || r.status === 'REPAID')
  return {
    hasOpenReturn,
    hasConfirmedReturn,
    marker: hasConfirmedReturn ? 'returned' : hasOpenReturn ? 'return_reported' : null,
  }
}

/**
 * What the receipt panel shows.
 *
 * The `contentHash` is displayed rather than hidden. `INV-29` makes the UI, the
 * PDF and the API render one serialisation and carry one hash; showing it is
 * what turns that from an internal property into something a customer holding
 * the PDF can check against the API themselves.
 *
 * Notices are **linked, not merged** (`API_CONTRACT.md § 7.6`). The receipt's
 * own fields are unchanged by any of them, and this shape keeps that visible:
 * two arrays, never one flattened record.
 */
export interface ReceiptView {
  id: string
  contentHash: string
  pdfUrl: string
  returnNotices: readonly { id: string; contentHash: string; pdfUrl: string }[]
}

/* ── Stage 10 — the plain-language timeline (`PRODUCT.md § 12.3`) ────────── */

/**
 * The technical detail, in the words § 12.3 writes it in.
 *
 * The section gives the shape verbatim:
 *
 * ```
 * Settlement ready         14:02:11 IST
 * Liquidity secured        14:02:14 IST
 * INR payout confirmed     14:03:47 IST   UTR 2026083112345678
 * Reconciled               14:03:52 IST   ₹5,000,000 expected · ₹5,000,000 observed
 * ```
 *
 * Every label is a sentence about the customer's money. None is an internal
 * state name — the same section says *"Provider identifiers, internal state
 * names and raw event payloads never dominate the page"*, and a timeline
 * reading `LIQUIDITY_RESERVED → DRAWDOWN_CONFIRMED` would be the machine
 * leaking through the one surface that exists to keep it out.
 *
 * So the mapping lives here and is total over the events a settlement actually
 * produces. An internal status with no plain-language equivalent produces no
 * row at all rather than a row naming it: silence is better than jargon, and a
 * timeline is not an audit log. The audit log exists and is not this.
 */
export interface TimelineEventInput {
  /** Internal status the settlement entered. */
  readonly status: SettlementStatus
  readonly at: Date
  /** Provider reference for the payout leg, when there is one. */
  readonly utr?: string | null
  /** Reconciliation figures, when this is the reconciliation step. */
  readonly expectedMinor?: bigint | null
  readonly observedMinor?: bigint | null
}

export interface TimelineRow {
  readonly label: string
  /** `14:02:11 IST` — the format § 12.3 prints. */
  readonly at: string
  /** The one extra fact this step carries, if any. */
  readonly detail: string | null
}

/**
 * Plain language for each step, and nothing for the rest.
 *
 * Deliberately partial. `PREFLIGHTING`, `QUOTED`, `LIQUIDITY_RESERVING`,
 * `DRAWDOWN_REQUESTED` and `PAYOUT_SUBMITTED` are all real transitions and none
 * of them is news: they are the moments we started doing something, not the
 * moments anything happened to the customer's money. Listing them would make
 * the timeline longer and less true.
 */
const TIMELINE_LABELS: Partial<Record<SettlementStatus, string>> = {
  READY: 'Settlement ready',
  AUTHORIZED: 'Authorized',
  LIQUIDITY_RESERVED: 'Liquidity secured',
  DRAWDOWN_CONFIRMED: 'Funding confirmed',
  PAYOUT_CONFIRMED: 'INR payout confirmed',
  RECONCILING: 'Reconciling',
  SETTLED: 'Reconciled',
  CANCELLED: 'Cancelled',
  FAILED: 'Could not be sent',
}

/** `14:02:11 IST`. India, because this is where the money lands. */
export function formatIst(at: Date): string {
  const time = new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Kolkata',
  }).format(at)
  return `${time} IST`
}

export function settlementTimeline(
  events: readonly TimelineEventInput[],
): readonly TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const event of events) {
    const label = TIMELINE_LABELS[event.status]
    if (label === undefined) continue

    let detail: string | null = null
    if (event.utr) {
      // The UTR is the customer's proof at their own bank, so it is the one
      // provider-issued identifier § 12.3 puts on the page rather than behind
      // the disclosure. It is a fact about their payment, not about our stack.
      detail = `UTR ${event.utr}`
    } else if (event.expectedMinor != null && event.observedMinor != null) {
      detail =
        `${formatMoney(money('INR', event.expectedMinor), { format: 'indian' })} expected` +
        ` · ${formatMoney(money('INR', event.observedMinor), { format: 'indian' })} observed`
    }

    rows.push({ label, at: formatIst(event.at), detail })
  }
  return rows
}

/**
 * The note § 12.3 requires beside a frozen destination.
 *
 * *"If the customer edits the beneficiary afterwards, this page does not
 * change, because this settlement does not change. A small note says so, rather
 * than leaving someone to wonder why the account they just corrected is not
 * reflected here."*
 *
 * Returned only once the destination is actually frozen — before authorization
 * the page shows the live destination and the note would be false.
 */
export function frozenDestinationNote(authorizedAt: Date | null): string | null {
  return authorizedAt === null
    ? null
    : 'These are the payout details as they were when this settlement was authorized. ' +
      'Later edits to the beneficiary do not change this settlement.'
}

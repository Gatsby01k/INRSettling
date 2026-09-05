/**
 * The `PayoutProvider` port — `ARCHITECTURE.md § 4`.
 *
 * Four methods, and the shape of each follows one rule that the whole `UNKNOWN`
 * design rests on: **a command carries an idempotency key and a query carries a
 * reference.** When `submitPayout` does not answer, the caller cannot know
 * whether a payout exists in India. The only safe next move is to ask — and
 * asking is only possible because the submission's identity was decided
 * *before* it was sent (`INV-25`) rather than handed back by a response that
 * never arrived.
 *
 * `verifySignature` returns a discriminated result rather than a boolean or a
 * thrown error. `INV-33` requires the raw event to be persisted whatever the
 * verdict, and `SECURITY.md § 4.2` requires an untrusted event to be stored and
 * alarmed rather than dropped — so "invalid" is an outcome the caller must
 * handle, not an exception it may accidentally swallow.
 */
import type { CurrencyCode } from '@inrsettle/money'

/** `DOMAIN.md § 6.7`. The four domestic rails, and nothing else. */
export const PAYOUT_RAILS = ['NEFT', 'RTGS', 'IMPS', 'UPI'] as const
export type PayoutRail = (typeof PAYOUT_RAILS)[number]

/**
 * What a provider says it can do.
 *
 * Every number here comes from the provider, not from this codebase. `D-13`
 * (cut-off times, banking holidays and rail windows) is open, and the honest
 * consequence is that limits and windows are *declared capability*, not
 * constants someone typed in. A rail minimum of ₹2,00,000 for RTGS is a real
 * fact about Indian rails, but which rails a given partner offers, at what
 * limits, and when, is a fact about that partner.
 */
export interface RailCapability {
  readonly rail: PayoutRail
  /** Inclusive. `null` means the provider declares no minimum. */
  readonly minMinor: bigint | null
  /** Inclusive. `null` means the provider declares no maximum. */
  readonly maxMinor: bigint | null
  /** Destination kinds this rail can pay. UPI cannot pay a bank account. */
  readonly destinationKinds: readonly ('bank_account' | 'vpa')[]
  /**
   * Whether the provider currently considers this rail open.
   *
   * Deliberately a provider-supplied boolean rather than a clock computation
   * here. Cut-off times and banking holidays are `D-13`; a partner that knows
   * its own windows can answer this, and a partner that cannot is telling us
   * something we need to know before we promise a delivery estimate.
   */
  readonly open: boolean
  /**
   * How long the provider expects a terminal status to take. Drives the T18
   * SLA sweeper. Supplied, never assumed.
   */
  readonly terminalStatusSlaSeconds: number
}

export interface PayoutCapabilities {
  readonly providerId: string
  readonly currency: CurrencyCode
  readonly rails: readonly RailCapability[]
}

export interface PayoutCommand {
  readonly settlementId: string
  readonly attemptNumber: number
  /** `INV-25`: `settlement_id + attempt_number`, and nothing else. */
  readonly idempotencyKey: string
  readonly rail: PayoutRail
  readonly amountMinor: bigint
  readonly currency: CurrencyCode
  readonly destination: PayoutDestinationSnapshot
}

/**
 * The frozen destination, passed by value.
 *
 * `INV-16` and `INV-44`: a settlement pays the `PayoutDestinationVersion` it
 * was authorized against. Passing the version's *contents* rather than its id
 * means the adapter cannot resolve a newer one by accident.
 */
export interface PayoutDestinationSnapshot {
  readonly destinationVersionId: string
  readonly kind: 'bank_account' | 'vpa'
  readonly accountNumber?: string
  readonly ifsc?: string
  readonly vpa?: string
  readonly accountHolderName: string
}

export interface PayoutAck {
  readonly providerReference: string
  /** What the provider says right now. Rarely terminal on the first answer. */
  readonly status: 'SUBMITTED' | 'ACCEPTED' | 'CREDITED' | 'REJECTED'
  readonly utr?: string
  /** The provider's own code, unmapped. Interpretation happens elsewhere. */
  readonly rawCode?: string
  /**
   * What the rail says actually reached the beneficiary.
   *
   * Deliberately separate from the instructed `PayoutCommand.amountMinor`,
   * because they are two different facts and a rail is perfectly capable of
   * disagreeing with us. Folding them together — trusting that a credit
   * credited what we asked for — would make a shortfall *unrepresentable*,
   * which is a much worse failure than an unreconciled one: nobody can
   * reconcile a difference the schema cannot hold.
   *
   * Stage 5 records it. Comparing it to what was expected, and deciding what a
   * delta means, is reconciliation's job (`INV-26`).
   */
  readonly creditedMinor?: bigint
}

/**
 * The authoritative status pull — the only correct recovery from `UNKNOWN`.
 *
 * `not_found` is a real answer and is kept distinct from an error: it is the
 * provider stating that a submission it was never asked to perform does not
 * exist, which is what resolves an `UNKNOWN` in the safe direction. Folding it
 * into an error would leave the caller unable to tell "we do not know" from "we
 * know it did not happen" — and the difference between those two is whether a
 * beneficiary has been paid.
 */
export type PayoutQuery =
  | {
      readonly ok: true
      readonly status: 'SUBMITTED' | 'ACCEPTED' | 'CREDITED' | 'REJECTED' | 'RETURNED'
      readonly providerReference: string
      readonly utr?: string
      readonly rawCode?: string
      /** What the rail says reached the beneficiary. See `PayoutAck`. */
      readonly creditedMinor?: bigint
      /**
       * What the rail says has come back so far, as the *provider* counts it.
       *
       * Reported, never derived here, and never checked against the credit:
       * capping cumulative returns at the delivered amount is `INV-49`, which
       * is Stage 6's, and a second implementation of that rule living in the
       * port would be a second answer to disagree with the first.
       */
      readonly returnedMinor?: bigint
    }
  | { readonly ok: true; readonly status: 'not_found' }
  | { readonly ok: false; readonly error: string }

/** The result of checking a webhook's authenticity. */
export type SignatureVerdict =
  | { readonly valid: true; readonly providerEventId: string; readonly eventType: string; readonly payload: Record<string, unknown> }
  | { readonly valid: false; readonly reason: 'bad_signature' | 'stale_timestamp' | 'future_timestamp' | 'malformed' }

export interface PayoutProvider {
  readonly id: string
  capabilities(): Promise<PayoutCapabilities>
  submitPayout(cmd: PayoutCommand): Promise<PayoutAck>
  /** Authoritative status pull, keyed by the idempotency key we chose. */
  getPayout(idempotencyKey: string): Promise<PayoutQuery>
  verifySignature(raw: string, headers: Readonly<Record<string, string>>): SignatureVerdict
}

/**
 * Raised when a submission does not return an answer.
 *
 * Its own type, because the caller must not treat it as a rejection. A
 * timed-out payout may have moved real money to a real beneficiary; a code path
 * that catches this alongside a genuine failure would retry, and T18's frozen
 * guard forbids that in as many words: *"Never auto-retry."*
 */
export class PayoutTimeout extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`payout provider did not answer for ${idempotencyKey}; status is unknown, not failed`)
    this.name = 'PayoutTimeout'
  }
}

/* ── Rail selection ─────────────────────────────────────────────────────── */

export type RailSelection =
  | { readonly ok: true; readonly rail: PayoutRail; readonly why: string }
  | {
      readonly ok: false
      readonly reason: 'no_rail_for_destination' | 'no_rail_for_amount' | 'all_rails_closed'
      readonly considered: readonly PayoutRail[]
    }

/**
 * Choose a rail from what the provider declares it can do.
 *
 * `PRODUCT.md § 8` is the constraint: *"picks a beneficiary, not NEFT or IMPS.
 * The `payouts` module selects the rail"* — the customer never chooses, and
 * never sees the answer.
 *
 * The ordering below is a *preference*, not a policy: among rails that can
 * actually carry this payment, prefer the one that settles fastest. That is
 * safe to state here because it is true of the rails themselves rather than of
 * any commercial arrangement. What is **not** decided here is anything that
 * depends on cost, cut-off times or banking holidays — those are `D-13`, and
 * they enter only as the provider's own `open` flag and declared limits.
 */
const RAIL_PREFERENCE: readonly PayoutRail[] = ['UPI', 'IMPS', 'RTGS', 'NEFT']

export function selectRail(input: {
  capabilities: PayoutCapabilities
  destinationKind: 'bank_account' | 'vpa'
  amountMinor: bigint
}): RailSelection {
  const considered = input.capabilities.rails.map((r) => r.rail)

  const forDestination = input.capabilities.rails.filter((r) =>
    r.destinationKinds.includes(input.destinationKind),
  )
  if (forDestination.length === 0) {
    return { ok: false, reason: 'no_rail_for_destination', considered }
  }

  const forAmount = forDestination.filter(
    (r) =>
      (r.minMinor === null || input.amountMinor >= r.minMinor) &&
      (r.maxMinor === null || input.amountMinor <= r.maxMinor),
  )
  if (forAmount.length === 0) {
    return { ok: false, reason: 'no_rail_for_amount', considered: forDestination.map((r) => r.rail) }
  }

  const usable = forAmount.filter((r) => r.open)
  if (usable.length === 0) {
    // Distinct from "no rail fits" on purpose. A closed rail will open again,
    // and telling operations "everything is shut right now" is a different
    // problem from "this payment cannot be made on any rail we have".
    return { ok: false, reason: 'all_rails_closed', considered: forAmount.map((r) => r.rail) }
  }

  const chosen =
    RAIL_PREFERENCE.map((rail) => usable.find((r) => r.rail === rail)).find((r) => r !== undefined) ??
    usable[0]!

  return {
    ok: true,
    rail: chosen.rail,
    why: `fastest open rail the provider declares for a ${input.destinationKind} of this size`,
  }
}

/**
 * A UTR is twelve alphanumeric characters as issued by the Indian banking
 * system. T16's frozen guard requires it *present and well-formed* before a
 * settlement may reach `PAYOUT_CONFIRMED`.
 *
 * Checked rather than trusted because the UTR is the customer's evidence that a
 * payment happened — it is what they quote to their beneficiary's bank. A
 * malformed one is worse than an absent one: absent is visibly incomplete,
 * malformed looks like proof and is not.
 */
const UTR_PATTERN = /^[A-Za-z0-9]{12,22}$/

export function isWellFormedUtr(utr: string | null | undefined): utr is string {
  return typeof utr === 'string' && UTR_PATTERN.test(utr)
}

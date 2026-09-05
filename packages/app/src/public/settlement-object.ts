/**
 * The settlement representation — `API_CONTRACT.md § 7.3`.
 *
 * The longest object in the API and the one with the most rules on it, all of
 * which are about *not* saying more than is true:
 *
 * **`status` is the customer projection, never the internal state.** `§ 7.3`:
 * *"Internal states are not exposed by the public API […]; `progress` is how
 * technical detail is offered, already in customer language."* So the seventeen
 * internal states go through the one projection `INV-18` allows, and the
 * progress array is built from that projection rather than from the machine.
 *
 * **Once authorized, every payout detail renders the frozen destination
 * version.** Editing a beneficiary's destination afterwards appends a new
 * version and changes nothing here — not what this settlement pays and not what
 * this endpoint shows (`INV-16`, `INV-45`). `destination_is_frozen` says which
 * of the two a client is looking at, so a client never has to infer it.
 *
 * **`cancellable` is a field, not an inference.** `§ 7.3.1` tells clients to
 * drive their cancel affordance from it rather than from `status`, because
 * authorization freezes the instruction without ending cancellability and no
 * status value expresses that.
 *
 * **`replaced_by` is derived and read-only.** The replaced settlement is
 * terminal and is never written to (`INV-38`), so the link is computed from the
 * index on `replaces_settlement_id` rather than stored on the row it would have
 * to mutate.
 */
import type { Money } from '@inrsettle/money'
import {
  cancellationAffordance, projectCustomerStatus,
  type CustomerStatus, type ExceptionCode, type SettlementStatus,
} from '@inrsettle/domain'
import { moneyJson, timestamp, type NumberFormat } from './objects.js'

export interface SettlementSerializationInput {
  readonly id: string
  readonly environment: string
  readonly status: SettlementStatus
  readonly customerStatus: CustomerStatus | null
  readonly openExceptionCode: ExceptionCode | null
  readonly recipientAmount: Money
  readonly deliveredAmount: Money | null
  readonly fundingCurrency: string
  readonly purposeCode: string | null
  readonly purposeLabel: string | null
  readonly externalReference: string | null
  readonly quoteId: string | null
  readonly batchId: string | null
  readonly receiptId: string | null
  readonly payoutReference: string | null
  readonly authorizedTerms: Record<string, unknown> | null
  readonly authorizedTermsHash: string | null
  readonly pointOfNoReturnAt: Date | null
  readonly cancellationRequestedAt: Date | null
  readonly authorizedAt: Date | null
  readonly settledAt: Date | null
  readonly createdAt: Date
  readonly replacesSettlementId: string | null
  readonly replacedBy: string | null
  readonly beneficiary: {
    readonly id: string
    readonly displayName: string
    readonly destinationId: string | null
    readonly destinationVersionId: string | null
    readonly destinationSummary: string | null
    readonly verificationStatus: string | null
  }
  readonly requirements: readonly Record<string, unknown>[]
  readonly returns: readonly Record<string, unknown>[]
  /** `§ 7.3.1` — the one-sentence reason a terminal settlement ended (`D-03`). */
  readonly resolution: { readonly code: string; readonly message: string } | null
  readonly progressTimestamps: {
    readonly ready: Date | null
    readonly liquiditySecured: Date | null
    readonly payoutConfirmed: Date | null
    readonly reconciled: Date | null
  }
}

/** `§ 7.3`'s four steps, in customer language, with the times we actually have. */
function progress(
  input: SettlementSerializationInput,
): readonly Record<string, unknown>[] {
  return [
    { step: 'ready', label: 'Settlement ready', at: timestamp(input.progressTimestamps.ready) },
    {
      step: 'liquidity_secured', label: 'Liquidity secured',
      at: timestamp(input.progressTimestamps.liquiditySecured),
    },
    {
      step: 'payout_confirmed', label: 'INR payout confirmed',
      at: timestamp(input.progressTimestamps.payoutConfirmed),
    },
    { step: 'reconciled', label: 'Reconciled', at: timestamp(input.progressTimestamps.reconciled) },
  ]
}

export function settlementJson(
  input: SettlementSerializationInput, format: NumberFormat,
): Record<string, unknown> {
  // The projection and the affordance come from `packages/domain`, which is the
  // only place either is decided. The customer app has its own presentation
  // layer over the same two functions — badges, copy, a delay note — and the API
  // deliberately does not import it: `ARCHITECTURE.md § 2` forbids one app
  // importing another, and more to the point, wire shape and screen copy are not
  // the same artifact and should not drift together.
  const projection = projectCustomerStatus({
    status: input.status,
    openExceptionCode: input.openExceptionCode,
  })
  const affordance = cancellationAffordance({
    status: input.status,
    pointOfNoReturnAt: input.pointOfNoReturnAt,
    cancellationRequestedAt: input.cancellationRequestedAt,
  })

  const frozen = input.authorizedAt !== null && input.beneficiary.destinationVersionId !== null

  return {
    id: input.id,
    object: 'settlement',
    environment: input.environment,
    // The projection, lower-cased. A settlement in DRAFT has no customer status
    // yet and is not listed — the API returns null rather than inventing one.
    status: projection.customerStatus === null ? null : projection.customerStatus.toLowerCase(),
    beneficiary: {
      id: input.beneficiary.id,
      display_name: input.beneficiary.displayName,
      destination_id: input.beneficiary.destinationId,
      destination_version_id: input.beneficiary.destinationVersionId,
      destination_summary: input.beneficiary.destinationSummary,
      destination_is_frozen: frozen,
      verification_status: input.beneficiary.verificationStatus,
    },
    authorized_terms: input.authorizedTerms === null ? null : {
      ...input.authorizedTerms,
      hash: input.authorizedTermsHash,
    },
    recipient_amount: moneyJson(input.recipientAmount, format),
    delivered_amount: input.deliveredAmount === null
      ? null
      : moneyJson(input.deliveredAmount, format),
    funding_currency: input.fundingCurrency,
    purpose: input.purposeCode === null ? null : {
      code: input.purposeCode,
      label: input.purposeLabel ?? input.purposeCode,
    },
    external_reference: input.externalReference,
    quote_id: input.quoteId,
    batch_id: input.batchId,
    requirements: input.requirements,
    progress: progress(input),
    payout_reference: input.payoutReference,
    receipt_id: input.receiptId,
    // `§ 7.3.1`: true while the point of no return is unstamped and the status
    // is not terminal. `requested` is deliberately *not* cancellable — a second
    // cancel request is not a thing a client should be invited to send.
    cancellable: affordance === 'cancel' || affordance === 'request_cancellation',
    point_of_no_return_at: timestamp(input.pointOfNoReturnAt),
    cancellation_requested_at: timestamp(input.cancellationRequestedAt),
    returns: input.returns,
    replaces_settlement_id: input.replacesSettlementId,
    replaced_by: input.replacedBy,
    ...(input.resolution === null ? {} : { resolution: input.resolution }),
    authorized_at: timestamp(input.authorizedAt),
    settled_at: timestamp(input.settledAt),
    created_at: timestamp(input.createdAt),
  }
}

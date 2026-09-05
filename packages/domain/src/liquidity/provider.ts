/**
 * The `LiquidityProvider` port — `ARCHITECTURE.md § 4`.
 *
 * Four methods are named in the frozen interface. This adds a fifth,
 * `getRepayment`, because `INV-47` requires it in as many words:
 *
 * > *"Repayment `UNKNOWN` is resolved the same way payout `UNKNOWN` is: by an
 * > authoritative status pull against the provider using the repayment's own
 * > `request_fingerprint`, never by resubmitting. … The `LiquidityProvider`
 * > port therefore carries `getRepayment(ref)` alongside `submitRepayment`."*
 *
 * The shape of every method here follows one rule: **a command carries an
 * idempotency key and a query carries a reference.** That is what makes the
 * `UNKNOWN` path expressible. When a command times out, the caller does not
 * know whether the provider acted; the only safe next move is a query, and a
 * query is only possible if the command's identity was decided before it was
 * sent rather than handed back by the response.
 */
import type { CurrencyCode } from '@inrsettle/money'
import type { DrawdownStatus } from './drawdown.js'
import type { RepaymentStatus } from './repayment.js'
import type { FacilityStatus } from './facility.js'

export interface FacilitySnapshot {
  readonly providerFacilityId: string
  readonly status: FacilityStatus
  readonly currency: CurrencyCode
  /** The provider's view of the limit, in minor units. */
  readonly limitMinor: bigint
  /** The provider's view of outstanding drawn value. */
  readonly drawnMinor: bigint
  readonly asOf: Date
}

export interface DrawdownCommand {
  readonly providerFacilityId: string
  readonly currency: CurrencyCode
  readonly amountMinor: bigint
  /** Stable per drawdown. A retry presents this same value. */
  readonly requestFingerprint: string
  readonly reference: string
}

export interface DrawdownAck {
  readonly providerReference: string
  readonly status: DrawdownStatus
}

export interface RepaymentCommand {
  readonly providerFacilityId: string
  readonly currency: CurrencyCode
  readonly amountMinor: bigint
  /** `INV-47`. A re-request (Y08) presents a *new* one; a retry does not. */
  readonly requestFingerprint: string
  readonly reference: string
}

export interface RepaymentAck {
  readonly providerReference: string
  readonly status: RepaymentStatus
}

/**
 * What a status pull can say.
 *
 * `not_found` is a real answer and is kept distinct from an error: it is the
 * provider stating that a command it was never asked to perform does not exist,
 * which is precisely what resolves an `UNKNOWN` in the safe direction. Folding
 * it into an error would leave the caller unable to tell "we do not know" from
 * "we know it did not happen".
 */
export type ProviderQuery<TStatus> =
  | { readonly ok: true; readonly status: TStatus; readonly providerReference: string }
  | { readonly ok: true; readonly status: 'not_found' }
  | { readonly ok: false; readonly error: string }

export interface LiquidityProvider {
  readonly id: string
  getFacility(providerFacilityId: string): Promise<FacilitySnapshot>
  requestDrawdown(cmd: DrawdownCommand): Promise<DrawdownAck>
  getDrawdown(requestFingerprint: string): Promise<ProviderQuery<DrawdownStatus>>
  submitRepayment(cmd: RepaymentCommand): Promise<RepaymentAck>
  /** Required by `INV-47`. Never a resubmit. */
  getRepayment(requestFingerprint: string): Promise<ProviderQuery<RepaymentStatus>>
}

/**
 * Raised when a provider call does not return an answer.
 *
 * Deliberately its own type: the caller must not treat it as a failure. A
 * timed-out drawdown may have moved money, so the settlement goes to `UNKNOWN`
 * and waits for a pull, and a code path that catches this alongside a genuine
 * rejection would resubmit — which T29's frozen guard forbids in as many words.
 */
export class ProviderTimeout extends Error {
  constructor(readonly requestFingerprint: string) {
    super(`provider did not answer for ${requestFingerprint}; status is unknown, not failed`)
    this.name = 'ProviderTimeout'
  }
}

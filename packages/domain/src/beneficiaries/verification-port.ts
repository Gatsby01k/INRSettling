/**
 * The beneficiary verification port — `ARCHITECTURE.md § 2`, `D-11` (open).
 *
 * `D-11` — whether V1 verifies by penny drop, by provider lookup, or by both,
 * and who bears the cost and latency — is **not** answered here and must not be
 * inferred from this file. What is settled is the shape of the question: the
 * domain asks "is this exact destination version real, and does the name
 * match?", and an adapter answers. A penny-drop adapter, a lookup adapter and a
 * both-then-fall-back adapter all satisfy this interface without the domain
 * changing, which is the point.
 *
 * Product language is "Verify beneficiary" (`PRODUCT.md § 7.1`). Penny drop and
 * lookup are mechanics that live below this line and never surface as customer
 * copy.
 */
import type { DestinationKind, VerificationMethod } from './destination.js'
import type { NameMatchEvidence } from './name-match.js'

/**
 * What the provider is asked to check. It names a **destination version**
 * (`INV-45`) — never a destination — so a result can never be applied to
 * details other than the ones that were checked.
 */
export interface VerificationRequest {
  /** Idempotency key. The same key must never start a second real check. */
  readonly requestId: string
  readonly destinationVersionId: string
  readonly kind: DestinationKind
  /** Plaintext, held only for the duration of the call. Never logged. */
  readonly accountNumber?: string
  readonly ifsc?: string
  readonly vpa?: string
  /** The name to match against what the rail reports. */
  readonly beneficiaryName: string
}

export type VerificationOutcome =
  /**
   * The destination exists. Whether that is enough is **not** the provider's
   * call: it reports what it found as `nameEvidence`, and the versioned
   * name-match policy decides. A provider that says "verified" with evidence
   * its policy rejects does not produce a verified destination.
   */
  | {
      readonly status: 'account_confirmed'
      readonly method: VerificationMethod
      readonly nameEvidence: NameMatchEvidence
    }
  /** A definitive negative: the destination is not usable. */
  | {
      readonly status: 'failed'
      readonly method: VerificationMethod
      readonly reasonCode: VerificationFailureCode
      readonly nameEvidence: NameMatchEvidence
    }
  /** Accepted, still running. The result arrives later as a provider event. */
  | {
      readonly status: 'verifying'
      readonly method: VerificationMethod
      /** The provider's own handle for this check, for callback correlation. */
      readonly providerReference: string
    }

/**
 * Closed taxonomy (`INV-43`: an unmapped provider code is ingested and mapped
 * to `unavailable`, never thrown away and never allowed to throw).
 */
export type VerificationFailureCode =
  | 'account_not_found'
  | 'account_closed'
  | 'account_frozen'
  | 'name_mismatch'
  | 'invalid_ifsc'
  | 'vpa_not_found'
  | 'rejected_by_bank'
  | 'unavailable'

export const VERIFICATION_FAILURE_CODES = [
  'account_not_found',
  'account_closed',
  'account_frozen',
  'name_mismatch',
  'invalid_ifsc',
  'vpa_not_found',
  'rejected_by_bank',
  'unavailable',
] as const satisfies readonly VerificationFailureCode[]

/**
 * A result arriving asynchronously — a webhook, a poll, an operator action.
 *
 * `destinationVersionId` is carried so the application can refuse a callback
 * that would verify a version other than the one that was asked about. That
 * check is not optional and is not the provider's job (`INV-45`).
 */
export interface VerificationCallback {
  readonly requestId: string
  readonly destinationVersionId: string
  readonly providerEventId: string
  readonly outcome: VerificationOutcome
}

export interface BeneficiaryVerificationProvider {
  /** Stable identifier persisted with every verification and provider event. */
  readonly id: string
  /** Which method this adapter actually uses. `D-11` picks the adapter. */
  readonly method: VerificationMethod
  readonly supports: (kind: DestinationKind) => boolean
  /**
   * Start or resume a check. Calling twice with the same `requestId` must
   * return the same outcome and must not start a second real check.
   */
  verify(request: VerificationRequest): Promise<VerificationOutcome>
  /**
   * Interpret a raw provider payload. Returns null when the payload is not a
   * verification result this adapter recognises; it must never throw
   * (`INV-43`) — the raw event is already persisted by then (`INV-33`).
   */
  interpret?(raw: unknown): VerificationCallback | null
}

/**
 * There is deliberately no exported name-match threshold here.
 *
 * A previous revision carried `NAME_MATCH_THRESHOLD = 80`, which asserted that
 * every provider and every method reports name similarity on one comparable
 * 0..100 scale. That is not true and cannot be made true before `D-11` is
 * answered. The decision now lives in `name-match.ts` as versioned, sourced
 * policy data keyed by `(providerId, method)`, and `80` survives only as
 * explicitly labelled sandbox simulator configuration.
 */

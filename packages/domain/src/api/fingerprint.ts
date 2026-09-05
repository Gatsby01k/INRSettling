/**
 * The request fingerprint — what `API_CONTRACT.md § 4` compares when the same
 * idempotency key arrives twice.
 *
 * > A replay with the same key **and** the same body returns the original
 * > response […]. A replay with the same key and a **different** body returns
 * > `409 idempotency_key_reuse`.
 *
 * **Get the direction of failure right.** A false *conflict* is a `409` — the
 * client sees an error and fixes it. A false *replay* is a lost payment reported
 * as a success: the client is told payment #2 went through, receives payment
 * #1's response body, and never sends the money. Every ambiguous decision below
 * is therefore biased toward the conflict.
 *
 * What is hashed is the **validated request**, not the raw bytes:
 *
 * - Raw bytes would make whitespace and key order into spurious conflicts. A
 *   client that switched JSON serialisers between a request and its retry would
 *   be told its own body was wrong.
 * - The **target** is part of it, not just the body. `POST /…/authorize` is sent
 *   with no body at all, so on that endpoint the body hash is a constant; without
 *   the target, one key reused across two settlements would replay the first and
 *   the second would never be authorized. The claim's `endpoint` column carries
 *   the concrete path for the same reason, and the two are belt and braces.
 * - The **API version** is part of it. A client that re-pins between a request
 *   and its retry would otherwise receive a body serialised under the version it
 *   just moved off. Including it turns that into a `409` — safe, and visible.
 *
 * Canonicalisation is `canonicalize` from `receipts/artifact.ts`, the same
 * function the receipt `content_hash` uses. Two hash functions that are supposed
 * to agree about JSON and don't is its own bug class.
 */
import { canonicalize, type CanonicalValue } from '../receipts/artifact.js'

/**
 * Bumped whenever the rules below change.
 *
 * Stored beside every claim: on a mismatch the claim is treated as a replay if
 * the *key* matches rather than being re-hashed under new rules, because a
 * deploy that changed canonicalisation would otherwise turn every live key into
 * `409 idempotency_key_reuse` at the moment of the rollout.
 */
export const FINGERPRINT_VERSION = 'v1'

export interface FingerprintInput {
  readonly method: string
  /** The concrete target, ids resolved: `/v1/settlements/stl_2Rn8Kq5TzYw6/authorize`. */
  readonly path: string
  readonly apiVersion: string
  /** The parsed, schema-validated body. `null` when the request carries none. */
  readonly body: CanonicalValue | null
}

/**
 * Normalise a value for hashing.
 *
 * **NFC, never NFKC.** Without normalisation, `"José"` composed (NFC) and
 * decomposed (NFD — what a macOS filesystem hands you) are byte-different and
 * canonically identical, so a legitimate retry from a different platform would
 * be refused. NFKC would be actively dangerous in the other direction: it folds
 * `ﬁ` to `fi` and full-width digits to ASCII, so it could merge two genuinely
 * different account numbers into one fingerprint — a false replay.
 */
function normalise(value: CanonicalValue): CanonicalValue {
  if (typeof value === 'string') return value.normalize('NFC')
  if (typeof value === 'bigint') return value
  if (Array.isArray(value)) return value.map(normalise)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, CanonicalValue> = {}
    for (const [k, v] of Object.entries(value as Record<string, CanonicalValue>)) {
      // Keys are normalised too: two objects whose keys differ only by
      // composition are the same object.
      out[k.normalize('NFC')] = normalise(v)
    }
    return out
  }
  return value
}

/**
 * The bytes that get hashed. Exported so a test can read them, and so a support
 * conversation about a surprising `409` can show the customer exactly what
 * differed rather than two hex strings.
 */
export function fingerprintPreimage(input: FingerprintInput): string {
  return canonicalize(
    normalise({
      v: FINGERPRINT_VERSION,
      method: input.method.toUpperCase(),
      path: input.path,
      api_version: input.apiVersion,
      // `null` is the document's own value for "no body", distinct from a body
      // that happens to be the JSON literal null — which the schemas refuse.
      body: input.body,
    }),
  )
}

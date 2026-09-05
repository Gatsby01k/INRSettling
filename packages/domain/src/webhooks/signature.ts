/**
 * Webhook signatures — `SECURITY.md § 4.1`, `API_CONTRACT.md § 10.3`.
 *
 * ```
 * INRSettle-Signature: t=1756636800,v1=<hex hmac-sha256 of "{t}.{raw_body}">
 * ```
 *
 * Both halves live here: the signer the worker uses, and the **verifier the
 * customer's snippets implement**. They are one file on purpose. The published
 * TypeScript, Python and Go snippets are checked against this implementation by
 * a test, so "the docs and the server agree" is a build result rather than a
 * hope.
 *
 * Three rules the frozen documents make explicit, each because getting it wrong
 * is a vulnerability we would have handed the customer:
 *
 * **Compare in constant time.** Unlike the API-key path — where the lookup is by
 * digest of a 192-bit secret and a timing signal has no hill to climb — this
 * comparison is against a value the attacker supplies and can vary one byte at a
 * time, with the correct answer derivable byte by byte from the response. Here
 * `===` is a real vulnerability, not a theoretical one.
 *
 * **Reject a stale timestamp exactly as hard as a future one.** The check is
 * `|now − t| > tolerance`, never `t > now + tolerance`. A stale `t` is precisely
 * what a replay looks like: an attacker who captures one valid signed request
 * and only ever resends it verbatim never produces a future timestamp, so a
 * one-sided check leaves the replay window open forever.
 *
 * **The signature covers `"{t}.{raw_body}"`, not the body.** Signing the body
 * alone would make the timestamp unauthenticated, and an unauthenticated
 * timestamp can simply be rewritten by whoever is replaying.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** `|now − t| > 300s` fails. `§ 10.3` states the number; it is not a knob. */
export const SIGNATURE_TOLERANCE_SECONDS = 300

export const SIGNATURE_SCHEME = 'v1'

export function signedPayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`
}

export function computeSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac('sha256', secret)
    .update(signedPayload(timestampSeconds, rawBody), 'utf8')
    .digest('hex')
}

/**
 * The header value.
 *
 * During a secret rotation there are two `v1=` values, one per live secret, and
 * a verifier accepts the message if **any** of them matches. That is what makes
 * rotation with overlap possible without dropping an event: the customer can cut
 * over on their own schedule, and both the old and the new configuration verify
 * throughout the window (`SECURITY.md § 4.1`).
 */
export function buildSignatureHeader(args: {
  secrets: readonly string[]
  timestampSeconds: number
  rawBody: string
}): string {
  const parts = args.secrets.map(
    (s) => `${SIGNATURE_SCHEME}=${computeSignature(s, args.timestampSeconds, args.rawBody)}`,
  )
  return [`t=${args.timestampSeconds}`, ...parts].join(',')
}

export interface ParsedSignatureHeader {
  readonly timestampSeconds: number
  readonly signatures: readonly string[]
}

export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null
      timestamp = Number(value)
    } else if (key === SIGNATURE_SCHEME) {
      if (/^[0-9a-f]+$/i.test(value)) signatures.push(value.toLowerCase())
    }
  }
  if (timestamp === null || signatures.length === 0) return null
  return { timestampSeconds: timestamp, signatures }
}

export type WebhookSignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed_header' | 'timestamp_outside_tolerance' | 'no_matching_signature' }

/**
 * Verify a delivery. This is the reference implementation the published snippets
 * are tested against.
 *
 * @param nowSeconds passed in rather than read from a clock, so the tolerance
 *   rule is testable in both directions without waiting or mocking time. A
 *   verifier that could not be tested against a future timestamp is a verifier
 *   whose future-side check nobody has ever run.
 */
export function verifySignature(args: {
  header: string
  rawBody: string
  secrets: readonly string[]
  nowSeconds: number
  toleranceSeconds?: number
}): WebhookSignatureVerdict {
  const parsed = parseSignatureHeader(args.header)
  if (parsed === null) return { ok: false, reason: 'malformed_header' }

  const tolerance = args.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS
  if (Math.abs(args.nowSeconds - parsed.timestampSeconds) > tolerance) {
    return { ok: false, reason: 'timestamp_outside_tolerance' }
  }

  for (const secret of args.secrets) {
    const expected = computeSignature(secret, parsed.timestampSeconds, args.rawBody)
    for (const presented of parsed.signatures) {
      if (constantTimeEquals(expected, presented)) return { ok: true }
    }
  }
  return { ok: false, reason: 'no_matching_signature' }
}

/**
 * Constant time within a length class.
 *
 * The length check short-circuits, which is correct and unavoidable: hex digests
 * of a fixed algorithm are a fixed length, so a length mismatch leaks only that
 * the attacker did not send 64 hex characters — which they already know.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

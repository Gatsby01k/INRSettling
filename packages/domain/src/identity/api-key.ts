/**
 * API key policy — SECURITY.md § 3.3. Pure rules only; generation, hashing and
 * storage belong to the application layer.
 */
import type { Environment } from '@inrsettle/contracts'
import type { Capability } from './capabilities.js'

export const KEY_PREFIX: Record<Environment, string> = {
  live: 'sk_live_',
  sandbox: 'sk_test_',
}

export function prefixFor(environment: Environment): string {
  return KEY_PREFIX[environment]
}

export function environmentForKey(plaintext: string): Environment | null {
  if (plaintext.startsWith(KEY_PREFIX.live)) return 'live'
  if (plaintext.startsWith(KEY_PREFIX.sandbox)) return 'sandbox'
  return null
}

export type KeyDenialCode =
  | 'malformed'
  | 'unknown_key'
  | 'revoked'
  | 'wrong_environment'
  | 'missing_scope'

export type KeyDecision =
  | { allowed: true }
  | { allowed: false; code: KeyDenialCode }

export interface KeyFacts {
  found: boolean
  revoked: boolean
  environment: Environment
  scopes: readonly string[]
}

/**
 * A key addressing the other environment is `not_found`, never `forbidden`: a
 * wrong-environment key must not confirm that an object exists.
 */
export function evaluateApiKey(
  plaintext: string,
  facts: KeyFacts | null,
  required: { environment: Environment; capability?: Capability },
): KeyDecision {
  if (environmentForKey(plaintext) === null) return { allowed: false, code: 'malformed' }
  if (!facts || !facts.found) return { allowed: false, code: 'unknown_key' }
  if (facts.revoked) return { allowed: false, code: 'revoked' }
  if (facts.environment !== required.environment) {
    return { allowed: false, code: 'wrong_environment' }
  }
  if (required.capability && !facts.scopes.includes(required.capability)) {
    return { allowed: false, code: 'missing_scope' }
  }
  return { allowed: true }
}

/** Scopes are capabilities; a key can never hold one its grantor lacks. */
export function scopesWithin(
  requested: readonly string[],
  grantorCapabilities: ReadonlySet<Capability>,
): { ok: true } | { ok: false; disallowed: string[] } {
  const disallowed = requested.filter((s) => !grantorCapabilities.has(s as Capability))
  return disallowed.length === 0 ? { ok: true } : { ok: false, disallowed }
}

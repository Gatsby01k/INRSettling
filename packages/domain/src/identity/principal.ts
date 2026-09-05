import type { PrincipalRef, PrincipalType } from '@inrsettle/contracts'

export type { PrincipalRef, PrincipalType }

/**
 * Two principals are the same principal when their type and id both match.
 *
 * Decision D-007 applies separation of duties "consistently to human and API
 * principals", which is exactly this comparison: a user is not the same
 * principal as an API key, and two different API keys are two principals.
 */
export function samePrincipal(a: PrincipalRef, b: PrincipalRef): boolean {
  return a.type === b.type && a.id === b.id
}

export function formatPrincipal(p: PrincipalRef): string {
  return `${p.type}:${p.id}`
}

/**
 * Content hashing for financial artifacts — `INV-29`, `INV-48`.
 *
 * Separate from `artifact.ts` for a layering reason rather than a stylistic
 * one: this file uses `node:crypto`, so it is a server concern and is
 * deliberately absent from `browser.ts`. A receipt screen renders the canonical
 * document — the *same* object the PDF and the API render — and is handed the
 * hash. It never mints one. A UI that could compute the hash of a financial
 * record is a UI that could compute the hash of a record it had edited.
 *
 * The format is `sha256:<hex>`, matching what `API_CONTRACT.md § 7.6` shows on
 * the wire. The prefix is not decoration: it means a stored hash says which
 * algorithm produced it, so a future change of algorithm is a new prefix rather
 * than a silent reinterpretation of every historical row.
 */
import { createHash } from 'node:crypto'
import { canonicalize, type CanonicalArtifact } from './artifact.js'

export const CONTENT_HASH_PREFIX = 'sha256:'

/** The exact bytes an artifact's hash is taken over, and that a PDF renders. */
export function canonicalBytes(artifact: CanonicalArtifact): string {
  return canonicalize(artifact.document)
}

export function contentHash(artifact: CanonicalArtifact): string {
  return CONTENT_HASH_PREFIX + createHash('sha256').update(canonicalBytes(artifact), 'utf8').digest('hex')
}

/**
 * Check a stored artifact against its stored hash.
 *
 * The point of a `content_hash` is not that it exists — it is that somebody can
 * re-derive it and get the same answer. An artifact store nobody ever verifies
 * is a store whose corruption is discovered by a customer.
 */
export function verifyContentHash(artifact: CanonicalArtifact, expected: string): boolean {
  return contentHash(artifact) === expected
}

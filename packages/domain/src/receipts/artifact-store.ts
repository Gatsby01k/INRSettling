/**
 * The artifact object store port — `INV-48`.
 *
 * > *"its stored PDF object is written once to a key that is never overwritten,
 * > enforced by an object-storage policy that grants the application no
 * > overwrite or delete permission on the receipts prefix."*
 *
 * The invariant names two enforcements, and both matter for different failure
 * modes. The bucket policy is what holds when this code is wrong. **This
 * interface is what stops the code being written wrong in the first place**, and
 * it does it by omission: there is no `put`, no `overwrite`, no `delete`, no
 * `upsert`, and no `force` flag. The only write is `putIfAbsent`, whose return
 * type makes the already-exists case something the caller must handle rather
 * than something it can pretend did not happen.
 *
 * A port that offered `put` and relied on a bucket policy to refuse it would
 * fail at deploy time, in production, on the one path nobody exercised — which
 * is exactly where a financial artifact must not fail.
 */

export interface StoredObject {
  readonly key: string
  readonly bytes: Uint8Array
  readonly contentType: string
}

export type PutResult =
  | { readonly ok: true; readonly key: string; readonly bytes: number }
  /**
   * The key already holds an object. Deliberately **not** an error: `INV-48`
   * plus at-least-once job delivery means a retried render *will* hit this, and
   * the correct response is to carry on. The first write wins and the second is
   * discarded, which is precisely what write-once means.
   *
   * Note what this result no longer carries: a byte comparison against what was
   * already there. Chromium stamps `/CreationDate` into every document it
   * prints, so two renderings of one receipt differ — and an alarm on that would
   * fire on a clock tick rather than on a problem.
   *
   * Losing the comparison costs nothing, because it was never the guarantee. Two
   * different artifacts cannot claim one key: the artifact id is a primary key,
   * the object key is derived from it, and a unique index on `pdf_object_key`
   * refuses a collision at the database. That holds whether or not rendering
   * happens to be reproducible.
   */
  | { readonly ok: false; readonly reason: 'already_exists' }

export interface ArtifactStore {
  /**
   * Write an object if, and only if, its key is free.
   *
   * Implementations must make this atomic against a concurrent caller. Reading
   * then writing is not an implementation of this method.
   */
  putIfAbsent(object: StoredObject): Promise<PutResult>
  get(key: string): Promise<StoredObject | null>
  /**
   * A short-lived URL for a stored object, as `API_CONTRACT.md § 7.6` describes.
   * Read-only by construction: nothing in this port can mint a writable one.
   */
  presignedUrl(key: string, ttlSeconds: number): Promise<string>
}

/**
 * Where an artifact's bytes live.
 *
 * Keys are derived from the artifact's own id, so they are as immutable as it
 * is and two issuances of one artifact necessarily collide rather than
 * coexisting under different names. The `receipts/` prefix is the one the
 * bucket policy denies overwrite on, and notices and composites live under it
 * for the same reason: all three are financial artifacts, and the invariant does
 * not distinguish between them.
 */
export const ARTIFACT_PREFIX = 'receipts/'

export function artifactObjectKey(kind: string, artifactId: string): string {
  return `${ARTIFACT_PREFIX}${kind}/${artifactId}.pdf`
}

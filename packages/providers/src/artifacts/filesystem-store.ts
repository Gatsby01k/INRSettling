/**
 * A write-once artifact store on the filesystem — `INV-48`.
 *
 * Stands in for the object storage a deployment uses, and stands in for it
 * *honestly*: the property that matters is not "files land somewhere" but
 * **"a key that has been written cannot be written again"**, and this adapter
 * has to demonstrate that property or it proves nothing about the real one.
 *
 * The mechanism is `open(path, 'wx')` — create-exclusive. The kernel decides,
 * atomically, whether this call is the one that created the file; a losing
 * caller gets `EEXIST` and no bytes are written. That is a real guarantee under
 * concurrency, which a `existsSync` check followed by a write is not: between
 * the check and the write another worker can create the file, and both callers
 * then believe they wrote it.
 *
 * In a real deployment the same shape holds with S3 conditional writes
 * (`If-None-Match: *`) plus a bucket policy denying `s3:PutObject` overwrite and
 * `s3:DeleteObject` on the `receipts/` prefix. The port's shape is what makes
 * both implementable without an overwrite path existing anywhere in the code.
 */
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import type { ArtifactStore, PutResult, StoredObject } from '@inrsettle/domain'
import { ARTIFACT_PREFIX } from '@inrsettle/domain'

export interface FilesystemStoreOptions {
  /** The directory that stands in for the bucket. */
  readonly root: string
  /**
   * How a presigned URL is spelled. Injected because the URL shape is a
   * deployment fact, and a hard-coded one here would be a fixture pretending to
   * be configuration.
   */
  readonly baseUrl?: string
}

export interface FilesystemArtifactStore extends ArtifactStore {
  /**
   * Every key written by this store, for tests that need to prove the *absence*
   * of a second write rather than the presence of a first.
   */
  readonly written: ReadonlyMap<string, string>
}

export function createFilesystemArtifactStore(
  options: FilesystemStoreOptions,
): FilesystemArtifactStore {
  const root = resolve(options.root)
  const baseUrl = options.baseUrl ?? 'https://artifacts.invalid'
  const written = new Map<string, string>()

  /**
   * Resolve a key to a path, refusing anything that escapes the root.
   *
   * A key is derived from an artifact id, so traversal should be impossible —
   * but "should be impossible" is how a path traversal gets shipped. The check
   * costs one comparison and removes the class.
   */
  function pathFor(key: string): string {
    const full = resolve(join(root, normalize(key)))
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`artifact key ${key} resolves outside the store root`)
    }
    if (!key.startsWith(ARTIFACT_PREFIX)) {
      // Everything this store holds is a financial artifact, and the prefix is
      // what the deployment's deny-overwrite policy is written against. A key
      // outside it would be a file with none of the protection.
      throw new Error(`artifact key ${key} is outside the ${ARTIFACT_PREFIX} prefix`)
    }
    return full
  }

  return {
    written,

    async putIfAbsent(object: StoredObject): Promise<PutResult> {
      const path = pathFor(object.key)
      await mkdir(dirname(path), { recursive: true })

      let handle
      try {
        // 'wx' — create, and fail if it exists. The atomicity is the kernel's,
        // which is the only place it can honestly live.
        handle = await open(path, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // Already written, and the first write wins. Not an error: at-least-once
        // job delivery plus a write-once artifact means a retry will land here,
        // and discarding the second rendering is what write-once means.
        return { ok: false, reason: 'already_exists' }
      }

      try {
        await handle.write(object.bytes)
      } finally {
        await handle.close()
      }
      written.set(object.key, object.contentType)
      return { ok: true, key: object.key, bytes: object.bytes.byteLength }
    },

    async get(key: string): Promise<StoredObject | null> {
      try {
        const bytes = await readFile(pathFor(key))
        return { key, bytes, contentType: written.get(key) ?? 'application/pdf' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },

    async presignedUrl(key: string, ttlSeconds: number): Promise<string> {
      // Read-only by construction: there is nothing in the port that could mint
      // a writable URL, so there is nothing here to get wrong.
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds
      return `${baseUrl}/${key}?expires=${expires}`
    },
  }
}

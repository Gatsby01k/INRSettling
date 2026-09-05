/**
 * Field encryption for account identifiers — `INV-12`, `SECURITY.md § 8`.
 *
 * Envelope encryption: a data key encrypts the field, and a key-encryption key
 * (KEK) held outside the database encrypts the data key. The ciphertext carries
 * the wrapped data key with it, so rotating the KEK re-wraps rather than
 * rewrites, and a database dump on its own decrypts nothing.
 *
 * Two rules this module exists to make hard to break:
 *
 *   A plaintext account number never leaves the function that needs it. The
 *   only thing persisted is `{ciphertext, last4}`; there is no "decrypt for
 *   display" path, because display uses `last4`.
 *
 *   Ciphertext is authenticated (AES-256-GCM) and bound to the field it belongs
 *   to via additional authenticated data. A ciphertext lifted from one row
 *   cannot be replayed into another.
 */
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto'

export const FIELD_ENCRYPTION_VERSION = 'v1'

export class FieldEncryptionError extends Error {
  constructor(
    message: string,
    readonly code: 'key_missing' | 'key_malformed' | 'ciphertext_malformed' | 'decrypt_failed',
  ) {
    super(message)
    this.name = 'FieldEncryptionError'
  }
}

/** What the ciphertext is bound to. Changing any part makes it undecryptable. */
export interface FieldContext {
  /** e.g. `payout_destination_version.account_number` */
  readonly field: string
  readonly workspaceId: string
  readonly environment: string
}

export interface FieldCipher {
  encrypt(plaintext: string, context: FieldContext): string
  decrypt(encoded: string, context: FieldContext): string
  /** Which KEK produced a given ciphertext, for rotation. */
  keyIdOf(encoded: string): string
}

function aad(context: FieldContext): Buffer {
  return Buffer.from(
    `${FIELD_ENCRYPTION_VERSION}|${context.field}|${context.workspaceId}|${context.environment}`,
    'utf8',
  )
}

/**
 * The encoded form: `v1.<keyId>.<wrappedKey>.<iv>.<tag>.<ciphertext>`, base64url
 * throughout. Self-describing so a row can be decrypted years later without a
 * side table saying how.
 */
export function createFieldCipher(keys: {
  /** Active KEK id — the one new ciphertext is written with. */
  activeKeyId: string
  /** All KEKs by id, so ciphertext written under a retired key still opens. */
  keks: Readonly<Record<string, Buffer>>
}): FieldCipher {
  const active = keys.keks[keys.activeKeyId]
  if (!active) {
    throw new FieldEncryptionError(
      `active key ${keys.activeKeyId} is not present in the key set`,
      'key_missing',
    )
  }
  for (const [id, kek] of Object.entries(keys.keks)) {
    if (kek.length !== 32) {
      throw new FieldEncryptionError(`KEK ${id} must be 32 bytes, got ${kek.length}`, 'key_malformed')
    }
  }

  const b64 = (b: Buffer): string => b.toString('base64url')
  const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url')

  /** Wrap the data key with the KEK, using the same AEAD and the same binding. */
  function wrapDataKey(dataKey: Buffer, kek: Buffer, context: FieldContext): string {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', kek, iv)
    c.setAAD(aad(context))
    const wrapped = Buffer.concat([c.update(dataKey), c.final()])
    return `${b64(iv)}~${b64(c.getAuthTag())}~${b64(wrapped)}`
  }

  function unwrapDataKey(encoded: string, kek: Buffer, context: FieldContext): Buffer {
    const [ivPart, tagPart, wrappedPart] = encoded.split('~')
    if (!ivPart || !tagPart || !wrappedPart) {
      throw new FieldEncryptionError('wrapped key is malformed', 'ciphertext_malformed')
    }
    const d = createDecipheriv('aes-256-gcm', kek, unb64(ivPart))
    d.setAAD(aad(context))
    d.setAuthTag(unb64(tagPart))
    return Buffer.concat([d.update(unb64(wrappedPart)), d.final()])
  }

  return {
    encrypt(plaintext, context) {
      // A fresh data key per value: two rows holding the same account number
      // produce different ciphertext, so the table cannot be used to find
      // duplicates by eye. Equality is answered by `content_hash` instead,
      // which is deliberate and scoped to payout details.
      const dataKey = Buffer.from(
        hkdfSync('sha256', randomBytes(32), Buffer.alloc(0), aad(context), 32),
      )
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', dataKey, iv)
      c.setAAD(aad(context))
      const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
      const parts = [
        FIELD_ENCRYPTION_VERSION,
        keys.activeKeyId,
        wrapDataKey(dataKey, active, context),
        b64(iv),
        b64(c.getAuthTag()),
        b64(ct),
      ]
      dataKey.fill(0)
      return parts.join('.')
    },

    decrypt(encoded, context) {
      const parts = encoded.split('.')
      if (parts.length !== 6 || parts[0] !== FIELD_ENCRYPTION_VERSION) {
        throw new FieldEncryptionError('ciphertext is malformed', 'ciphertext_malformed')
      }
      const [, keyId, wrapped, ivPart, tagPart, ctPart] = parts as [
        string, string, string, string, string, string,
      ]
      const kek = keys.keks[keyId]
      if (!kek) throw new FieldEncryptionError(`key ${keyId} is not available`, 'key_missing')
      try {
        const dataKey = unwrapDataKey(wrapped, kek, context)
        const d = createDecipheriv('aes-256-gcm', dataKey, unb64(ivPart))
        d.setAAD(aad(context))
        d.setAuthTag(unb64(tagPart))
        const out = Buffer.concat([d.update(unb64(ctPart)), d.final()]).toString('utf8')
        dataKey.fill(0)
        return out
      } catch (e) {
        if (e instanceof FieldEncryptionError) throw e
        // Deliberately opaque: which of AAD, tag or key failed is not something
        // a caller should be able to probe.
        throw new FieldEncryptionError('ciphertext could not be decrypted', 'decrypt_failed')
      }
    },

    keyIdOf(encoded) {
      const keyId = encoded.split('.')[1]
      if (!keyId) throw new FieldEncryptionError('ciphertext is malformed', 'ciphertext_malformed')
      return keyId
    },
  }
}

/**
 * Build a cipher from the environment.
 *
 * `INRSETTLE_FIELD_KEYS` is `id:base64,id:base64,…` and `INRSETTLE_FIELD_KEY_ID`
 * names the active one. In deployment these come from the secret manager, and
 * the read-only reporting credentials do not have them — which is what "a key
 * that is not available to the application's read paths" means in `INV-12`.
 */
export function fieldCipherFromEnv(env: NodeJS.ProcessEnv = process.env): FieldCipher {
  const raw = env['INRSETTLE_FIELD_KEYS']
  const activeKeyId = env['INRSETTLE_FIELD_KEY_ID']
  if (!raw || !activeKeyId) {
    throw new FieldEncryptionError(
      'INRSETTLE_FIELD_KEYS and INRSETTLE_FIELD_KEY_ID must both be set',
      'key_missing',
    )
  }
  const keks: Record<string, Buffer> = {}
  for (const entry of raw.split(',')) {
    const [id, material] = entry.split(':')
    if (!id || !material) {
      throw new FieldEncryptionError('INRSETTLE_FIELD_KEYS is malformed', 'key_malformed')
    }
    keks[id.trim()] = Buffer.from(material.trim(), 'base64')
  }
  return createFieldCipher({ activeKeyId, keks })
}

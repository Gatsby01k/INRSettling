/**
 * What the API is given, rather than what it reaches for.
 *
 * `SECURITY.md § 8` is a table, and this file is its implementation:
 *
 * > | Process | Payout-provider credentials | Destination decryption |
 * > | `api`   | **no**                      | **no**                 |
 * >
 * > `api` does not need either: it renders masked details from the last four
 * > digits held in clear, and it records intent that `worker` executes.
 * > Granting it credentials "because it is also a backend" is exactly the
 * > reasoning that turns a public-facing process into a payout oracle.
 *
 * There is no payout provider here. And the destination cipher needs a word,
 * because `POST /v1/beneficiaries` obviously has to *write* an account number
 * even though this process may never *read* one.
 *
 * So the API is handed an **encryptor**, not a cipher. `encryptOnlyCipher`
 * satisfies the shape `packages/app` asks for and throws on `decrypt` and
 * `keyIdOf`, so "the API cannot decrypt a payout destination" is a property a
 * test can assert rather than a rule somebody has to keep remembering. What
 * that does *not* give you is key separation — AES-GCM is symmetric, so a
 * process holding the encryption key holds the material to decrypt with it, and
 * the boundary here is a capability boundary rather than a cryptographic one.
 * Closing that properly means the API holding only a wrapping key it cannot
 * unwrap, which is a KMS arrangement at deployment (`SECURITY.md § 9`) and not
 * something this build can assert. It is recorded in the stage notes as the one
 * place the § 8 table is honoured in software rather than in keys.
 */
import type {
  DestinationFingerprinter, PreflightRuleSet, VerificationMethod,
} from '@inrsettle/domain'
import type { FieldCipher, FieldContext } from '@inrsettle/app-services'

/** The half of a cipher the API is allowed to have. */
export interface FieldEncryptor {
  encrypt(plaintext: string, context: FieldContext): string
}

export class DecryptionNotAvailable extends Error {
  constructor() {
    super(
      'the api process holds no destination decryption capability (SECURITY.md § 8) — ' +
      'masked details come from the last four digits held in clear, and anything ' +
      'needing plaintext is worker work',
    )
    this.name = 'DecryptionNotAvailable'
  }
}

export function encryptOnlyCipher(encryptor: FieldEncryptor): FieldCipher {
  return {
    encrypt: (plaintext, context) => encryptor.encrypt(plaintext, context),
    decrypt: () => { throw new DecryptionNotAvailable() },
    keyIdOf: () => { throw new DecryptionNotAvailable() },
  }
}

export interface ApiDeps {
  /** The versioned preflight rule set (`D-06` is open; the set is data). */
  readonly ruleSet: PreflightRuleSet
  /** Write-only, by construction. See the header. */
  readonly destinationEncryptor: FieldEncryptor
  readonly destinationFingerprinter: DestinationFingerprinter
  /**
   * For webhook signing secrets, which are the API's own concern and are not
   * payout data. A separate cipher context, so the same key cannot reach an
   * account number even if it were the same key.
   */
  readonly webhookCipher: FieldCipher
  /**
   * Which verification provider the recorded request names.
   *
   * The API records intent; `worker` holds the adapter and the credential. It
   * records *which* provider will run so the row is meaningful before the job
   * does, and so a mismatch between what was recorded and what ran is visible
   * rather than inferred.
   */
  readonly verificationProviderId: string
  readonly verificationMethod: VerificationMethod
  /** Whether the workspace has a live facility — a preflight input. */
  readonly hasActiveLiquidityFacility: boolean
  readonly now?: () => Date
  /**
   * Where an unexpected throw goes. The customer gets `500` and a `request_id`;
   * this is what makes the `request_id` worth anything to us.
   */
  readonly onUnexpectedError?: (error: unknown, requestId: string) => void
}

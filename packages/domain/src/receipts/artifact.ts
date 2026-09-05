/**
 * Financial artifacts — `DOMAIN.md § 6.9`, `INV-28`, `INV-29`, `INV-42`, `INV-48`.
 *
 * Three artifacts, three independent hashes, and the relationship between them
 * is *composition*, never absorption:
 *
 * - **`SettlementReceipt`** — issued once, when a settlement becomes `SETTLED`.
 * - **`ReturnNotice`** — issued when a return is confirmed. A separate artifact,
 *   *"not an addition to the receipt"*.
 * - **`ReceiptComposite`** — the optional export rendering both together. A
 *   *"third artifact with its own hash"* that *"never replaces, rewrites or
 *   invalidates either source"*.
 *
 * ## Why this file is pure, and why the hashing is not in it
 *
 * `INV-29` requires that *"for each artifact, the UI, PDF and API
 * representations are rendered from that artifact's one canonical serialisation
 * and carry its `content_hash`. They cannot disagree."*
 *
 * The only way to make "cannot" true rather than aspirational is for all three
 * to render the *same object*. So the canonical document is built here, with no
 * Node built-ins, and is exported through `browser.ts` — a receipt screen
 * renders the real serialisation rather than a second description of it. The
 * `content_hash` is computed in `hash.ts`, which uses `node:crypto` and stays on
 * the server, because a browser has no business minting the hash of a financial
 * record. It is handed one and displays it.
 *
 * ## Why the serialisation is canonical rather than "whatever JSON.stringify did"
 *
 * `INV-48` says an artifact is *"never re-serialised, never re-rendered and
 * never re-hashed"*. That is a rule about what the system does, and it is worth
 * holding, but it is not a guarantee about what the bytes are. If the hash
 * depended on key insertion order, then two runs of the same builder could
 * disagree, and the invariant would be resting on a coincidence. Keys are sorted
 * recursively and amounts are minor-unit decimal strings, so the bytes are a
 * function of the content and nothing else.
 */

/* ── Canonical JSON ─────────────────────────────────────────────────────── */

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | bigint
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue }

/**
 * Deterministic bytes for a value.
 *
 * Rules, each chosen because its absence has bitten somebody:
 *
 * - **Object keys are sorted**, recursively. Insertion order is not content.
 * - **`bigint` becomes a decimal string**, never a JSON number. `JSON.stringify`
 *   cannot represent a bigint at all, and a money amount that silently became a
 *   float would be a hash over a rounded figure.
 * - **`undefined` is rejected**, not skipped. A field that is absent and a field
 *   that is present-and-undefined must not hash the same, and the honest fix is
 *   for the builder to omit it deliberately.
 * - **No whitespace**, so formatting can never change a hash.
 */
export function canonicalize(value: CanonicalValue): string {
  if (value === null) return 'null'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical serialisation cannot represent a non-finite number')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`

  const entries = Object.entries(value as Record<string, CanonicalValue>)
  for (const [key, v] of entries) {
    if (v === undefined) {
      throw new TypeError(
        `canonical serialisation refuses undefined at "${key}" — omit the field instead, ` +
          'so an absent field and a present-but-undefined one cannot hash alike',
      )
    }
  }
  const sorted = entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${sorted.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}

/* ── The artifact kinds ─────────────────────────────────────────────────── */

export const ARTIFACT_KINDS = ['settlement_receipt', 'return_notice', 'receipt_composite'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/**
 * The serialisation version, carried *inside* the hashed content.
 *
 * If the shape of a receipt ever changes, old receipts must keep verifying
 * against their own hashes. Recording the version in the document means a
 * verifier can tell "this is a v1 receipt and its hash is correct" from "this
 * is a v1 receipt someone re-serialised with v2 rules".
 */
export const ARTIFACT_SCHEMA_VERSION = 'v1'

export interface CanonicalArtifact {
  readonly kind: ArtifactKind
  readonly document: Record<string, CanonicalValue>
}

/** A money amount, in the one shape every artifact uses. */
export interface ArtifactMoney {
  readonly currency: string
  readonly minorUnits: bigint
}

const moneyDoc = (m: ArtifactMoney): Record<string, CanonicalValue> => ({
  currency: m.currency,
  minor_units: m.minorUnits,
})

/* ── The receipt ────────────────────────────────────────────────────────── */

/**
 * Everything a receipt records, all of it by value.
 *
 * `INV-28`: *"The receipt embeds snapshots, not joins. A later edit to a
 * beneficiary's display name must not change a historical receipt."* So this
 * input takes a `beneficiary` object rather than a `beneficiaryId`, and there is
 * no way to express "look it up later" — the type will not hold a reference.
 */
export interface ReceiptContent {
  readonly receiptId: string
  readonly settlementId: string
  readonly settlementIdDisplay: string
  readonly workspaceId: string
  readonly environment: string
  /** `INV-28` — a snapshot taken at issuance, never a live join. */
  readonly beneficiarySnapshot: {
    readonly displayName: string
    readonly legalName: string | null
    readonly country: string
    readonly destinationKind: string
    readonly accountNumberLast4: string | null
    readonly ifsc: string | null
    readonly vpa: string | null
    readonly accountHolderName: string | null
    readonly destinationVersionId: string
  }
  readonly recipientAmount: ArtifactMoney
  /** What the rail says actually arrived. `null` where it stated no figure. */
  readonly deliveredAmount: ArtifactMoney | null
  readonly fundingAmount: ArtifactMoney
  readonly fxRate: string
  readonly feeComponents: readonly { readonly kind: string; readonly amount: ArtifactMoney }[]
  readonly roundingResidual: ArtifactMoney
  readonly purpose: string
  readonly externalReference: string | null
  readonly payoutReference: string
  readonly rail: string
  readonly reconciliationResult: string
  readonly finalStatus: string
  readonly authorizedTermsHash: string
  readonly createdAt: string
  readonly authorizedAt: string
  readonly creditedAt: string
  readonly settledAt: string
}

/**
 * Build the receipt's canonical document.
 *
 * Note what is **not** in it: any field about returns. `INV-42` requires the
 * receipt's `content_hash` to be *"byte-identical before and after any
 * return"*, and the surest way to guarantee that is for the builder to have no
 * parameter a return could be passed through. A later return cannot change these
 * bytes because there is no argument it could arrive as.
 */
export function receiptDocument(content: ReceiptContent): CanonicalArtifact {
  return {
    kind: 'settlement_receipt',
    document: {
      artifact: 'settlement_receipt',
      schema: ARTIFACT_SCHEMA_VERSION,
      id: content.receiptId,
      settlement_id: content.settlementId,
      settlement_id_display: content.settlementIdDisplay,
      workspace_id: content.workspaceId,
      environment: content.environment,
      beneficiary_snapshot: {
        display_name: content.beneficiarySnapshot.displayName,
        legal_name: content.beneficiarySnapshot.legalName,
        country: content.beneficiarySnapshot.country,
        destination_kind: content.beneficiarySnapshot.destinationKind,
        account_number_last4: content.beneficiarySnapshot.accountNumberLast4,
        ifsc: content.beneficiarySnapshot.ifsc,
        vpa: content.beneficiarySnapshot.vpa,
        account_holder_name: content.beneficiarySnapshot.accountHolderName,
        destination_version_id: content.beneficiarySnapshot.destinationVersionId,
      },
      recipient_amount: moneyDoc(content.recipientAmount),
      delivered_amount: content.deliveredAmount === null ? null : moneyDoc(content.deliveredAmount),
      funding_amount: moneyDoc(content.fundingAmount),
      fx_rate: content.fxRate,
      fee_components: content.feeComponents.map((f) => ({
        kind: f.kind,
        amount: moneyDoc(f.amount),
      })),
      rounding_residual: moneyDoc(content.roundingResidual),
      purpose: content.purpose,
      external_reference: content.externalReference,
      payout_reference: content.payoutReference,
      rail: content.rail,
      reconciliation_result: content.reconciliationResult,
      final_status: content.finalStatus,
      authorized_terms_hash: content.authorizedTermsHash,
      created_at: content.createdAt,
      authorized_at: content.authorizedAt,
      credited_at: content.creditedAt,
      settled_at: content.settledAt,
    },
  }
}

/* ── The return notice ──────────────────────────────────────────────────── */

export interface ReturnNoticeContent {
  readonly noticeId: string
  readonly returnId: string
  readonly settlementId: string
  readonly receiptId: string
  readonly workspaceId: string
  readonly environment: string
  readonly amount: ArtifactMoney
  readonly reasonCode: string
  readonly reasonMessage: string
  /** The return's status when the notice was cut, frozen into the document. */
  readonly returnStatusAtIssue: string
  readonly providerReturnReference: string
  readonly createdAt: string
}

/**
 * A notice references the receipt by id and hash; it does not restate it.
 *
 * Carrying the receipt's hash rather than its fields is what makes "composes,
 * does not absorb" checkable: a notice is provably *about* one specific version
 * of one specific receipt, and it did not copy anything it could later
 * contradict.
 */
export function returnNoticeDocument(
  content: ReturnNoticeContent,
  receiptContentHash: string,
): CanonicalArtifact {
  return {
    kind: 'return_notice',
    document: {
      artifact: 'return_notice',
      schema: ARTIFACT_SCHEMA_VERSION,
      id: content.noticeId,
      return_id: content.returnId,
      settlement_id: content.settlementId,
      receipt_id: content.receiptId,
      receipt_content_hash: receiptContentHash,
      workspace_id: content.workspaceId,
      environment: content.environment,
      amount: moneyDoc(content.amount),
      reason_code: content.reasonCode,
      reason_message: content.reasonMessage,
      return_status_at_issue: content.returnStatusAtIssue,
      provider_return_reference: content.providerReturnReference,
      created_at: content.createdAt,
    },
  }
}

/* ── The composite ──────────────────────────────────────────────────────── */

/**
 * The optional composite export — `DOMAIN.md § 6.9`, `API_CONTRACT.md § 7.6`.
 *
 * > *"That composite is a **third artifact** with its own hash; it never
 * > replaces, rewrites or invalidates either source."*
 *
 * It embeds each source's canonical document *and* its hash. Embedding the
 * documents is what lets it render as one PDF; embedding the hashes is what
 * makes it verifiable against its sources — a composite whose sources have been
 * tampered with stops matching, and one built from the real sources can be
 * checked without trusting whoever built it.
 */
export function compositeDocument(input: {
  compositeId: string
  settlementId: string
  workspaceId: string
  environment: string
  createdAt: string
  receipt: { readonly document: Record<string, CanonicalValue>; readonly contentHash: string }
  notices: readonly {
    readonly document: Record<string, CanonicalValue>
    readonly contentHash: string
  }[]
}): CanonicalArtifact {
  return {
    kind: 'receipt_composite',
    document: {
      artifact: 'receipt_composite',
      schema: ARTIFACT_SCHEMA_VERSION,
      id: input.compositeId,
      settlement_id: input.settlementId,
      workspace_id: input.workspaceId,
      environment: input.environment,
      created_at: input.createdAt,
      receipt: { content_hash: input.receipt.contentHash, document: input.receipt.document },
      // Ordered by the notices' own ids, so two composites over the same set of
      // sources are byte-identical however the caller ordered them.
      return_notices: [...input.notices]
        .map((n) => ({ content_hash: n.contentHash, document: n.document }))
        .sort((a, b) => {
          const x = String(a.document['id'] ?? '')
          const y = String(b.document['id'] ?? '')
          return x < y ? -1 : x > y ? 1 : 0
        }),
    },
  }
}

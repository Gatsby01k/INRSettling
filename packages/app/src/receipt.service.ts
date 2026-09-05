/**
 * Financial artifacts — Stage 6. `DOMAIN.md § 6.9`, `INV-28`, `INV-29`, `INV-42`, `INV-48`.
 *
 * Three artifacts are issued here and none of them is ever edited. What makes
 * that structural rather than aspirational is a stack of four refusals, each at
 * a different layer, because each catches a different mistake:
 *
 * 1. **The builder takes no return.** `receiptDocument` has no parameter a
 *    return could arrive through, so `INV-42`'s *"byte-identical before and
 *    after any return"* is a property of the type rather than of the caller's
 *    discipline.
 * 2. **The store has no overwrite.** `ArtifactStore` offers `putIfAbsent` and
 *    nothing else — no `put`, no `delete`, no `force`.
 * 3. **The table has no UPDATE grant**, and a trigger refuses one anyway.
 * 4. **The bucket policy** denies overwrite on the `receipts/` prefix, which is
 *    what holds when everything above is wrong.
 *
 * ## Why the snapshot is taken from the frozen destination version
 *
 * `INV-28`: *"A later edit to a beneficiary's display name must not change a
 * historical receipt."* The read below joins `payout_destination_versions` by
 * the id frozen at authorization, never `payout_destinations.current_version_id`
 * — which is the same discipline `INV-16` and `INV-44` impose on the payout
 * itself. A receipt that showed the current version would describe a payment
 * that never happened.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  artifactObjectKey,
  canonicalBytes,
  compositeDocument,
  contentHash,
  instructionFromCanonicalObject,
  receiptDocument,
  returnNoticeDocument,
  verifyContentHash,
  type ArtifactStore,
  type CanonicalArtifact,
  type CanonicalValue,
  type PrincipalRef,
  type ReceiptContent,
  type TenantScope,
} from '@inrsettle/domain'
import { enqueue } from '@inrsettle/jobs'
import { eventSink } from './events.js'

export interface IssuedArtifact {
  readonly artifactId: string
  readonly kind: string
  readonly contentHash: string
  readonly pdfObjectKey: string
  readonly canonicalBytes: string
}

export type ArtifactResult =
  | ({ ok: true; idempotent?: boolean } & IssuedArtifact)
  | { ok: false; reason: string; detail?: unknown }

/**
 * How a PDF is produced. Injected so the app never imports a browser.
 *
 * Async, because it is headless Chromium — and that is exactly why it is not
 * used by the issuing functions below. See `materialiseArtifactPdf`.
 */
export type ArtifactRenderer = (
  artifact: CanonicalArtifact,
  hash: string,
) => Promise<Uint8Array>

export interface ArtifactDeps {
  readonly store: ArtifactStore
  readonly render: ArtifactRenderer
}

/* ── Reading the receipt's content, all by value ────────────────────────── */

interface ReceiptSourceRow {
  settlement_id: string
  workspace_id: string
  environment: string
  external_reference: string | null
  purpose_code: string | null
  authorized_terms: unknown
  authorized_terms_hash: string | null
  created_at: Date
  authorized_at: Date | null
  ben_display_name: string
  ben_legal_name: string | null
  ben_country: string
  dv_id: string
  dv_kind: string
  dv_last4: string | null
  dv_ifsc: string | null
  dv_vpa: string | null
  dv_holder: string | null
  attempt_utr: string | null
  attempt_rail: string | null
  attempt_credited_minor: string | number | bigint | null
  attempt_credited_at: Date | null
  recon_status: string | null
}

async function readReceiptSource(tx: Db, settlementId: string): Promise<ReceiptSourceRow | null> {
  const rows = (await tx.execute(sql`
    SELECT s.id AS settlement_id, s.workspace_id, s.environment,
           s.external_reference, s.purpose_code,
           s.authorized_terms, s.authorized_terms_hash,
           s.created_at, s.authorized_at,
           b.display_name AS ben_display_name, b.legal_name AS ben_legal_name,
           b.country AS ben_country,
           dv.id AS dv_id, dv.kind AS dv_kind,
           dv.account_number_last4 AS dv_last4, dv.ifsc AS dv_ifsc, dv.vpa AS dv_vpa,
           dv.account_holder_name AS dv_holder,
           pa.utr AS attempt_utr, pa.rail AS attempt_rail,
           pa.credited_minor AS attempt_credited_minor, pa.credited_at AS attempt_credited_at,
           r.status AS recon_status
    FROM settlements s
    JOIN beneficiaries b ON b.id = s.beneficiary_id
    -- The version frozen at authorization, never the destination's current one.
    JOIN payout_destination_versions dv ON dv.id = s.destination_version_id
    LEFT JOIN payout_attempts pa  ON pa.id = s.payout_attempt_id
    LEFT JOIN reconciliations r   ON r.settlement_id = s.id
    WHERE s.id = ${settlementId}`)) as unknown as ReceiptSourceRow[]
  return rows[0] ?? null
}

/* ── Issuing an artifact ────────────────────────────────────────────────── */

/**
 * Persist the artifact **record**. The PDF is rendered afterwards.
 *
 * This function runs inside the caller's transaction — `issueReceipt` is `T20`'s
 * companion and has to — so everything it does is pure and fast: build the
 * canonical document, hash it, insert a row carrying a derived object key.
 *
 * **Chromium is deliberately not here.** Launching a browser inside a
 * transaction would hold the settlement's row lock across an external process
 * that can hang, which is the mistake `INV-36(b)` names for provider calls and
 * that Stage 5 took a type-level refusal to prevent. The same reasoning applies
 * to a print job, so the rendering happens after commit, in
 * `materialiseArtifactPdf`.
 *
 * Ordering: the row first, the object second. If the process dies between them,
 * the row exists and its key is unwritten — which is recoverable, because
 * `putIfAbsent` on a free key succeeds and the materialiser is idempotent. The
 * opposite order is not recoverable in the same way: an object with no row is an
 * orphan nothing points at, and the unique index on the object key would then
 * refuse the row that should have owned it.
 */
async function persistArtifact(
  tx: Db,
  scope: TenantScope,
  input: {
    artifactId: string
    artifact: CanonicalArtifact
    settlementId: string
    returnId?: string
    receiptId?: string
    sourceContentHash?: string
  },
): Promise<ArtifactResult> {
  const hash = contentHash(input.artifact)
  const bytes = canonicalBytes(input.artifact)
  const key = artifactObjectKey(input.artifact.kind, input.artifactId)

  await tx.insert(schema.financialArtifacts).values({
    id: input.artifactId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    kind: input.artifact.kind,
    settlementId: input.settlementId,
    returnId: input.returnId ?? null,
    receiptId: input.receiptId ?? null,
    sourceContentHash: input.sourceContentHash ?? null,
    canonicalBytes: bytes,
    contentHash: hash,
    pdfObjectKey: key,
  })

  // The frozen `receipt.generate` job, enqueued by the transaction that created
  // the record. A job cannot exist without its artifact, and a rolled-back
  // issuance leaves no job behind — which is the whole reason `enqueue` takes a
  // transaction and never a pool.
  await enqueueReceiptGeneration(tx, scope, { artifactId: input.artifactId })

  return {
    ok: true,
    artifactId: input.artifactId,
    kind: input.artifact.kind,
    contentHash: hash,
    pdfObjectKey: key,
    canonicalBytes: bytes,
  }
}

/**
 * Issue the settlement receipt — the `T20` companion.
 *
 * Idempotent on the settlement, because a retried finality job must not cut a
 * second receipt. The unique partial index is the real guarantee; this read
 * turns a constraint violation into an answer.
 */
export async function issueReceipt(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<ArtifactResult> {
  const existing = await readArtifact(tx, { settlementId: input.settlementId, kind: 'settlement_receipt' })
  if (existing) {
    return {
      ok: true,
      idempotent: true,
      artifactId: existing.id,
      kind: existing.kind,
      contentHash: existing.content_hash,
      pdfObjectKey: existing.pdf_object_key,
      canonicalBytes: existing.canonical_bytes,
    }
  }

  const row = await readReceiptSource(tx, input.settlementId)
  if (!row) return { ok: false, reason: 'settlement_not_found' }
  if (row.authorized_terms_hash === null) return { ok: false, reason: 'settlement_not_authorized' }

  const instruction = instructionFromCanonicalObject(row.authorized_terms)
  if (instruction === null) return { ok: false, reason: 'authorized_terms_unreadable' }
  if (row.attempt_utr === null) return { ok: false, reason: 'no_credited_payout' }
  if (row.authorized_at === null) return { ok: false, reason: 'settlement_not_authorized' }
  if (row.attempt_credited_at === null) return { ok: false, reason: 'no_credit_timestamp' }

  const receiptId = newId('settlementReceipt')
  const terms = instruction.terms
  const content: ReceiptContent = {
    receiptId,
    settlementId: row.settlement_id,
    settlementIdDisplay: row.settlement_id,
    workspaceId: row.workspace_id,
    environment: row.environment,
    beneficiarySnapshot: {
      displayName: row.ben_display_name,
      legalName: row.ben_legal_name,
      country: row.ben_country,
      destinationKind: row.dv_kind,
      // Last four only. The full number is encrypted at rest and never leaves
      // through an API response, an event, an audit record or a log — and a
      // receipt is all four at once.
      accountNumberLast4: row.dv_last4,
      ifsc: row.dv_ifsc,
      vpa: row.dv_vpa,
      accountHolderName: row.dv_holder,
      destinationVersionId: row.dv_id,
    },
    recipientAmount: instruction.recipientAmount,
    deliveredAmount:
      row.attempt_credited_minor === null
        ? null
        : { currency: instruction.recipientAmount.currency, minorUnits: BigInt(row.attempt_credited_minor) },
    fundingAmount: terms.fundingAmount,
    fxRate: `${terms.fxRate.pair} ${terms.fxRate.rateScaled}e-${terms.fxRate.scale}`,
    feeComponents: terms.feeComponents.map((f) => ({ kind: f.code, amount: f.amount })),
    roundingResidual: {
      currency: terms.roundingResidual.currency,
      // The residual is an exact decimal string at a scale; the artifact's money
      // shape is minor units. Rendering it as its own scaled integer keeps the
      // figure exact rather than rounding it into a different unit.
      minorUnits: BigInt(terms.roundingResidual.amount.replace('.', '')),
    },
    purpose: row.purpose_code ?? instruction.purposeCode,
    externalReference: row.external_reference,
    payoutReference: row.attempt_utr,
    rail: row.attempt_rail ?? 'unknown',
    reconciliationResult: row.recon_status ?? 'unknown',
    finalStatus: 'SETTLED',
    authorizedTermsHash: row.authorized_terms_hash,
    createdAt: new Date(row.created_at).toISOString(),
    authorizedAt: new Date(row.authorized_at).toISOString(),
    creditedAt: new Date(row.attempt_credited_at).toISOString(),
    // The settlement's own `settled_at` is written by the same transition that
    // consumes this receipt, so it is not readable yet. The receipt records the
    // instant it was cut, which is that same instant.
    settledAt: new Date().toISOString(),
  }

  const result = await persistArtifact(tx, scope, {
    artifactId: receiptId,
    artifact: receiptDocument(content),
    settlementId: row.settlement_id,
  })
  if (!result.ok) return result

  await eventSink(tx).audit(scope, {
    actor: input.actor,
    action: 'receipt.issued',
    subjectType: 'settlement',
    subjectId: row.settlement_id,
    after: { receipt_id: receiptId, content_hash: result.contentHash, object_key: result.pdfObjectKey },
  })
  return result
}

/**
 * Issue a return notice — a **separate** artifact, `DOMAIN.md § 6.9`.
 *
 * > *"A settlement return produces a separate artifact, not an addition to the
 * > receipt."*
 *
 * Nothing here touches the receipt. It is read to obtain its hash, which the
 * notice carries so the pair is provably about one specific version of one
 * specific receipt — and reading it is the only interaction the two have.
 */
export async function issueReturnNotice(
  tx: Db,
  scope: TenantScope,
  input: {
    returnId: string
    settlementId: string
    actor: PrincipalRef
    amountMinor: bigint
    currency: string
    reasonCode: string
    reasonMessage: string
    returnStatusAtIssue: string
    providerReturnReference: string
  },
): Promise<ArtifactResult> {
  const existing = await readArtifact(tx, { returnId: input.returnId, kind: 'return_notice' })
  if (existing) {
    return {
      ok: true,
      idempotent: true,
      artifactId: existing.id,
      kind: existing.kind,
      contentHash: existing.content_hash,
      pdfObjectKey: existing.pdf_object_key,
      canonicalBytes: existing.canonical_bytes,
    }
  }

  const receipt = await readArtifact(tx, {
    settlementId: input.settlementId,
    kind: 'settlement_receipt',
  })
  if (!receipt) return { ok: false, reason: 'receipt_not_found' }

  const noticeId = newId('returnNotice')
  const artifact = returnNoticeDocument(
    {
      noticeId,
      returnId: input.returnId,
      settlementId: input.settlementId,
      receiptId: receipt.id,
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      amount: { currency: input.currency, minorUnits: input.amountMinor },
      reasonCode: input.reasonCode,
      reasonMessage: input.reasonMessage,
      returnStatusAtIssue: input.returnStatusAtIssue,
      providerReturnReference: input.providerReturnReference,
      createdAt: new Date().toISOString(),
    },
    receipt.content_hash,
  )

  const result = await persistArtifact(tx, scope, {
    artifactId: noticeId,
    artifact,
    settlementId: input.settlementId,
    returnId: input.returnId,
    receiptId: receipt.id,
    sourceContentHash: receipt.content_hash,
  })
  if (!result.ok) return result

  await eventSink(tx).audit(scope, {
    actor: input.actor,
    action: 'return_notice.issued',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    after: {
      notice_id: noticeId,
      return_id: input.returnId,
      content_hash: result.contentHash,
      receipt_content_hash: receipt.content_hash,
    },
  })
  return result
}

/**
 * Render the optional composite — a **third** artifact.
 *
 * > *"It replaces neither source, and the receipt's hash and PDF are unaffected
 * > by its existence."*
 *
 * Which is checkable: the receipt row is read and never written, and the
 * composite embeds both sources' hashes so it can be verified against them.
 * A caller that asks for the composite twice gets two artifacts with the same
 * hash and different ids — the id is minted per export, the content is not, so
 * two exports of an unchanged settlement are provably the same document.
 */
export async function exportComposite(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<ArtifactResult> {
  const artifacts = await listArtifacts(tx, input.settlementId)
  const receipt = artifacts.find((a) => a.kind === 'settlement_receipt')
  if (!receipt) return { ok: false, reason: 'receipt_not_found' }
  const notices = artifacts.filter((a) => a.kind === 'return_notice')

  const compositeId = newId('receiptComposite')
  const artifact = compositeDocument({
    compositeId,
    settlementId: input.settlementId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    // Fixed rather than `now()`: two exports of an unchanged settlement must
    // produce the same bytes, and a timestamp in the content would make every
    // export a different document that says the same thing.
    createdAt: 'composed',
    receipt: {
      document: JSON.parse(receipt.canonical_bytes) as Record<string, CanonicalValue>,
      contentHash: receipt.content_hash,
    },
    notices: notices.map((n) => ({
      document: JSON.parse(n.canonical_bytes) as Record<string, CanonicalValue>,
      contentHash: n.content_hash,
    })),
  })

  const result = await persistArtifact(tx, scope, {
    artifactId: compositeId,
    artifact,
    settlementId: input.settlementId,
    receiptId: receipt.id,
    sourceContentHash: receipt.content_hash,
  })
  if (!result.ok) return result

  await eventSink(tx).audit(scope, {
    actor: input.actor,
    action: 'receipt_composite.exported',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    after: {
      composite_id: compositeId,
      content_hash: result.contentHash,
      sources: [receipt.content_hash, ...notices.map((n) => n.content_hash)],
    },
  })
  return result
}

/* ── Reading ────────────────────────────────────────────────────────────── */

export interface ArtifactRow {
  id: string
  kind: string
  settlement_id: string
  return_id: string | null
  receipt_id: string | null
  source_content_hash: string | null
  canonical_bytes: string
  content_hash: string
  pdf_object_key: string
  created_at: Date
}

const ARTIFACT_COLUMNS = sql`
  id, kind, settlement_id, return_id, receipt_id, source_content_hash,
  canonical_bytes, content_hash, pdf_object_key, created_at`

export async function readArtifact(
  tx: Db,
  by: { settlementId?: string; returnId?: string; kind: string },
): Promise<ArtifactRow | null> {
  const rows = (await tx.execute(sql`
    SELECT ${ARTIFACT_COLUMNS} FROM financial_artifacts
    WHERE kind = ${by.kind}
      ${by.settlementId === undefined ? sql`` : sql`AND settlement_id = ${by.settlementId}`}
      ${by.returnId === undefined ? sql`` : sql`AND return_id = ${by.returnId}`}
    ORDER BY created_at LIMIT 1`)) as unknown as ArtifactRow[]
  return rows[0] ?? null
}

export async function listArtifacts(tx: Db, settlementId: string): Promise<ArtifactRow[]> {
  return (await tx.execute(sql`
    SELECT ${ARTIFACT_COLUMNS} FROM financial_artifacts
    WHERE settlement_id = ${settlementId} ORDER BY kind, created_at, id`)) as unknown as ArtifactRow[]
}

/**
 * Re-derive a stored artifact's hash from its stored bytes.
 *
 * The point of a `content_hash` is not that it exists; it is that somebody can
 * check it. An artifact store nobody ever verifies is one whose corruption is
 * discovered by a customer holding a PDF that no longer matches the API.
 */
export function artifactVerifies(row: ArtifactRow): boolean {
  return verifyContentHash(
    {
      kind: row.kind as CanonicalArtifact['kind'],
      document: JSON.parse(row.canonical_bytes) as Record<string, CanonicalValue>,
    },
    row.content_hash,
  )
}

/* ── `receipt.generate` — the worker's job ─────────────────────────────── */

export const RECEIPT_GENERATE_JOB = 'receipt.generate'

/**
 * The job key for one artifact's PDF.
 *
 * Derived from the artifact id, so an enqueue that arrives twice — because the
 * issuing transaction ran twice, or because a read re-enqueued a job the worker
 * had not reached yet — collapses to one pending job rather than two browsers.
 */
export const receiptGenerateJobKey = (artifactId: string): string =>
  `${RECEIPT_GENERATE_JOB}:${artifactId}`

/**
 * Ask for an artifact's PDF, transactionally.
 *
 * Called inside the transaction that created the record, so the job cannot exist
 * without the artifact and a rolled-back issuance leaves no job behind. That is
 * the property `packages/jobs` exists to provide, and it is why `enqueue` takes
 * a transaction and never a pool.
 */
export async function enqueueReceiptGeneration(
  tx: Db,
  scope: TenantScope,
  input: { artifactId: string },
): Promise<void> {
  await enqueue(
    tx,
    RECEIPT_GENERATE_JOB,
    { artifactId: input.artifactId, workspaceId: scope.workspaceId, environment: scope.environment },
    { jobKey: receiptGenerateJobKey(input.artifactId) },
  )
}

export type GenerateResult =
  | { ok: true; artifactId: string; pdfObjectKey: string; rendered: boolean }
  | { ok: false; reason: string; detail?: unknown }

/**
 * The `receipt.generate` handler — `ARCHITECTURE.md § 7`, `§ 9`, `INV-48`.
 *
 * **This is the only place a PDF is rendered.** `T20` persists the receipt
 * record and enqueues; the transaction commits; the worker prints. The record
 * has to be inside `T20` because its companion set promises `receipt.available`
 * and an event announcing an artifact that does not exist is worse than no
 * event — but the *printing* must not be, because launching headless Chromium
 * while holding the settlement's row lock is the mistake `INV-36(b)` names for
 * provider calls.
 *
 * Takes the connection **pool**, not a transaction, so it cannot be called from
 * inside one. The same type-level refusal `submitDispatchedPayout` uses.
 *
 * **Idempotent, three times over**, because `§ 7` requires it — *"Every job is
 * idempotent … and is safe to run twice"*:
 *
 * 1. the store is checked before the browser starts, so a retry does not print
 *    bytes it is about to discard;
 * 2. `putIfAbsent` is what actually decides, so two workers racing still write
 *    once and the first wins;
 * 3. the record it renders is immutable, so a retry a week later prints the same
 *    document — different bytes, same content, same hash.
 *
 * It asserts its pre-state and aborts rather than forcing anything: an artifact
 * whose stored bytes no longer hash to its stored hash is refused, not printed.
 */
export async function runReceiptGenerate(
  db: Db,
  scope: TenantScope,
  deps: ArtifactDeps,
  input: { artifactId: string },
): Promise<GenerateResult> {
  const rows = await withTenant(db, scope, (tx) =>
    tx.execute(sql`
      SELECT ${ARTIFACT_COLUMNS} FROM financial_artifacts WHERE id = ${input.artifactId}`),
  )
  const row = (rows as unknown as ArtifactRow[])[0]
  if (!row) return { ok: false, reason: 'artifact_not_found' }

  const existing = await deps.store.get(row.pdf_object_key)
  if (existing) {
    return { ok: true, artifactId: row.id, pdfObjectKey: row.pdf_object_key, rendered: false }
  }

  const artifact: CanonicalArtifact = {
    kind: row.kind as CanonicalArtifact['kind'],
    document: JSON.parse(row.canonical_bytes) as Record<string, CanonicalValue>,
  }
  // Re-derived from the stored bytes rather than taken from the column, so a
  // PDF can never be printed carrying a hash that does not describe it. This is
  // the "assert the expected pre-state and abort" § 7 asks of a job.
  if (!verifyContentHash(artifact, row.content_hash)) {
    return {
      ok: false,
      reason: 'artifact_bytes_do_not_match_hash',
      detail: { artifactId: row.id, storedHash: row.content_hash },
    }
  }

  const put = await deps.store.putIfAbsent({
    key: row.pdf_object_key,
    bytes: await deps.render(artifact, row.content_hash),
    contentType: 'application/pdf',
  })
  return { ok: true, artifactId: row.id, pdfObjectKey: row.pdf_object_key, rendered: put.ok }
}

/* ── Reading ────────────────────────────────────────────────────────────── */

export type PdfUrlResult =
  | { ok: true; url: string }
  /**
   * The record exists and its PDF has not been printed yet. `requeued` says a
   * `receipt.generate` job was placed, so the answer will change on its own.
   */
  | { ok: false; reason: 'pdf_not_generated_yet'; requeued: boolean }
  | { ok: false; reason: string; detail?: unknown }

/**
 * The short-lived presigned URL `API_CONTRACT.md § 7.6` links to.
 *
 * **It does not render.** A customer opening a receipt whose PDF has not been
 * generated must not become the process that launches a browser: that puts an
 * unbounded external process on a request path, and it makes a customer waiting
 * the slowest possible way to discover a broken renderer.
 *
 * What it does instead is re-enqueue, which is the self-healing half without the
 * hazard. A crash between the record's commit and the worker reaching it leaves
 * a receipt with no printed form; the first read notices, asks for one, and says
 * plainly that it is not ready. The job key collapses a flurry of reads into one
 * pending job rather than one per reader.
 */
export async function artifactPdfUrl(
  db: Db,
  scope: TenantScope,
  deps: { store: ArtifactStore },
  input: { artifactId: string; ttlSeconds?: number },
): Promise<PdfUrlResult> {
  const rows = await withTenant(db, scope, (tx) =>
    tx.execute(sql`
      SELECT ${ARTIFACT_COLUMNS} FROM financial_artifacts WHERE id = ${input.artifactId}`),
  )
  const row = (rows as unknown as ArtifactRow[])[0]
  if (!row) return { ok: false, reason: 'artifact_not_found' }

  const existing = await deps.store.get(row.pdf_object_key)
  if (existing) {
    return { ok: true, url: await deps.store.presignedUrl(row.pdf_object_key, input.ttlSeconds ?? 300) }
  }

  let requeued = true
  try {
    await withTenant(db, scope, (tx) => enqueueReceiptGeneration(tx, scope, { artifactId: row.id }))
  } catch {
    // A queue that will not take the job must not take the read down with it.
    // The honest answer to the customer is the same either way: not yet.
    requeued = false
  }
  return { ok: false, reason: 'pdf_not_generated_yet', requeued }
}

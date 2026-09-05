/**
 * `GET /v1/settlements/{id}/receipt/composite` — `API_CONTRACT.md § 7.6`.
 *
 * > a **third** artifact rendering the receipt and its notices together, with its
 * > own `content_hash`. It replaces neither source, and the receipt's hash and
 * > PDF are unaffected by its existence.
 *
 * A `GET` that can create something is unusual and is right here: the composite
 * is derived entirely from artifacts that already exist and are already
 * immutable, so asking for it twice produces the same document with the same
 * hash — and `exportComposite` is write-once like every other artifact, so the
 * second call returns the first one rather than making a second.
 *
 * The `pdf_url` is null until the worker has printed it. `receipt.generate` owns
 * that (`ARCHITECTURE.md § 9`), and this read may not launch a browser: putting
 * an unbounded external process on a request path would mean the slowest way to
 * discover a broken renderer is a customer waiting for one.
 */
import { notFound } from '@inrsettle/domain'
import { exportComposite, listArtifacts } from '@inrsettle/app-services'
import type { Handler } from '../pipeline.js'

export const compositeReceiptHandler: Handler = async (ctx) => {
  const settlementId = ctx.params['id']!
  const artifacts = await listArtifacts(ctx.tx, settlementId)
  if (!artifacts.some((a) => a.kind === 'settlement_receipt')) {
    throw notFound('receipt for this settlement — a composite is built from one that exists')
  }

  const result = await exportComposite(ctx.tx, ctx.scope, {
    settlementId,
    actor: ctx.key.principal,
  })
  if (!result.ok) throw notFound('composite receipt')

  return {
    status: 200,
    body: {
      id: result.artifactId,
      object: 'receipt_composite',
      settlement_id: settlementId,
      content_hash: result.contentHash,
      document: JSON.parse(result.canonicalBytes),
      pdf_url: null,
      // True on every call after the first. The composite is derived from
      // immutable sources, so a second export is the first one.
      idempotent: result.idempotent === true,
    },
  }
}

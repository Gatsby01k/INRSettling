/**
 * Batch endpoints — `API_CONTRACT.md § 8`.
 *
 * > `POST /v1/batches` — JSON rows or a CSV upload reference
 *
 * The JSON path is `createBatchFromRows` and the CSV path is `importBatchCsv`;
 * both go through the *same* validator, because the rows are rendered to CSV and
 * put through the parser rather than validated a second way. Two validators that
 * are supposed to agree eventually do not.
 *
 * ## The one place idempotency works differently
 *
 * Every other endpoint commits its claim, its work and its stored response in
 * one transaction. A batch cannot: `INV-30` says an invalid row must not roll
 * back a valid one, so `importBatchCsv` takes the pool and gives each row its
 * own transaction. There is nothing to wrap.
 *
 * So the claim rides with the **container** — the transaction that decides
 * whether this import happens at all — and the response is written when the
 * import finishes. A replay while the import is still running is `409
 * idempotency_in_progress` with the batch id in the `detail`, so the caller can
 * read the batch and see exactly which rows have landed. That is the honest
 * answer, and it is more useful than a status code that says only "wait".
 */
import { sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { ApiError, notFound } from '@inrsettle/domain'
import {
  createBatchFromRows, importBatchCsv, listBatchRows, readBatch,
} from '@inrsettle/app-services'
import { newId } from '@inrsettle/ids'
import { FINGERPRINT_VERSION, requestFingerprint } from '@inrsettle/app-services'
import type { Handler } from '../pipeline.js'
import { batchJson } from '@inrsettle/app-services'
import { requireBody, requireString, stringField } from './body.js'

export const createBatchHandler: Handler = async (ctx) => {
  const body = requireBody(ctx)
  const name = requireString(body, 'name')
  const csv = stringField(body, 'csv')
  const rows = body['rows']

  if (csv === undefined && rows === undefined) {
    throw new ApiError({
      type: 'invalid_request_error', code: 'missing_parameter',
      message: 'A batch needs either rows or a CSV.',
      detail: 'Send "rows" as an array of settlement instructions, or "csv" as the file contents.',
      param: 'rows',
    })
  }

  const idempotencyKey = ctx.request.headers?.['idempotency-key']

  // The claim goes in with the container. `withIdempotencyClaim` cannot wrap
  // this call — it takes a transaction and the import takes the pool — so the
  // claim is written through the hook the import opens into its own container
  // transaction, and the pipeline's claim is skipped for this route.
  const withinContainerTransaction = idempotencyKey === undefined
    ? undefined
    : async (tx: Db, batchId: string): Promise<void> => {
        await tx.execute(sql`
          INSERT INTO idempotency_claims
            (id, workspace_id, environment, endpoint, idempotency_key,
             request_fingerprint, fingerprint_version, request_id, subject_id)
          VALUES (${newId('idempotencyClaim')}, ${ctx.scope.workspaceId},
                  ${ctx.scope.environment}::environment,
                  ${`POST ${ctx.request.path}`}, ${idempotencyKey},
                  ${requestFingerprint({
                    method: 'POST', path: ctx.request.path, apiVersion: ctx.apiVersion,
                    idempotencyKey, body: ctx.body as never, requestId: ctx.requestId,
                  })}, ${FINGERPRINT_VERSION}, ${ctx.requestId}, ${batchId})`)
      }

  const result = csv !== undefined
    ? await importBatchCsv(ctx.db, ctx.scope, {
        name, csv, actor: ctx.key.principal, ruleSet: ctx.deps.ruleSet,
        ...(withinContainerTransaction === undefined ? {} : { withinContainerTransaction }),
      })
    : await createBatchFromRows(ctx.db, ctx.scope, {
        name,
        rows: rows as never,
        actor: ctx.key.principal,
        ruleSet: ctx.deps.ruleSet,
        ...(withinContainerTransaction === undefined ? {} : { withinContainerTransaction }),
      })

  if (!result.ok) {
    if ('fileErrors' in result) {
      // Not a generic "invalid file". Every error names the column, the problem
      // and the fix, because the person reading this has a spreadsheet open.
      throw new ApiError({
        type: 'invalid_request_error', code: 'invalid_body',
        message: 'That file could not be read as a batch.',
        detail: result.fileErrors
          .map((e) => `${e.column}: ${e.problem} ${e.fix}`).join(' '),
        param: 'csv',
      })
    }
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_body',
      message: 'That batch could not be created.',
      detail: `The import refused: ${result.reason}.`,
    })
  }

  return {
    status: result.idempotent === true ? 200 : 201,
    body: batchJson(result.batch, ctx.numberFormat),
    subjectId: result.batch.id,
    ...(result.idempotent === true ? { headers: { 'Idempotency-Replayed': 'true' } } : {}),
  }
}

export const getBatchHandler: Handler = async (ctx) => {
  const batch = await readBatch(ctx.tx, ctx.params['id']!)
  if (!batch) throw notFound('batch')
  return { status: 200, body: batchJson(batch, ctx.numberFormat) }
}

/**
 * `GET /v1/batches/{id}/settlements` — *"The independent rows."*
 *
 * Independent is the word the contract chose, and it is `INV-30` again: this
 * returns the rows with their own outcomes and their own errors, including the
 * ones that never became settlements, because a batch that reported only its
 * successes would be hiding exactly what the customer needs to fix.
 */
export const batchSettlementsHandler: Handler = async (ctx) => {
  const batch = await readBatch(ctx.tx, ctx.params['id']!)
  if (!batch) throw notFound('batch')
  const rows = await listBatchRows(ctx.tx, batch.id)
  return {
    status: 200,
    body: {
      object: 'list',
      data: rows.map((r) => ({
        object: 'batch_row',
        line_number: r.lineNumber,
        outcome: r.outcome.toLowerCase(),
        settlement_id: r.settlementId,
        errors: r.errors.map((e) => ({
          column: e.column, problem: e.problem, fix: e.fix,
        })),
      })),
      has_more: false,
      next_cursor: null,
    },
  }
}

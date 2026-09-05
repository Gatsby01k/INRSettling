/**
 * Beneficiary endpoints — `API_CONTRACT.md § 7.1`, `§ 8`.
 *
 * `PRODUCT.md § 11`: a beneficiary is *"a first-class, reusable domain object.
 * Verify once, settle many times."* So creation starts verification (`§ 8`),
 * disable is soft and reversible, and nothing here deletes anything — a
 * settlement is bound to a destination *version*, and history money was sent
 * against cannot be removed out from under it.
 *
 * Nothing in this file can return a full account number. The service layer never
 * hands one out; the serializer only knows about the last four digits.
 */
import { desc, eq, lt, and, sql, type SQL } from 'drizzle-orm'
import { schema } from '@inrsettle/db'
import { money, type CurrencyCode } from '@inrsettle/money'
import { ApiError, notFound } from '@inrsettle/domain'
import {
  BeneficiaryError, createBeneficiary, enqueueBeneficiaryVerify, getBeneficiary,
  openVerification,
} from '@inrsettle/app-services'
import type { Handler, HandlerContext } from '../pipeline.js'
import { encryptOnlyCipher } from '../deps.js'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, listEnvelope } from '../http.js'
import { beneficiaryJson } from '@inrsettle/app-services'
import { objectField, requireBody, requireString, stringField } from './body.js'

/**
 * `§ 7.1`'s `settlement_summary`. Derived on read rather than maintained, for
 * the reason the batch aggregates are: a counter written independently of what
 * it counts eventually disagrees with it.
 */
async function summaryFor(ctx: HandlerContext, beneficiaryId: string) {
  const rows = (await ctx.tx.execute(sql`
    SELECT count(*)::int AS n,
           COALESCE(sum(recipient_amount_minor), 0)::text AS total,
           max(settled_at) AS last_settled_at
      FROM settlements
     WHERE beneficiary_id = ${beneficiaryId} AND status = 'SETTLED'`)) as unknown as
    { n: number; total: string; last_settled_at: Date | null }[]
  const row = rows[0]!
  return {
    count: row.n,
    totalSettled: money('INR' as CurrencyCode, BigInt(row.total)),
    lastSettledAt: row.last_settled_at,
  }
}

async function serialize(ctx: HandlerContext, id: string): Promise<Record<string, unknown>> {
  const view = await getBeneficiary(ctx.tx, ctx.scope, id)
  if (!view) throw notFound('beneficiary')
  return beneficiaryJson(
    view, await summaryFor(ctx, id), ctx.scope.environment, ctx.numberFormat,
  )
}

/** The domain's refusals, in the envelope, keeping their own words. */
function beneficiaryRefusal(e: BeneficiaryError): ApiError {
  if (e.code === 'beneficiary_not_found' || e.code === 'destination_not_found') {
    return notFound('beneficiary')
  }
  return new ApiError({
    type: 'invalid_request_error',
    code: 'invalid_parameter',
    message: e.message,
    detail: e.problems && e.problems.length > 0
      ? e.problems.join(' ')
      : 'Check the beneficiary details against the reference.',
  })
}

export const createBeneficiaryHandler: Handler = async (ctx) => {
  const body = requireBody(ctx)
  const destinationBody = body['destination'] === undefined
    ? undefined
    : objectField(body, 'destination')

  try {
    const created = await createBeneficiary(
      ctx.tx, ctx.scope,
      // Write-only. `encryptOnlyCipher` throws on decrypt, so this process
      // cannot read back what it just stored (SECURITY.md § 8).
      {
        cipher: encryptOnlyCipher(ctx.deps.destinationEncryptor),
        fingerprinter: ctx.deps.destinationFingerprinter,
      },
      {
        identity: {
          displayName: requireString(body, 'display_name'),
          legalName: stringField(body, 'legal_name'),
          type: (stringField(body, 'type') ?? 'individual') as 'individual' | 'business',
          // India is the only corridor V1 serves; the field exists so a client
          // that sends it is not surprised, and any other value is refused.
          country: 'IN',
          taxId: stringField(body, 'tax_id'),
        },
        ...(destinationBody === undefined ? {} : {
          destination: {
            kind: (stringField(destinationBody, 'kind') ?? 'bank_account') as 'bank_account' | 'vpa',
            accountNumber: stringField(destinationBody, 'account_number'),
            ifsc: stringField(destinationBody, 'ifsc'),
            accountType: stringField(destinationBody, 'account_type'),
            accountHolderName: stringField(destinationBody, 'account_holder_name'),
            vpa: stringField(destinationBody, 'vpa'),
          } as never,
        }),
        actor: ctx.key.principal,
      },
    )
    // § 8: "Creates and starts verification." Starting it means recording the
    // request and enqueueing `beneficiary.verify` — the API cannot run it, and
    // that is SECURITY.md § 8 rather than a shortcut: verifying an account means
    // handing the provider a plaintext account number, and only `worker` holds
    // the capability to produce one. Both happen in this transaction, so a
    // rolled-back creation leaves neither a verification nor a job.
    const destination = created.destinations[0]
    if (destination?.currentVersion) {
      await startVerification(ctx, destination.currentVersion.id)
    }

    return { status: 201, body: await serialize(ctx, created.id), subjectId: created.id }
  } catch (e) {
    if (e instanceof BeneficiaryError) throw beneficiaryRefusal(e)
    throw e
  }
}

export const getBeneficiaryHandler: Handler = async (ctx) => ({
  status: 200,
  body: await serialize(ctx, ctx.params['id']!),
})

export const listBeneficiariesHandler: Handler = async (ctx) => {
  const limit = parseLimit(ctx.query['limit'])
  const filters: SQL[] = []
  const after = ctx.query['starting_after']
  if (after !== undefined) {
    const [anchor] = await ctx.tx.select({ createdAt: schema.beneficiaries.createdAt })
      .from(schema.beneficiaries).where(eq(schema.beneficiaries.id, after)).limit(1)
    if (!anchor) throw notFound('beneficiary named by starting_after')
    filters.push(lt(schema.beneficiaries.createdAt, anchor.createdAt))
  }

  const rows = await ctx.tx.select({ id: schema.beneficiaries.id })
    .from(schema.beneficiaries)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(schema.beneficiaries.createdAt))
    .limit(limit + 1)

  const serialized = await Promise.all(rows.map((r) => serialize(ctx, r.id)))
  return { status: 200, body: listEnvelope(serialized, limit, (row) => String(row['id'])) }
}

/**
 * Record the request and schedule the work, in one transaction.
 *
 * `SECURITY.md § 8`: *"it records intent that `worker` executes."* This process
 * cannot verify anything — `encryptOnlyCipher` throws on `decrypt`, so it cannot
 * produce the plaintext account number a provider needs — so it writes the
 * `verifying` row and enqueues `beneficiary.verify` (`D-19`, closed in
 * `decisions/0014`).
 *
 * A refusal that is not a refusal: `already_in_flight` and `already_verified`
 * both mean there is nothing to schedule, which is the desired end state. Only a
 * genuinely unusable destination is worth telling the caller about.
 */
async function startVerification(
  ctx: HandlerContext, destinationVersionId: string,
): Promise<'started' | 'already_settled'> {
  const opened = await openVerification(ctx.tx, ctx.scope, {
    destinationVersionId,
    actor: ctx.key.principal,
    method: ctx.deps.verificationMethod,
    providerId: ctx.deps.verificationProviderId,
  })
  if (!opened.ok) {
    if (opened.reason === 'already_verified' || opened.reason === 'already_in_flight') {
      return 'already_settled'
    }
    throw new ApiError({
      type: 'conflict_error',
      code: 'invalid_transition',
      message: 'Verification cannot start for this beneficiary right now.',
      detail: `The destination refused: ${opened.reason}.`,
    })
  }
  await enqueueBeneficiaryVerify(ctx.tx, ctx.scope, { verificationId: opened.verificationId })
  return 'started'
}

/**
 * `POST /v1/beneficiaries/{id}/verify` — *"Re-run verification."*
 *
 * `202 Accepted`: the request is recorded and the work is queued. What comes
 * back is the beneficiary with its verification status as it currently stands,
 * which is the truthful answer to "what happened" — the provider has not been
 * called yet, and the caller learns the outcome from `beneficiary.verified` or
 * `beneficiary.verification_failed`.
 */
export const verifyBeneficiaryHandler: Handler = async (ctx) => {
  const id = ctx.params['id']!
  const view = await getBeneficiary(ctx.tx, ctx.scope, id)
  if (!view) throw notFound('beneficiary')
  const destination = view.destinations.find((d) => d.id === view.defaultDestinationId)
    ?? view.destinations[0]
  if (!destination?.currentVersion) {
    throw new ApiError({
      type: 'conflict_error',
      code: 'invalid_transition',
      message: 'This beneficiary has no payout destination to verify.',
      detail: 'Add bank details to the beneficiary first; verification confirms those details.',
    })
  }

  await startVerification(ctx, destination.currentVersion.id)

  return { status: 202, body: await serialize(ctx, id), subjectId: id }
}

/**
 * `POST /v1/beneficiaries/{id}/disable` — *"Soft, reversible; never deletes
 * history."*
 */
export const disableBeneficiaryHandler: Handler = async (ctx) => {
  const id = ctx.params['id']!
  const view = await getBeneficiary(ctx.tx, ctx.scope, id)
  if (!view) throw notFound('beneficiary')

  await ctx.tx.update(schema.beneficiaries)
    .set({ disabledAt: new Date(), status: 'disabled' })
    .where(eq(schema.beneficiaries.id, id))

  return { status: 200, body: await serialize(ctx, id), subjectId: id }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return LIST_DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > LIST_MAX_LIMIT) {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: `limit must be a whole number between 1 and ${LIST_MAX_LIMIT}.`,
      detail: `It defaults to ${LIST_DEFAULT_LIMIT} if you omit it.`,
      param: 'limit',
    })
  }
  return n
}

/**
 * The authorized commitment — `DOMAIN.md § 6.5.1`, `INV-16`.
 *
 * Authorization freezes two things, and both are bound **by value**, not by
 * reference to something that can move underneath them:
 *
 *   the **destination** — `destination_version_id`, the exact version that
 *   passed `INV-11`; every downstream use reads that version and never
 *   `destination.current_version_id`;
 *
 *   the **economics** — a by-value snapshot taken from the consumed quote.
 *
 * Quotes are already immutable (`INV-13`), so `quote_id` alone would pin the
 * terms. The snapshot exists anyway for two reasons the frozen document states:
 * it makes the commitment checkable without a join into another aggregate, and
 * `authorized_terms_hash` gives the finality evaluator and the receipt one
 * value to compare, so drift between what was authorized and what was executed
 * is detectable mechanically rather than by reading two records side by side.
 */
import { createHash } from 'node:crypto'
import type { CurrencyCode, ExactAmount, FeeComponent, Money } from '@inrsettle/money'

export type QuoteDirection = 'RECIPIENT_FIRST' | 'SOURCE_FIRST'

/** The economic snapshot. Every field is a value; nothing here is a pointer. */
export interface AuthorizedTerms {
  readonly quoteId: string
  readonly direction: QuoteDirection
  readonly recipientAmount: Money
  readonly fundingAmount: Money
  readonly fxRate: {
    readonly pair: string
    /** Integer at scale 10, exactly as stored. Never a float. */
    readonly rateScaled: string
    readonly scale: number
    readonly quotedAt: string
  }
  readonly feeComponents: readonly FeeComponent[]
  readonly roundingResidual: ExactAmount
  readonly quotedAt: string
  readonly expiresAt: string
}

/**
 * The complete frozen instruction: economics plus the payout commitment.
 *
 * The hash covers *this*, not just the economics, because "what does this
 * settlement mean" includes who is being paid and into which exact account
 * version. A hash over the money alone would happily match after someone
 * repointed the settlement at a different beneficiary.
 */
export interface AuthorizedInstruction {
  readonly beneficiaryId: string
  readonly destinationId: string
  readonly destinationVersionId: string
  readonly recipientAmount: Money
  readonly purposeCode: string
  readonly fundingCurrency: CurrencyCode
  readonly terms: AuthorizedTerms
}

/**
 * Canonical serialisation.
 *
 * Field order is fixed here rather than inherited from object key order, and
 * every number is rendered as a decimal string. Both matter: a hash that
 * depends on JSON key order or on float formatting is a hash that changes when
 * nothing did, and a hash that changes for no reason is one people learn to
 * ignore.
 */
/**
 * The canonical form as a plain object.
 *
 * This is what gets **stored** in `authorized_terms`, so the column holds
 * exactly the preimage of `authorized_terms_hash`: an auditor can recompute the
 * hash from the row alone, with no knowledge of how the object was assembled.
 * Storing the in-memory shape instead would put `bigint` money in a JSON column
 * and make the hash unverifiable from the database.
 */
export function canonicalInstructionObject(instruction: AuthorizedInstruction): Record<string, unknown> {
  const t = instruction.terms
  return {
    v: 1,
    beneficiary_id: instruction.beneficiaryId,
    destination_id: instruction.destinationId,
    destination_version_id: instruction.destinationVersionId,
    recipient_amount: moneyJson(instruction.recipientAmount),
    purpose_code: instruction.purposeCode,
    funding_currency: instruction.fundingCurrency,
    terms: {
      quote_id: t.quoteId,
      direction: t.direction,
      recipient_amount: moneyJson(t.recipientAmount),
      funding_amount: moneyJson(t.fundingAmount),
      fx_rate: {
        pair: t.fxRate.pair,
        rate_scaled: t.fxRate.rateScaled,
        scale: t.fxRate.scale,
        quoted_at: t.fxRate.quotedAt,
      },
      // Sorted by code so the hash does not depend on the order fees were
      // assembled in.
      fee_components: [...t.feeComponents]
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .map((f) => ({ code: f.code, label: f.label, amount: moneyJson(f.amount) })),
      rounding_residual: {
        currency: t.roundingResidual.currency,
        amount: t.roundingResidual.amount,
        scale: t.roundingResidual.scale,
      },
      quoted_at: t.quotedAt,
      expires_at: t.expiresAt,
    },
  }
}

export function canonicalInstruction(instruction: AuthorizedInstruction): string {
  return JSON.stringify(canonicalInstructionObject(instruction))
}

function moneyJson(m: Money): { currency: string; minor_units: string } {
  // INV-04: minor units cross a boundary as a string, never as a number.
  return { currency: m.currency, minor_units: m.minorUnits.toString() }
}

export function authorizedTermsHash(instruction: AuthorizedInstruction): string {
  return createHash('sha256').update(canonicalInstruction(instruction), 'utf8').digest('hex')
}

/**
 * Does a settlement still mean what it meant when it was authorized?
 *
 * Used by the immutability test and, later, by the finality evaluator. It
 * recomputes rather than trusting the stored hash, so a row whose fields were
 * changed *and* whose hash was updated to match still fails against the hash
 * recorded at authorization.
 */
export function instructionMatchesHash(
  instruction: AuthorizedInstruction,
  expectedHash: string,
): boolean {
  return authorizedTermsHash(instruction) === expectedHash
}

/**
 * Build the snapshot from a consumed quote.
 *
 * Takes the quote's values by copy. Nothing here reads the beneficiary or the
 * destination at execution time; the caller supplies the exact ids that passed
 * `INV-11` and they are frozen with the rest.
 */
export function freezeInstruction(args: {
  beneficiaryId: string
  destinationId: string
  destinationVersionId: string
  purposeCode: string
  quote: {
    id: string
    direction: QuoteDirection
    recipientAmount: Money
    fundingAmount: Money
    fxRate: { pair: string; rateScaled: bigint; scale: number; quotedAt: Date }
    feeComponents: readonly FeeComponent[]
    roundingResidual: ExactAmount
    createdAt: Date
    expiresAt: Date
  }
}): { instruction: AuthorizedInstruction; hash: string } {
  const q = args.quote
  const instruction: AuthorizedInstruction = {
    beneficiaryId: args.beneficiaryId,
    destinationId: args.destinationId,
    destinationVersionId: args.destinationVersionId,
    recipientAmount: q.recipientAmount,
    purposeCode: args.purposeCode,
    fundingCurrency: q.fundingAmount.currency,
    terms: {
      quoteId: q.id,
      direction: q.direction,
      recipientAmount: q.recipientAmount,
      fundingAmount: q.fundingAmount,
      fxRate: {
        pair: q.fxRate.pair,
        rateScaled: q.fxRate.rateScaled.toString(),
        scale: q.fxRate.scale,
        quotedAt: q.fxRate.quotedAt.toISOString(),
      },
      feeComponents: q.feeComponents,
      roundingResidual: q.roundingResidual,
      quotedAt: q.createdAt.toISOString(),
      expiresAt: q.expiresAt.toISOString(),
    },
  }
  return { instruction, hash: authorizedTermsHash(instruction) }
}

/** The fields `INV-16` freezes. Named here so the database trigger and the test agree. */
export const FROZEN_INSTRUCTION_COLUMNS = [
  'beneficiary_id',
  'destination_id',
  'destination_version_id',
  'recipient_amount_minor',
  'recipient_amount_currency',
  'purpose_code',
  'funding_currency',
  'quote_id',
  'authorized_terms',
  'authorized_terms_hash',
] as const

/**
 * Rebuild the typed instruction from the stored canonical object.
 *
 * The finality evaluator's `X1` needs the *preimage* re-hashed, not the stored
 * hash trusted — a row whose fields were edited *and* whose hash was updated to
 * match must still fail. That means reading `authorized_terms` back and putting
 * it through the same serialiser it came out of.
 *
 * Why a parser rather than `JSON.stringify` on what the database returned:
 * `canonicalInstruction` fixes field order by construction, and `jsonb`
 * deliberately does not preserve it — Postgres normalises key order internally.
 * Re-stringifying the row would produce different bytes for identical content,
 * so every settlement would fail `X1` for a reason that has nothing to do with
 * drift. Reconstructing the typed value and re-serialising is the only reading
 * that compares content with content.
 *
 * Returns `null` on anything malformed rather than throwing, and `null` fails
 * `X1` closed: a preimage we cannot parse is one we cannot verify, and an
 * unverifiable commitment is not a satisfied condition.
 */
export function instructionFromCanonicalObject(stored: unknown): AuthorizedInstruction | null {
  try {
    type Obj = Record<string, unknown>
    const obj = (v: unknown): Obj => v as Obj
    const o = obj(stored)
    const readMoney = (v: unknown): Money => ({
      currency: String(obj(v)['currency']) as CurrencyCode,
      minorUnits: BigInt(String(obj(v)['minor_units'])),
    })
    const t = obj(o['terms'])
    const fx = obj(t['fx_rate'])
    const residual = obj(t['rounding_residual'])

    const instruction: AuthorizedInstruction = {
      beneficiaryId: String(o['beneficiary_id']),
      destinationId: String(o['destination_id']),
      destinationVersionId: String(o['destination_version_id']),
      recipientAmount: readMoney(o['recipient_amount']),
      purposeCode: String(o['purpose_code']),
      fundingCurrency: String(o['funding_currency']) as CurrencyCode,
      terms: {
        quoteId: String(t['quote_id']),
        direction: String(t['direction']) as QuoteDirection,
        recipientAmount: readMoney(t['recipient_amount']),
        fundingAmount: readMoney(t['funding_amount']),
        fxRate: {
          pair: String(fx['pair']),
          rateScaled: String(fx['rate_scaled']),
          scale: Number(fx['scale']),
          quotedAt: String(fx['quoted_at']),
        },
        feeComponents: (t['fee_components'] as unknown[]).map((raw) => {
          const f = obj(raw)
          return { code: String(f['code']), label: String(f['label']), amount: readMoney(f['amount']) }
        }) as unknown as readonly FeeComponent[],
        roundingResidual: {
          currency: String(residual['currency']) as CurrencyCode,
          amount: String(residual['amount']),
          scale: Number(residual['scale']),
        } as unknown as ExactAmount,
        quotedAt: String(t['quoted_at']),
        expiresAt: String(t['expires_at']),
      },
    }
    return instruction
  } catch {
    return null
  }
}

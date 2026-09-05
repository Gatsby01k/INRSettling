/**
 * Prefixed, opaque, non-sequential external identifiers — DOMAIN.md § 4 (INV-09).
 * Database primary keys are never exposed.
 *
 * Each stage registers the prefixes for the aggregates it introduces. The
 * financial prefixes (stl_, qt_, …) arrive with Stage 3.
 */
import { randomBytes } from 'node:crypto'

export const ID_PREFIXES = {
  workspace: 'ws',
  user: 'usr',
  membership: 'mem',
  apiKey: 'key',
  session: 'ses',
  event: 'evt',
  audit: 'aud',
  outbox: 'obx',
  // Stage 2 — beneficiaries.
  beneficiary: 'ben',
  payoutDestination: 'dst',
  destinationVersion: 'dvr',
  destinationVerification: 'dvf',
  providerEvent: 'pev',
  preflightRun: 'pfr',
  // Stage 3 — quotes and settlements.
  quote: 'qt',
  settlement: 'stl',
  payoutAttempt: 'pay',
  settlementException: 'exc',
  // Stage 4 — liquidity. `rpy` matches the identifier shape DOMAIN.md § 6.6
  // writes out for a repayment; the rest follow the same three-letter form.
  liquidityFacility: 'fac',
  liquidityReservation: 'rsv',
  drawdown: 'drw',
  repayment: 'rpy',
  ledgerEntry: 'led',
  ledgerTransfer: 'ltr',
  // Stage 6 — reconciliation, finality and the artifacts. `ret_` and `rnt_` are
  // written out in DOMAIN.md § 6.9/§ 6.10 and `rcp_` in API_CONTRACT.md § 7.6,
  // so those three are quoted from the baseline rather than chosen here.
  reconciliation: 'rcn',
  settlementReturn: 'ret',
  returnObservation: 'rob',
  settlementReceipt: 'rcp',
  returnNotice: 'rnt',
  receiptComposite: 'cmp',
  finalityEvaluation: 'fev',
  // Stage 7 — batches.
  batch: 'bat',
  batchRow: 'brw',
  // Stage 8 — the public API. `req_` is written out in API_CONTRACT.md § 5's
  // error envelope, so that one is quoted from the baseline rather than chosen.
  apiRequest: 'req',
  idempotencyClaim: 'idc',
  webhookEndpoint: 'whe',
  webhookDelivery: 'whd',
  webhookAttempt: 'wha',
  // Stage 9 — Internal Operations. `opr_` and `ops_` read as what they are on
  // sight, which matters most in an audit row somebody is reading under
  // pressure: the difference between a customer principal and one of ours
  // should be visible without a lookup.
  internalOperator: 'opr',
  internalSession: 'ops',
  operatorAction: 'oac',
} as const

export type IdKind = keyof typeof ID_PREFIXES
export type PrefixedId<K extends IdKind = IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`

// Base58 — no 0/O/I/l, so an id read aloud or copied by hand stays unambiguous.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BODY_LENGTH = 12

function body(): string {
  // Rejection sampling keeps the distribution uniform across the alphabet.
  const out: string[] = []
  const limit = 256 - (256 % ALPHABET.length)
  while (out.length < BODY_LENGTH) {
    for (const byte of randomBytes(BODY_LENGTH)) {
      if (byte >= limit) continue
      out.push(ALPHABET[byte % ALPHABET.length]!)
      if (out.length === BODY_LENGTH) break
    }
  }
  return out.join('')
}

export function newId<K extends IdKind>(kind: K): PrefixedId<K> {
  return `${ID_PREFIXES[kind]}_${body()}` as PrefixedId<K>
}

export function isId<K extends IdKind>(kind: K, value: string): value is PrefixedId<K> {
  return new RegExp(`^${ID_PREFIXES[kind]}_[${ALPHABET}]{${BODY_LENGTH}}$`).test(value)
}

/**
 * The browser-safe surface of the domain.
 *
 * Everything here is pure TypeScript with no Node built-ins, so a customer
 * surface can import the *real* domain rules rather than restating them. That
 * matters most for `projectCustomerStatus`: `INV-18` requires exactly one
 * definition of the customer projection, and a UI that cannot import it would
 * be forced to keep a second copy — which is how a settlement ends up showing
 * one state in a list and another on its detail screen.
 *
 * What is deliberately **not** exported here is anything that hashes or reads
 * files: `authorized-terms.ts` and `rule-set-io.ts` use `node:crypto`, and both
 * are server concerns. Freezing an instruction and checksumming a rule set
 * happen where the transaction happens; a browser has no business doing either,
 * and the bundler failing on them was the honest signal that the barrel was
 * hiding a layering question rather than answering it.
 *
 * Server code keeps importing `@inrsettle/domain`, which is a superset of this.
 */

/* Money-adjacent identity and capability rules the UI legitimately needs. */
export * from './identity/capabilities.js'
export * from './identity/principal.js'

/* Beneficiary shapes and masking — no crypto: the keyed fingerprint is a port. */
export * from './beneficiaries/beneficiary.js'
export * from './beneficiaries/destination.js'
export * from './beneficiaries/name-match.js'

/* Preflight requirements. The rule *engine* is pure; only rule-set IO is not. */
export * from './preflight/requirement.js'
export * from './preflight/rules.js'

/* The settlement machine, its projection and its exception taxonomy. */
export * from './settlements/status.js'
export * from './settlements/transitions.js'
export * from './settlements/projection.js'
export * from './settlements/resolution.js'
export * from './settlements/exceptions.js'
export * from './settlements/payout-attempt.js'

/* Liquidity: the facility, its ledger, and the reservation/drawdown/repayment
   machines. Pure arithmetic and frozen tables; no database, no provider. */
export * from './liquidity/facility.js'
export * from './liquidity/reservation.js'
export * from './liquidity/drawdown.js'
export * from './liquidity/repayment.js'

/* Quote lifecycle and pricing. Pure arithmetic over exact types. */
export * from './quotes/quote.js'
export * from './quotes/pricing.js'

/* Stage 6. The reconciliation and return machines are frozen tables and pure
   arithmetic, and the customer surface needs both to render a return's own
   state without restating the rules. The canonical artifact document comes too:
   INV-29 requires the UI to render *the* serialisation rather than a second
   description of it. `hash.ts` deliberately does not — it uses `node:crypto`,
   and a browser that could mint the hash of a financial record is a browser
   that could mint the hash of one it had edited. */
export * from './reconciliation/reconciliation.js'
export * from './reconciliation/finality.js'
export * from './reconciliation/settlement-return.js'
export * from './receipts/artifact.js'
export * from './receipts/template.js'

/* Stage 7. The batch aggregate and its row-outcome mapping, so the batch screen
   summarises rows the same way the API does — one mapping, not two. */
export * from './batches/batch.js'
export * from './batches/csv.js'

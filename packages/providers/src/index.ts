/**
 * Provider adapters.
 *
 * Everything here implements a port declared in `@inrsettle/domain`. The domain
 * never imports this package; the application wires an adapter in at the edge,
 * which is what keeps `D-11` answerable later without a domain rewrite.
 */
export * from './verification/sandbox.js'
export * from './verification/registry.js'
export * from './liquidity/mock.js'
export * from './payouts/scenarios.js'
export * from './payouts/mock-india.js'

/* Stage 6 — write-once artifact storage and deterministic PDF rendering. */
export * from './artifacts/filesystem-store.js'
export * from './artifacts/pdf.js'

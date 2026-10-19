# Partner sandbox runtime and durable execution

Status: Implemented for sandbox evaluation. Does not close Stage 11 or Stage 12.

The public `/v1` contract remains framework-neutral. A Node HTTP adapter serves
it alongside a connected evaluation workspace. Graphile Worker runs verification,
preflight, execution, PDF generation and webhook delivery. Authorization and
post-authorization cancellation enqueue `settlement.execute` transactionally.

The application services continue to own every financial transition. The worker
orchestrates those services, retains cancellation checkpoints and queries
counterparty outcomes after uncertainty. The sandbox counterparty persists its
responses under a separate role/schema, so process memory does not decide whether
a payout already exists. This guarantees no properties of a future live provider:
its lookup/deduplication contract must be validated independently.

The runtime requires explicit sandbox mode and refuses live keys/jobs. Existing
landing publication remains separate. The local combined process is convenient
for evaluation; it does not establish production KMS or process secret isolation.

Supporting fixes: resumable quote attachment after preflight, an initial-row
locking gap in API rate limiting, raw SQL timestamp serialization for receipts,
and atomic publication of complete filesystem PDF artifacts. These preserve the
frozen product model and existing invariants.

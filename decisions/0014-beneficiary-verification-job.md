# 0014 — `beneficiary.verify` is a job class (`D-19` closed)

**Status:** closed. Amends `ARCHITECTURE.md § 7` (Revision 4).
**Stage:** 8, from the archive review.

## The contradiction

Three frozen documents each said something reasonable, and together they left an
endpoint with nowhere to go:

- `API_CONTRACT.md § 8` publishes `POST /v1/beneficiaries/{id}/verify` —
  *"Re-run verification"* — and `§ 8` also has `POST /v1/beneficiaries`, which
  *"Creates and starts verification"*.
- Performing a verification means handing the provider a plaintext account
  number, which means decrypting a `PayoutDestinationVersion`.
- `SECURITY.md § 8` grants destination decryption to `worker` and to no other
  process, in a table that names `api` explicitly: **no**.

So the API can only record intent. But `ARCHITECTURE.md § 7`'s job-class list —
`preflight.run`, `quote.expire`, `liquidity.reserve`, `liquidity.drawdown`,
`payout.dispatch`, `payout.poll`, `reconcile.run`, `finality.evaluate`,
`receipt.generate`, `webhook.deliver`, `batch.ingest` — named nothing for the
worker side. Stage 8 first shipped the endpoint returning `202` with the request
audited and nothing enqueued, and carried the gap as `D-19` rather than
inventing a class.

## Decision

**`beneficiary.verify` is a job class.** `ARCHITECTURE.md § 7` is amended to
name it.

This is a correction to an incomplete list, not a new capability. Two of the
three documents were already right: the endpoint should exist, and only `worker`
should decrypt. The list was written before Stage 2 built verification, and
Stage 2 built it synchronously, so nothing needed the name until an API existed
that could not do the work itself.

## What the split fixes beyond the missing name

`ARCHITECTURE.md § 5`: *"Adapters are called from jobs, never from inside a
database transaction […]. No adapter method may be invoked while a row lock is
held."*

Stage 2's `requestVerification` called `provider.verify(…)` between an `INSERT`
and an `UPDATE` in one transaction. A penny drop that took four seconds held a
transaction open for four seconds; a provider that hung held it until the
statement timeout, with an open snapshot and a row lock the whole time. It was a
sandbox provider that returned instantly, so nothing showed it.

The path is now three pieces, and the middle one holds nothing:

1. **`openVerification(tx, …)`** — guards, the `verifying` row, the audit entry,
   and the enqueue. All in the caller's transaction, so a verification cannot
   exist without the job that will run it, and a rolled-back beneficiary
   creation leaves neither.
2. **`runBeneficiaryVerifyJob(db, …)`** — reads what the provider needs in a
   short transaction, **calls the provider outside every transaction**, then
   applies the outcome in a second short transaction.
3. The existing `applyOutcome`, unchanged, which is what the provider callback
   path already used.

The row is still written *before* the call, which is the property Stage 2 was
protecting: a timeout leaves a verification our database knows about rather than
a penny drop nobody recorded.

## What this does not change

- `INV-11` and the trust rules are untouched. An unsigned or unverified callback
  still cannot mark a destination `VERIFIED`; the job applies an outcome through
  the same `applyOutcome` the callback path uses, under the same versioned
  name-match policy.
- `D-11` stays open. The abstraction is what moved, not the policy.
- No new capability, scope or role. The job runs as `worker`, which already held
  destination decryption.

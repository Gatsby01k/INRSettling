# Stage 8 — Public API and developer experience

Scope per `IMPLEMENTATION_PLAN.md § 3`: *"`/v1` exactly as specified in
`API_CONTRACT.md`, webhook endpoints and signing, request and event logs,
replay, API keys UI, and the reference with copyable examples in curl,
TypeScript and Python."*

Not built here: Internal Operations (Stage 9). **No real provider is
integrated.**

---

## 1. The chicken and the egg, and what it cost to answer honestly

A bearer key's **workspace and environment are properties of the key**. But
`api_keys` is RLS-forced on `workspace_id = current_workspace_id()`, and the
runtime role is `NOBYPASSRLS`. The scope cannot be set until the key is read,
and the key cannot be read until the scope is set.

Authentication is therefore two steps, and the second is what makes the first
safe:

1. **`resolve_api_key`** — a `SECURITY DEFINER` function on a connection with no
   scope set, returning a workspace and an environment and nothing else. It
   refuses to run inside a tenant-scoped transaction, so it cannot be used to
   overwrite a scope somebody else established.
2. **`confirmKeyInScope`** — inside the now-scoped transaction, one ordinary
   RLS-filtered `SELECT` against `api_keys`. It settles two things at once:
   revocation is immediate, and *the scope the API set really is the key's own*
   — because under the tenant policy the row is visible only if it matches.

Without step 2 the whole design would rest on a claim RLS never checks. With it,
the definer call is advisory, which is what a hole of this kind should always be
reduced to.

The role that owns those functions, `inrsettle_resolver`, holds **column-level
`SELECT` on three tables and nothing else in the database**. Not `BYPASSRLS`:
that attribute is bounded only by whatever grants the role happens to hold, so
one `GRANT SELECT ON ALL TABLES` later it would read settlements across every
tenant. A permissive policy on one table cannot widen that way, and it is
visible in `pg_policies`, where the isolation gate already looks. The gate now
asserts the ownership, the pinned `search_path`, the ACL, the absence of login
and bypass, the exact reachable table set, and that `inrsettle_app` is not a
member of the role — because RLS role matching follows inheritance, so that one
grant would hand the application the resolver's policies with no `SET ROLE`.

### The `404`, not `403`

`SECURITY.md § 3.3`: *"a wrong-environment key must not confirm that an object
exists."* This falls out of the structure rather than out of handler discipline:
the scope comes from the key, RLS filters on workspace **and** environment, and
a live settlement simply is not in the result set a sandbox key can see. There
is no branch that could get it wrong. The `detail` copy was written with the same
care — it explains environments without ever implying the id was real.

---

## 2. Idempotency: one transaction, no lease

> `§ 4` — same key and same body replays; same key and a different body is
> `409 idempotency_key_reuse`; a concurrent arrival is `409
> idempotency_in_progress`.

**The claim, the operation and the stored response commit together.** Everything
else follows:

- No lease and no reclaim path, so there is no way for a reclaim to run a
  payment twice.
- A process that dies mid-operation rolls the claim back with the work: no "in
  progress" row describing something that never happened.
- A network failure *after* commit but before the response reaches the client is
  the case this exists for, and it is exact — the retry finds the committed claim
  and replays the committed bytes.

Mutual exclusion is the unique index rather than a lock we take. A second
request holding the same key blocks on the index slot until the first
transaction ends, then either sees its committed row or takes the slot. That
behaviour was **verified against Postgres 16 before the design was committed**,
including that `lock_timeout` covers the duplicate-key wait (it is a `ShareLock`
on the transactionid through the regular lock manager, SQLSTATE `55P03`), and
that a `READ COMMITTED` statement-level snapshot lets the loser see the winner's
row.

Four things that look like details and are not:

- **`endpoint` is the concrete request target, never the route template.**
  `/authorize` and `/cancel` are sent with no body, so on those endpoints the
  body fingerprint is a constant. Under a template, one key reused across two
  settlements would replay the first's response — a `200` saying it worked — and
  the second would silently never be authorized. A payment lost, reported as a
  success. The claim also stores `subject_id` and asserts it on replay, so the
  rule holds even if `endpoint` were one day built wrongly.
- **`lock_timeout` is set around the claim insert alone**, then reset. Left set
  for the transaction it would also cover the settlement row lock `INV-36` uses
  to order cancellation against dispatch — turning a deliberate wait into a
  failure, and reporting it as an idempotency conflict.
- **The lookup never filters on `expires_at`.** An expired row still holds the
  index slot, so a liveness filter produces "cannot insert, cannot find" — which
  on a payments endpoint is a re-execution. A claim is authoritative until its
  row is gone.
- **The response is stored as `text`, not `jsonb`.** `jsonb` cannot represent
  `U+0000` and raises `22P05`; inside this transaction that would take the
  settlement down with the bookkeeping, deterministically, so every retry would
  fail identically. And a replay promises *the original response*: `jsonb`
  reorders keys and collapses duplicates, so it would return a different
  document.

`SECURITY.md § 5` says *"key plus workspace plus environment plus a request-body
fingerprint is unique"*, and its next clause says a reused key with a different
body is a hard error. Only the second is implementable: keying on the
fingerprint would make a different body a different row, and a different row is
a second settlement. The clause is the requirement; the sentence is loose. The
migration says so where the constraint is defined, because the omission
otherwise looks like one.

---

## 3. `POST /v1/settlements` records intent

`§ 8` says this endpoint runs preflight. It does — by enqueueing it.

`ARCHITECTURE.md § 3`: *"A request never drives a settlement through more than
one transition; it records intent and enqueues."* Preflight is `T02` then `T03`
or `T04`, so doing it inline would put three transitions in one transaction. The
first cut did exactly that, and **the `INV-32` pairing trigger refused it**:
*"settlement … changed status but this transaction wrote 3 status events, not
exactly 1"*. The architecture and the database say the same thing, and the
database said it first.

So `T01` commits with a `preflight.run` job, and the customer learns the outcome
from `settlement.ready` or `settlement.action_required` — which is what those
events are for. `preflight.run` is the first name in the frozen job-class list;
Stage 8 is the first stage that needed it.

---

## 4. Webhooks

Two phases, and the split between them is the safety property.

**`drainOutbox` is a transaction and makes no network call.** It claims pending
outbox rows with `FOR UPDATE SKIP LOCKED`, works out which endpoints want each
event, writes one delivery row per `(event, endpoint)`, enqueues the job that
will attempt it, and commits.

**`runWebhookDelivery` makes the call and holds nothing.** It reads what it
needs, posts, and records the outcome in a short transaction afterwards. An
endpoint that takes thirty seconds to time out costs thirty seconds of nothing.

One delivery row per `(event, endpoint)` rather than per event, because two
endpoints fail independently — `INV-30`'s reasoning applied to delivery.

The allow-list is applied **at the last possible moment**, in the drain. An
internal event that reached the outbox stops there rather than at whoever wrote
it, because the guarantee in `§ 10.2` is about what leaves the system, not about
who remembered. It is an allow-list and not a deny-list for the same reason: a
deny-list would leak every new internal event the day it was added.

The signing secret is stored under the same envelope encryption a payout
destination uses. It is the one customer-facing secret in the system, it must be
retrievable because a customer configures their verifier with it, and a database
disclosure that yielded it would let anyone forge a `settlement.settled`.
Rotation keeps both secrets live for 24 hours and signs with both, so a customer
cuts over on their own schedule.

---

## 5. Stage 8 exit matrix

| Criterion | Status | Evidence |
|---|---|---|
| Contract tests cover every endpoint, every error type, and the idempotency semantics including the same-key-different-body conflict | ✅ | `contract.test.ts` walks the route table and asserts all 24 routes were reached; every `type` in the `§ 5` table produced; `idempotency.test.ts` covers replay, reuse, concurrency, atomicity, retention and the batch asymmetry |
| The published signature verification snippets are themselves tested | ✅ | `reference.test.ts` **executes** the three published files — TypeScript in-process, Python through `python3`, Go through `go run` — over ten cases including both sides of the tolerance |
| A `sk_test_` key addressing a live object returns `404`, not `403` | ✅ | Asserted for settlements and beneficiaries, with the same object visible to the live key so the `404` is isolation rather than a broken fixture, and the body asserted not to contain the id |
| Webhook delivery survives an endpoint down for an hour and shows every attempt in the event log | ✅ | `webhooks.test.ts`: a transport that returns `503` until the injected clock passes 3600s, then `200`; the delivery succeeds and every attempt is present with the status code and body the endpoint returned |

### Beyond the four

| Property | Evidence |
|---|---|
| No endpoint sets a status, marks a settlement paid, or adjusts an amount | The route table is walked against a forbidden-pattern regex |
| Every route has a handler and every handler has a route | Set equality between the two tables |
| The internal state machine is not the integration surface | An internal event is invisible on `/v1/events` and `404` when addressed directly, to a key holding every scope |
| The `api` process holds no destination decryption capability | `encryptOnlyCipher` throws on `decrypt` and `keyIdOf`; asserted |
| A duplicate JSON key is refused, not resolved | A hand-written strict reader; `JSON.parse` silently takes the last |
| Money survives above 2^53 | `900719925474099100` round-trips through `POST` and `GET` |
| No full account number on any endpoint | The response body asserted to contain neither the field nor a ciphertext |
| Requirements carry all four fields `§ 7.4` requires | Asserted as a property of every requirement the API returns |
| The reference cannot go stale | Generated from the route table, error catalogue and snippet files; a test fails if the committed document differs |

---

## 6. Clean CI

```
EXIT=0
Test Files  60 passed (60)
     Tests  1254 passed (1254)
```

Stage 8 added **181 tests**: 44 contract, 17 idempotency, 29 reference and
snippet execution, 18 webhook delivery, 43 domain (errors, versions, the JSON
reader, fingerprints, rate limits, signatures, the catalogue, the schedule), 19
developer surfaces, plus 11 on the extended isolation gate and the batch
corrections.

Also green from a clean checkout.

---

## 7. Defects and deviations

1. **A superuser-owned `SECURITY DEFINER` function, shipped in Stage 2.**
   `CREATE FUNCTION` assigns ownership to whoever applies the migration, and
   migrations are applied as the owner — so `resolve_verification_scope` has
   been running with superuser rights, executable by the application, since
   Stage 2. Today's body is a fixed parameterised `SELECT` and cannot be turned
   into arbitrary execution; the next edit to it would not have had that
   property. Corrected here (`ALTER FUNCTION … OWNER TO inrsettle_resolver`)
   because Stage 8 adds the second such function and the pattern has to be right
   before there are two of them.

2. **`current_environment()` was unusable from a hardened `search_path`.** Every
   RLS policy calls it, and its body cast with a bare `::environment`. A
   `LANGUAGE sql` function is re-parsed when it is inlined into the query that
   triggered the policy — under the *caller's* `search_path` — so the first
   definer function pinned to `pg_catalog, pg_temp` failed with `type
   "environment" does not exist`, reported from whatever ran last rather than
   from the policy. Both context functions now schema-qualify and pin their own
   `search_path`, which fixes the class rather than the instance.

3. **A nested `withTenant` could rebind the enclosing transaction's tenant.**
   `SET LOCAL` is transaction-scoped and Drizzle implements a nested transaction
   as a `SAVEPOINT`; a subtransaction that commits keeps its changes. So a
   nested scoped transaction with a different scope changed the *outer*
   transaction's tenant for everything after it, with `WITH CHECK` accepting
   every write. Nothing in the tree did this, and Stage 8 is the first stage
   where a scope is chosen from data rather than from an already-fixed session —
   which is the shape in which the mistake gets made. `set_tenant_scope` now
   refuses to rebind, in the database, where it cannot be forgotten. Verified
   against Postgres before the guard was written.

4. **A Stage 7 idempotency key could silently lose a batch.**
   `importBatchCsv` let an explicit key *replace* the content fingerprint, so
   the same key with a completely different file returned the first batch as a
   success — a set of payments never created, reported as created. The content
   address is now purely content, and the API-level key goes through
   `idempotency_claims`. Two mechanisms, two different questions. The
   `SELECT`-then-`INSERT` race in the same function, which turned a concurrent
   duplicate import into a `500`, is caught and mapped to the replay path.

5. **512 orphaned test databases stopped the cluster mid-run.** The harness
   dropped its database at *creation*, which makes a re-run clean only for the
   same process id; every suite in every previous run left one behind. By Stage
   8 that was five gigabytes and twenty-two files failing with `ECONNREFUSED`.
   The harness now drops the database on `close()`.

6. **`enqueue` could not carry a `runAt`.** No caller had used one until webhook
   retries; a `Date` bound as a bare parameter is not something the driver can
   serialise, and the failure surfaced as a Node type error a long way from the
   enqueue. It crosses as an ISO string now.

7. **`POST /v1/beneficiaries/{id}/verify` records intent and does not verify.**
   Verifying a bank account means handing the provider the plaintext account
   number, which means decrypting a payout destination — and `SECURITY.md § 8`
   says `api` holds no destination decryption capability and no provider
   credential. The process literally cannot: its cipher throws on `decrypt`. So
   the endpoint audits the request and returns `202`. **This leaves a real gap**:
   `ARCHITECTURE.md § 7`'s frozen job-class list has no verification class for
   the worker side to be enqueued onto, and inventing one would be extending a
   frozen list. Carried below as an unresolved decision.

8. **The `api` capability boundary is enforced in software, not in keys.**
   `encryptOnlyCipher` throws on `decrypt`, so "this process cannot read a payout
   destination" is a property a test asserts. What it does not give is *key*
   separation — AES-GCM is symmetric, so a process holding the encryption key
   holds the material to decrypt with it. Closing that properly means the API
   holding only a wrapping key it cannot unwrap, which is a KMS arrangement at
   deployment (`SECURITY.md § 9`) and not something this build can assert.

9. **Rate limiting applies only after a key resolves.** `§ 11` publishes limits
   *per API key*, which by definition cannot apply to a request whose key does
   not resolve. A syntactic pre-filter rejects impossible tokens with zero
   database work, and the resolve itself is one non-transactional statement.
   Limiting unauthenticated traffic by source address belongs at the edge, in
   front of this process, and is not built here.

10. **The outbox drain needs one more scope-resolution hole.** `§ 6` says the
    outbox is drained by the worker with `SELECT … FOR UPDATE SKIP LOCKED` — but
    a `NOBYPASSRLS` worker cannot see that a workspace it was never told about
    has pending rows. `pending_outbox_scopes` returns **scope pairs and nothing
    else**: no event, no payload, no id. The drain that follows is ordinary,
    RLS-filtered application code. The alternative was putting event scope into
    a job payload, which would put the same fact in the queue with the event id
    beside it.

11. **A `500` had to be rewritten to pass our own copy gate.** The internal-error
    message opened with the apology the requirement-copy gate bans — correctly.
    Even a `500` owes the reader three things: whose fault it was, whether
    anything happened, and what to do next. It now says all three, and this note
    does not quote the phrase, because the gate scans this file too.

12. **The API version is part of the idempotency fingerprint.** Not in the
    document. A client that re-pins between a request and its retry would
    otherwise receive a body serialised under the version it just moved off;
    including it makes that a `409` instead. Every ambiguous case in the
    fingerprint is biased the same way, because a false conflict is an error the
    client can see and a false replay is a lost payment reported as a success.

13. **The retry schedule and the circuit threshold are chosen, not quoted.**
    `§ 10.3` states *about 24 hours* and *exponential backoff with jitter*; the
    thirteen intervals summing to 23h 54m, the ±20% jitter and the twenty
    consecutive failures are this stage's numbers, argued in
    `webhooks/delivery.ts` and asserted by tests rather than left implicit.

14. **The rate-limit figures are a labelled sandbox fixture.** `§ 11` says the
    limits are published in the reference; what they should be is a commercial
    and operational question about real traffic, in the same class as `D-05b`
    and `D-08b`. The shape is built, the numbers are configuration with no
    default, and the reference says they are sandbox figures.

---

## 7b. The archive review, and what it found

An independent review of the Stage 8 archive found five gaps. All five are
closed here; none of them needed a product decision, and four of them were
places where a rule the baseline states plainly had not been implemented.

15. **The customer envelope carried the event row's payload.** `§ 10.1` says
    `data.object` is *"the full settlement object"* and `§ 10.2` says the
    internal state machine is not the integration surface. The allow-list
    honoured the second and the envelope did not: `events.payload` is what a
    transition writes for its own audit purposes, so a `settlement.created`
    delivery carried `{"transition": "T01", "to": "DRAFT"}` — the internal
    machine, in the field meant to hold the public object. `public/event-object.ts`
    now resolves the event's **subject** through the same public serializers
    `/v1` uses, and `eventJson` has no payload parameter to pass by mistake. One
    resolver, used by `/v1/events` and by webhook delivery alike, because two
    implementations of "the same document" diverge on their first edit. A
    subject that no longer exists resolves to `{object, id, deleted: true}`
    rather than to a guess assembled from the payload.

16. **`beneficiary.verify` did not exist, and the provider was called inside a
    transaction.** `D-19`, above, and the `§ 5` violation it was hiding. The
    second half is the more serious one: `openVerification` and the provider
    call were in the same transaction, so an unbounded network call was made
    while a row lock was held. Now three pieces, with the call between two short
    transactions, and a test that proves it by having the fake provider take a
    `FOR UPDATE NOWAIT` on the verification row from its own connection — a
    provider called inside the loading transaction would raise `55P03`.

17. **Removing a webhook endpoint deleted its delivery history.** The FK
    cascaded. The moment a customer most needs that history is right after they
    have torn down the endpoint that was failing, so removal is now a soft
    delete: `status = 'deleted'`, the endpoint gone from `GET
    /v1/webhook_endpoints` but readable by id so a delivery view can still name
    the URL it was sent to, and every delivery and attempt retained. `DELETE` on
    both tables is revoked from `inrsettle_app` in migration `0015`, so the
    retention is a grant rather than a convention — a future caller cannot
    delete the history by writing the `DELETE` the service no longer contains.
    A removed endpoint cannot be reopened either: removal is not a circuit that
    closes, and the safe way back is a new endpoint with a new secret.

18. **`pending_outbox_scopes()` was executable by `inrsettle_app`.** It is the
    one cross-tenant read in the delivery path — it exists so a `NOBYPASSRLS`
    worker can discover that a workspace it was never told about has events
    waiting. An `api` process holding it could enumerate every workspace in the
    deployment through a function whose whole purpose is to see past RLS.
    Migration `0015` revokes it from `inrsettle_app` and grants it to
    `inrsettle_worker`; `pendingOutboxScopes` takes a worker-role pool, and the
    scoped drain that follows still runs on the application pool under ordinary
    RLS. Asserted both ways: the worker sees the scopes, the application role
    gets `permission denied`.

19. **The Developers surfaces were view-models with no screens.** Built here:
    the environment switch, API keys with the one-time reveal, webhook endpoints
    with test, rotate, re-enable and remove, the request log, the event log with
    attempts and replay, and the reference with copyable curl, TypeScript and
    Python. Presentational, like every other surface in this app, with 33
    behaviour tests and a story per state. Not the Stage 10 polish pass — no
    visual tuning beyond what the design system already gives.

---

## 8. Unresolved decisions

| # | Question | Why it cannot be settled here |
|---|---|---|
| **D-20** *(new)* | What are the Live rate limits, per bucket? | `§ 11` publishes them; the numbers are commercial. The sandbox fixture is labelled as one, and `createRateLimiter` takes a config with no default so a default cannot become the answer by accident. |

**`D-19` is closed** — `decisions/0014-beneficiary-verification-job.md`,
`ARCHITECTURE.md` Revision 4. It was raised here as a contradiction between three
frozen documents rather than as a product question, and closing it needed the
smallest amendment that removes the contradiction: `beneficiary.verify` joins the
`§ 7` job-class list. Nothing else moved. The verification orchestration is now
three pieces — `openVerification` (a short transaction), the provider call
**outside every transaction**, and a short transaction that records the answer —
which is what `ARCHITECTURE.md § 5` required all along and what the previous
shape violated by calling the adapter inside the transaction that opened the
verification.

Unchanged and still open: `D-06`, `D-11`, `D-04b`, `D-05b`, `D-08b`, `D-09b`,
`D-13`, `D-14b`, `D-15`, `D-16b`, `D-17b`, `D-18b`. `D-01`/`D-02` remain the
counsel gate and the Stage 11 blocker.

### Documentation observations, not decisions

- `SECURITY.md § 5`'s uniqueness sentence and its next clause cannot both be
  implemented; § 4 of `API_CONTRACT.md` is unambiguous and was followed. Worth
  tightening at the next revision.
- `API_CONTRACT.md § 9`'s worked flow showed `POST /v1/settlements` returning
  `status "ready"`. **Amended** — `API_CONTRACT.md` Revision 7. This was the
  sharper of the two contradictions the review found: the five-state contract
  has no `null`, and inline preflight would violate `ARCHITECTURE.md § 3`. Both
  cannot hold, and only one of them is a wire detail. § 7.3 now states that
  `status` is `null` **between creation and the end of preflight, and only
  then** — the absence of a status rather than a sixth one — that such a
  settlement is not returned by `GET /v1/settlements` so a list never contains
  an object with a missing status, and that it is readable by id so a client
  that has just created one can poll it. § 8 now says `202 Accepted`. The
  published examples in all three languages wait for a non-null status before
  authorizing, and the reference carries a section that says so.

---

## 9. What Stage 9 inherits

- A `/v1` surface whose route table declares its own scopes and idempotency
  requirements, and a contract suite that walks it.
- An idempotency mechanism that is one transaction and no lease, with the
  concurrency behaviour verified rather than assumed.
- Webhook delivery with every attempt recorded, replay, and a circuit breaker —
  and a `webhook.deliver` job that Ops will want a view onto.
- A request log and an event log with delivery history attached, which is most
  of what an Internal Operations "what did this customer do" screen needs.
- An `inrsettle_resolver` role with exactly three questions it may answer. Any
  fourth is a decision, not an addition.

# Stage 9 — Internal Operations

`PRODUCT.md § 14`, `SECURITY.md § 2`, `§ 3.1`, `§ 3.2`, `§ 6`,
`STATE_MACHINES.md` T22–T24.

---

## 1. The shape of the whole stage, in one sentence

**Internal Operations reads across tenants and writes nothing.**

`inrsettle_ops` — the explicitly named role `SECURITY.md § 2` requires — is
granted `SELECT` and nothing else, on twenty-four named tables, and no more. An
operator *action* on a settlement is a tenant-scoped write performed by the
ordinary application role inside a normal `withTenant` transaction, exactly like
a customer action.

Everything else in this stage follows from that asymmetry:

- Every RLS policy, `CHECK`, and trigger applies to an operator unchanged —
  including `INV-32`'s status/event pairing, the settled-row immutability guard,
  and the resume-integrity trigger — because the operator is using the same
  door.
- There is no second write path to audit, harden, or forget about.
- **"No ops action can set `SETTLED` or edit a settled record"** is not a rule
  the ops code has to remember. It is the database refusing, to the same role,
  for the same reason it refuses everyone else.

The privilege ops holds is therefore exactly one thing: the ability to *see* a
workspace it was not scoped to. Nothing else. A build gate
(`scripts/check-ops-boundaries.mjs`) fails the build if a future migration
grants that role a write.

### Why a permissive policy rather than `BYPASSRLS`

The same reasoning migration `0012` recorded for `inrsettle_resolver`, with more
force here because this role sees more. `BYPASSRLS` is bounded only by whatever
grants the role happens to hold, so one `GRANT ALL ON ALL TABLES` later it is
reading and writing everything. A permissive `FOR SELECT` policy cannot widen
that way: it is per-table, SELECT-only, and visible in `pg_policies`, where the
isolation gate already looks.

The failure that would undo it all — `GRANT inrsettle_ops TO inrsettle_app` —
would hand the customer-facing application every cross-tenant policy with no
`SET ROLE` required, because RLS role matching uses `has_privs_of_role`, which
follows inheritance. The isolation gate asserts the membership does not exist in
either direction, and the boundary gate rejects the statement in any migration.

---

## 2. Audit first, then read

The order is the point, and it is why every cross-tenant read declares the
workspaces it is about to touch rather than discovering them as it goes.

Read-then-audit has a window: the read succeeds, the audit write fails or the
process dies, and a cross-tenant read has happened with no record of it. That is
precisely the failure `SECURITY.md § 2` exists to prevent, so `withOperatorRead`
inverts the order — the audit is committed first, in its own transaction, and
the read only happens afterwards.

The cost is over-recording: an audit row for a read that then failed. **A record
of a read that did not happen is a much better defect than a read with no
record**, and a test asserts the record survives when the read throws.

A queue spanning many workspaces cannot know its scopes in advance, so it gets
them from a **discovery** step returning scope pairs and a count — the same shape
as `pending_outbox_scopes`, and for the same reason. Every workspace discovery
names is then audited before any of its content is read. The gap between the two
is one in which the operator knows only a list of ids they are about to be
recorded against.

### Two records, neither redundant

Each read and each write produces two rows:

| Row | Scope | Who reads it |
|---|---|---|
| `audit_log` | the workspace's own | **the customer** |
| `operator_actions` | cross-tenant | us |

The first is why `operator_actions` carries a `workspace_id` and is tenant-scoped
with an ordinary RLS policy: a customer reading their own audit trail can see
that INRSettle looked at their settlement, who did, and why. An internal access
record the customer cannot see would be a worse record.

The second answers *what has this operator been doing*, which spans tenants by
definition — answering it from the per-workspace log would mean scanning every
workspace in the deployment.

For a **write**, both rows are written inside the transaction that performed it,
so a resolution that rolls back takes its attribution with it. For a **read**,
they are committed first and separately, because a read cannot be rolled back.
The asymmetry is deliberate.

---

## 3. What ops can do to a settlement, and the fourth option that does not exist

Three resolutions — T22 `resume`, T23 `fail`, T24 `cancel` — and no others.

The obvious missing action is *"mark this one settled, I have confirmed the
credit by phone"*. `SECURITY.md § 6` forbids it for every principal, and the
reason is not squeamishness: a settlement is `SETTLED` when six finality
conditions hold, and a human who has confirmed one of them has not confirmed the
other five. So the ops action is `resolve_resume` — it puts the machine back
where it stalled and lets the evaluator decide with whatever evidence has since
arrived. If the evidence is not there, the settlement stalls again, which is the
correct outcome and a visible one.

### The resume destination is data, not a choice

T22's destination is `exception_entered_from`, recorded when the exception opened
and frozen by a database trigger while it is open. Nobody — not the service, not
the operator — chooses where a resume goes. Migration `0005` refuses a resume to
anywhere else and refuses a post-point-of-no-return exception resuming to a
pre-dispatch state (`INV-36`). **The operator decides *whether* to resume; the
machine decides *to where*.**

### `no_value_delivered` was vacuous, and is not any more

Fixing this was the one genuine defect this stage found in existing code.
`settlement.service.ts`'s `resolveException`, shipped in Stage 3, answered T23's
guard with:

```ts
no_value_delivered: settlement.pointOfNoReturnAt === null || input.resolution !== 'fail' ? true : true,
```

A ternary whose branches agree. The guard has therefore answered *yes* for every
settlement since Stage 3, including one whose payout had already been
dispatched — which is the single thing it exists to prevent. Calling a settlement
`FAILED` tells the customer no money moved, and past the point of no return we do
not know that: `PAYOUT_STATUS_UNKNOWN` is exactly that situation.

It now reads `settlement.pointOfNoReturnAt === null`, the ops path refuses
`fail` past the boundary with `value_may_have_been_delivered`, and the queue
screen disables the button with that sentence on it rather than refusing at the
click.

---

## 4. Sessions: every customer restriction, plus the network one

`SECURITY.md § 3.1`: *"Sessions are short, **bound to a device fingerprint**,
revocable from settings, and invalidated on role change. `ops` sessions are
shorter still and **additionally network-restricted**."*

*Additionally* is the word that governs the design. An ops session carries every
restriction a customer session carries and then one more — it is not a different
model with a network check bolted on.

- **30 minutes**, asserted against `SESSION_TTL_SECONDS` rather than against a
  literal, so "shorter still" survives someone changing either number.
- **MFA is `NOT NULL`** on `internal_sessions`. A session without a second
  factor is unrepresentable rather than refused by a check somebody could skip.
- **The allow-list has no default.** `establishOperatorSession` requires one and
  refuses an empty list — the same reasoning as `D-05b`'s TTL, and the accident
  a default would cause here is *every network is allowed*.
- **Containment is asked of Postgres**, not implemented by hand. `inet` has
  correct IPv4 and IPv6 semantics including the ones people get wrong;
  `::ffff:10.0.0.1` is not inside `10.0.0.0/8` as text, and a hand-rolled octet
  comparison silently accepts a malformed mask. Getting this wrong fails open.
- **Bound to a device, mandatorily.** `device_fingerprint` is `NOT NULL` with a
  non-empty `CHECK`, where `sessions.device_fingerprint` is nullable: a customer
  may be admitted without one, an operator may not, so an unbound ops session is
  unrepresentable rather than refused by a check somebody could skip. On a
  mismatch the session is **revoked**, not merely refused — the same fail-closed
  semantics `resolveSession` uses, and for the same reason: a session id
  presented from elsewhere is the signature of a stolen token, so refusing one
  request would hand the thief the rest of the half hour.
- **Checked on every request, not once at login.** Both the address and the
  device. A session established in the office and used from a laptop on a train
  is exactly what the restriction is for, and checking once would let it through
  for the next half hour.
- **Fail closed on a missing address.** `OpsRequest.ip` is required, and
  `resolveOperatorSession` takes a *required* request context rather than
  options it can do without. An optional address is one that is sometimes
  absent, and a restriction skipped when the caller forgot to pass one is a
  restriction with a hole shaped like a misconfigured proxy. An empty string —
  the one shape a type cannot refuse — is a refusal, because *we could not
  check* is not *it passed*. An absent fingerprint is treated the same way: a
  mismatch, not an exemption.
- **Which allow-list admitted the session is recorded beside the address**, so
  "was this legitimate" is answerable a year later when the ranges have changed
  twice.
- Suspending an operator revokes every open session in the same transaction.
  Suspending without revoking would leave full cross-tenant read access working
  for up to the TTL, for someone whose access was just withdrawn.

---

## 5. Roles that are not a hierarchy

`ops_read`, `ops_resolve`, `ops_liquidity`, `ops_admin` — an **entirely separate**
enum from the workspace roles, held on `internal_operator_roles`, which has no
`workspace_id` to grant one in. `SECURITY.md § 3.2`'s *"never granted inside a
customer workspace"* is structural rather than a rule somebody enforces.

`ops_admin` is deliberately **not** a superset. The person who grants access
should not thereby acquire the ability to resolve exceptions and move facility
limits, for the same reason `admin` cannot authorize a settlement. Someone who
needs both is granted both roles, visibly.

The internal capability list has no `settle`, no `force`, no `override`, no
`edit`, and no capability to read a payout destination in the clear. Their
absence is asserted by a test rather than left to be noticed, because the failure
mode is somebody adding one at 6pm with a customer on the phone and every
reviewer reading the diff as *"ops needed a way to fix a stuck settlement"*.

---

## 6. What ops can see, and what stays masked

Twenty-four tables: the ten `PRODUCT.md § 14` names, plus what makes a settlement
detail legible — the quote it was priced on, the beneficiary, the attempt, the
returns.

**Absent by decision:** `api_keys`, `sessions`, `api_requests`,
`api_rate_limits`, `idempotency_claims`, `webhook_endpoints` and their
deliveries, `users`, `memberships`, `workspace_security_policies`, `outbox`.
None is needed to resolve an exception or reconcile a payout, and an internal
surface that could read them is a much larger blast radius for one compromised
staff account.

**Two tables are granted column by column.** Ops sees a beneficiary and a payout
destination in exactly the masked form the customer sees. `SECURITY.md § 8`
grants destination decryption to `worker` alone, and while holding a ciphertext
is not holding a key, the internal surface is where the temptation to *"just add
decryption for support"* is strongest — so the column is not reachable at all.
`details_fingerprint` is excluded for its own recorded reason: it is a keyed
change-detection value and an oracle if exposed.

---

## 7. Stage 9 exit matrix

| Criterion | Status | Evidence |
|---|---|---|
| Every operator action is attributed and audited with a mandatory reason | ✅ | `validateReason` refuses absence, whitespace and too-short before the action; the `operator_actions` `CHECK` refuses it at the database independently; the pipeline refuses before the handler runs; the screen disables the confirm button until one is written. Asserted at all four layers. |
| No ops action can set `SETTLED` or edit a settled record | ✅ | `inrsettle_ops` holds no write privilege on any table (asserted by catalogue query in the isolation gate, and by a build gate over every migration); the three resolutions are the whole vocabulary and none reaches `SETTLED`; a direct `UPDATE … SET status = 'SETTLED'` on the application role is refused by the immutability trigger; the route table is walked against a forbidden-pattern regex. |
| Cross-tenant reads use the named role and are audited individually | ✅ | The named role reads two workspaces where the application role reads one; one `operator_actions` row **and** one `audit_log` row per workspace touched, committed **before** the read; the record survives a read that then throws; a read naming no workspace is refused. |
| Exception resolution resumes a settlement at `exception_entered_from` | ✅ | A settlement stalled at `LIQUIDITY_RESERVED` resumes there; one stalled at `PAYOUT_SUBMITTED` resumes there and not to the start (`INV-36`); the destination is never passed in. |

### Beyond the four

| Property | Evidence |
|---|---|
| Ops sees a payout destination masked, like the customer | The ciphertext column is not granted; a direct `SELECT` of it is `permission denied` |
| An ops session is bound to a device, and a mismatch ends it | `device_fingerprint` is `NOT NULL`; a mismatch revokes with a recorded reason; asserted at the service and at the boundary |
| A session with no request address cannot authenticate | Refused as `request_address_missing` at both the service and the boundary, with nothing read |
| Every migration applies to a cluster that has never seen this project | A static ordering gate over every migration, plus a throwaway-cluster script |
| Ops cannot read the customer's API keys or sessions | Catalogue query over fourteen forbidden tables returns empty |
| Neither runtime role inherits the other | `pg_has_role` asserted false in both directions, plus a build gate over every migration |
| `operator_actions` is append-only | `UPDATE` and `DELETE` refused by trigger, even to a superuser |
| An ops write that rolls back leaves no attribution | Asserted against a refused resolution |
| A facility limit cannot go below what is committed | Refused with the committed figure, before the `CHECK` would reject it |
| Every ops write records who and why | Build gate over `packages/app/src/ops` |
| The ops app reaches the database only through the ops services | Build gate over `apps/ops/src` |

---

## 8. Genuine deviations

1. **`no_value_delivered` was vacuous since Stage 3.** § 3 above. Found while
   implementing T23 honestly; fixed in `settlement.service.ts` as well as in the
   new ops path, because the defect was in the shared primitive.

2. **App and API tests were not typechecked.** `tsconfig.test.json` included
   `packages/**` only, so `apps/**/__tests__` had never been through `tsc`.
   Widened here, which immediately surfaced three real type errors in the Stage 8
   API contract test — a wrong import path for `SANDBOX_RATE_LIMITS`, a `never`
   that silenced a `.map`, and a missing `postgres` type dependency. All three
   fixed. The gate is the finding; the errors are what it caught on its first run.

3. **`principal_type` gained `operator`.** A schema change, not a document
   change: `SECURITY.md § 6` requires every audit record to carry *"actor type
   and id"*, and an operator recorded as `user` would make "was this the customer
   or was this us" a question answerable only by recognising the id. The enum is
   an implementation vocabulary; no frozen document enumerates it.

4. **The mandatory reason has a floor of 8 characters.** `SECURITY.md § 6` says
   mandatory and names no length. A floor long enough to be a sentence would be
   a rule people satisfy with `aaaaaaaaaaaa`; what this refuses is the empty
   string and whitespace, which is what an accidental submit produces. The real
   control is that the reason is attributed, permanent, and read by whoever
   reviews the action later.

5. **The 30-minute ops session TTL is chosen, not quoted.** `§ 3.1` fixes only
   the relationship — shorter than a customer session — so the number is this
   stage's, and the test asserts the relationship rather than the number.

6. **A facility can be suspended but not closed.** `FACILITY_SUSPENDED` is an
   exception code the machine already knows, so suspension has a defined
   consequence. Closing is a commercial act with a settlement question attached —
   what happens to a drawdown outstanding against a facility that no longer
   exists — and `D-16b` has not answered it. Not invented here.

7. **The "tight headroom" threshold is a tenth of the limit.** A display
   heuristic with no basis in the documents, so it lives in a view model and is
   labelled as a threshold. It exists so a screen can say *look at this one*
   before a settlement fails rather than after.

8. **The ops list envelope has no cursor.** Deliberately unlike
   `API_CONTRACT.md § 6`'s: an exception queue with ten thousand entries is an
   incident rather than a page, and a limit with a stated count is the more
   useful shape for a screen whose job is to say how much work is waiting.

9. **`min(timestamptz)` comes back as a string.** The driver parses columns by
   their declared type and an aggregate has none, so `discoverQueueScopes`
   coerces. Recorded because the symptom — `toISOString is not a function` —
   surfaced at the far end of a request, a long way from the query.

---

## 8b. The review fixes

Three corrections from the Stage 9 review, all accepted as stated.

10. **Device binding was missing from ops sessions.** `SECURITY.md § 3.1` binds
    every human session to a device and makes ops sessions *additionally*
    network-restricted; Stage 9 implemented the "additionally" and dropped the
    base requirement. `internal_sessions.device_fingerprint` is now `NOT NULL`
    with a non-empty `CHECK`, presented on every request as `X-Ops-Device`, and
    a mismatch **revokes** the session with `ops_session_device_mismatch` rather
    than merely refusing it — the same fail-closed semantics `resolveSession`
    already used for a customer, for the same reason.

    Migration `0017` was amended rather than superseded by an `0018`. It is part
    of the same unreviewed stage and has never been deployed, so amending it
    keeps the migration set honest about what the schema *is*; a follow-up
    `ALTER TABLE` adding a `NOT NULL` column to a table created three statements
    earlier would be archaeology rather than history.

11. **The network restriction failed open when no address was presented.**
    `OpsRequest.ip` was optional and `resolveOperatorSession` skipped the check
    when it was absent — so a deployment whose proxy did not set the header
    admitted every session from anywhere. Now: the field is required,
    `resolveOperatorSession` takes a **required** request context rather than
    options, and an empty string — the one shape a type cannot refuse — is
    `request_address_missing`. *We could not check* is not *it passed*.

12. **Migration `0017` referenced `inrsettle_ops` before creating it.** The
    policy on `operator_actions` named the role twenty lines before the
    `CREATE ROLE`. Every test passed, and this is the interesting part: roles are
    **cluster-global** while migrations are per-database, so the first test
    database to apply `0017` failed *after* the role had been created by the
    partial run, and every database created afterwards found it already there.
    The suite was green on a cluster that had been poisoned into hiding the bug.
    It would have failed exactly once — on the first deployment to a fresh
    cluster.

    Fixed by moving the role creation to the top of the file, and closed twice
    over:

    - `scripts/check-migration-order.mjs`, a **static** gate over every
      migration — for each file in filename order, a role named in a `GRANT`,
      `POLICY`, `REVOKE`, `OWNER TO` or `ALTER ROLE` must already have been
      created. Static because no amount of executing can be trusted on a cluster
      whose state is the thing being tested. Its self-test reconstructs the
      original ordering and asserts the gate rejects it.
    - `scripts/verify-fresh-cluster.sh`, the empirical half: it initialises a
      throwaway cluster, asserts it has no `inrsettle*` roles, and applies every
      migration. Run before releasing a migration that touches roles.

---

## 9. Open decisions

No new decisions. Stage 9 needed none: every question it raised was answerable
from the frozen documents, and the two places where a commercial answer would
have been required — closing a facility, and post-funding cancellation policy —
are already carried as `D-16b` and were not invented around.

Unchanged and still open: `D-01`, `D-02`, `D-04b`, `D-05b`, `D-06`, `D-08b`,
`D-09b`, `D-11`, `D-13`, `D-14b`, `D-15`, `D-16b`, `D-17b`, `D-18b`, `D-20`.
`D-01`/`D-02` remain the counsel gate and the Stage 11 blocker.

### Documentation observations, not decisions

- `SECURITY.md § 2` says cross-tenant reads are written *"to the audit log"*,
  singular. This stage writes two records — the workspace's own and the
  cross-tenant one — because the second question (*what has this operator been
  doing*) cannot be answered from the first without scanning every workspace.
  That is an addition rather than a divergence, and worth stating explicitly at
  the next revision.
- `PRODUCT.md § 14` names *"payout providers"* among the ops surfaces. Ops reads
  provider events and the mapping-table version that interpreted them; managing
  provider *configuration* has no shape yet, because there is no real provider
  to configure (`D-11`, Stage 11). `ops:provider_manage` exists as a capability
  with nothing yet behind it, which is visible rather than hidden.

---

## 10. What Stage 10 inherits

- A working ops surface with real states and real copy, deliberately outside the
  Stage 10 polish pass: `PRODUCT.md § 14` allows complexity here, and the Alex
  test is about the customer product.
- A `ReasonedConfirm` component that every destructive ops action goes through,
  so the mandatory reason has exactly one implementation.
- The `apps/**` test suites now typechecked, which is a gate Stage 10's screens
  inherit rather than a favour done for them.

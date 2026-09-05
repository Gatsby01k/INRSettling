# Counsel brief — `D-01` (data localisation) and `D-02` (regulatory posture)

Status: **Open — awaiting counsel** · Prepared 2026-09-03 · Gates Stage 4 exit

## What this document is, and is not

`IMPLEMENTATION_PLAN.md § 2.1` makes counsel engagement a **hard Stage 4 exit
criterion**, and is explicit about why it sits there rather than earlier or
later: *"a calendar booking is not a deliverable, and gating engineering on
someone else's availability is a gate that gets waived rather than met."*

This is the deliverable that makes the gate meetable: the questions, written
down, in the form counsel needs them. **It contains no legal answers and no
guesses at them.** `D-02` in the register says *"Settle with counsel; do not
infer"*, and inferring here would be worse than useless — an engineering
document that reads like a legal position is something a later reader may act
on.

Two things remain outstanding, and only the first is on the critical path for
Stage 4:

1. **Counsel engaged** — a firm or individual with Indian cross-border payments
   and data-protection experience, retained and briefed on this document.
2. **The answers** — these gate **Stage 11**, not Stage 5. Stages 5–10 are built
   against deterministic simulators and do not depend on them.

## Background counsel needs, in one page

INRSettle moves value from businesses outside India to beneficiaries inside
India. A customer funds in a non-INR currency; a payout is made in INR to an
Indian bank account or VPA over domestic rails (NEFT/RTGS/IMPS/UPI). INRSettle
intends to operate **on a licensed partner's rails** rather than as a licensed
entity itself, but that intention is precisely what `D-02` must confirm or
correct.

The system today: multi-tenant SaaS, PostgreSQL, no production deployment, no
real customer or beneficiary data, no live provider integration. Beneficiary
bank details are stored encrypted with randomized encryption and are never
exposed in API responses, events, audit records or logs. Every tenant's data is
isolated by row-level security on workspace **and** environment.

Nothing is deployed yet, which is the point of asking now: hosting region,
database location and backup topology are all still free choices, and they stop
being free the moment there is production data.

---

## `D-02` — What is INRSettle, legally, in this corridor?

The register: *"Determines KYB depth, screening obligations, retention,
reporting, and who owns the compliance programme."*

### Questions for counsel

1. On the described model — INRSettle operates software; a licensed Indian
   partner (AD bank and/or authorised payment provider) executes the INR payout
   and holds the regulatory permissions — **what is INRSettle's own regulatory
   status in India?** Specifically, does the activity require registration,
   authorisation or licensing in its own right, and under which regime?
2. Does the answer change if INRSettle:
   - holds no customer funds at any point, versus holds funds transiently;
   - is the party that has the relationship with the paying business, versus
     the partner is;
   - operates a liquidity facility with a third party to pre-fund INR payouts?
   (The third is what Stage 4 built. It is INRSettle's own arrangement with a
   liquidity provider, not a customer-facing credit product, and no customer
   funds sit in it — but counsel should confirm that characterisation rather
   than accept it.)
3. **Who owns the compliance programme** — KYB on the paying business, sanctions
   and PEP screening, transaction monitoring, and suspicious-activity reporting?
   Which of these can contractually sit with the partner, and which cannot be
   delegated regardless of contract?
4. What **KYB depth** is required on the non-Indian paying business, and by whom?
5. What **purpose-code and documentary requirements** attach to inbound
   remittances of this kind, per purpose and amount band? (This is `D-06`, open
   since Stage 2. The rule engine is built and versioned; the rules themselves
   are a fixture labelled `sandbox_fixture` and a build gate refuses to let a
   fixture claim a real regulatory code.)
6. What **records must be retained, in what form, and for how long**, and does
   any of that retention have to happen inside India?
7. What **reporting obligations** attach, to whom, and on what cadence?

### What engineering has already assumed, for counsel to confirm or correct

- That a **beneficiary verification** step (penny drop or provider lookup)
  before first payout is appropriate. `D-11` is open on the method; the port is
  built so all candidate answers fit without a rewrite.
- That **separation of duties** (creator ≠ authorizer) is a sensible control for
  live settlements, configurable per workspace and default-on for Live. This is
  an engineering judgement, not a regulatory one, and counsel may have a view.
- That a settlement's **authorized terms are immutable** and every state change
  is recorded in an append-only event and audit stream, actor-attributed.

---

## `D-01` — Where may payment data be stored?

The register: *"India applies data-localisation requirements to payment system
data. Constrains hosting region, database location, backups, possibly provider
choice. Follows from D-02."*

`D-01` genuinely follows from `D-02`: what counts as "payment system data" for
INRSettle depends on what INRSettle is. Both questions should go to counsel
together.

### Questions for counsel

1. Which of the following, on the model above, are **payment system data**
   subject to a localisation requirement, and which are not?
   - beneficiary identity and bank account details;
   - settlement instruction records (amount, currency, purpose, timestamps);
   - the payout instruction and the provider's response to it;
   - the audit and event log;
   - operational telemetry and application logs;
   - encrypted backups of any of the above.
2. Is the requirement **exclusive storage in India**, or storage in India with
   copies permitted elsewhere? If copies are permitted, under what conditions?
3. Does **processing** outside India (a support engineer in another country
   reading a record to resolve an exception) engage the requirement separately
   from storage?
4. What are the constraints on **backups and disaster recovery** — must they
   also be in-country, and does that extend to encrypted backups where the keys
   are held elsewhere?
5. Does the answer constrain **provider choice** (cloud region availability,
   payout partner, liquidity partner, document storage)?
6. Are there **data-protection obligations** (DPDP Act 2023 and any rules made
   under it) that apply independently of payment-system localisation, and do
   they change any of the above?
7. What, in practice, does a supervised entity have to be able to **demonstrate**
   about localisation, and to whom?

### The decisions waiting on this answer

Each is currently unmade rather than made provisionally:

| Waiting on `D-01` | Currently |
|---|---|
| Hosting region and cloud provider | Not chosen; nothing deployed |
| Database location and replica topology | Single logical database, location undecided |
| Backup destination and retention | Not configured |
| Encryption key custody and location | Keys are envelope-encrypted; custodian location undecided |
| Support access model | No production access path built |
| Document store location | Port defined; no adapter chosen |

## What counsel is *not* being asked

- To design the system. The architecture is frozen and reviewed.
- To choose a payout or liquidity partner.
- To answer `D-06` (purpose codes and document rules) in detail — that comes
  from the AD bank or payout partner's own rule set, and question 5 under
  `D-02` asks only what the shape of the obligation is.

## Status tracking

| Item | Status | Blocks |
|---|---|---|
| Questions written down for counsel | ✅ this document | Stage 4 exit |
| Counsel engaged and briefed | ⛔ **outstanding** | Stage 4 exit |
| `D-02` answered | ⛔ outstanding | Stage 11 |
| `D-01` answered | ⛔ outstanding | Stage 11 |

Stages 5–10 proceed against simulators regardless. Stage 11 — the first real
provider integration and the first production deployment — cannot start without
the answers, and the hosting and storage decisions in the table above should not
be made before them, because unmaking them later means migrating production
payment data.

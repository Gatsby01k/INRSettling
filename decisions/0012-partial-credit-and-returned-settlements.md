# ADR 0012 — Partial credit (D-14) and returned settlements (D-17): the mechanisms, not the economics

Status: **Split** · 2026-09-03 · Implemented in Stage 6

## Why this lives here and not in `docs/`

Stage 0 Revision 7 is frozen with a SHA-256 manifest in the README. Decisions
taken after the freeze live in `decisions/` and are folded into the register at
the next revision.

## Context

Two open decisions land on Stage 6, and both are commercial questions wearing
technical clothes. The register is careful about each:

> **`D-14`** *"Partial credit policy — top up the shortfall, or reverse the whole
> settlement? The mismatch case is real and the answer is commercial, not
> technical. `INV-26` guarantees it is never silent; it does not say what happens
> next."*

> **`D-17`** *"Commercial treatment of a returned settlement. The settlement was
> final and fees were charged; FX has since moved. Are fees refunded? Is the
> customer repaid at the original rate or the current one? Who bears the
> difference? Partial returns compound this."*

The pattern by now is established — `D-05`, `D-08`, `D-09`, `D-13`, `D-16`,
`D-18` all split the same way — and it applies cleanly to both.

---

## D-14 — partial credit

**Technical invariant: CLOSED.**

- Tolerance is **zero**, and there is no parameter to widen. `compareObservation`
  takes no tolerance argument, not even one defaulted to zero, because *"a
  configurable tolerance is a number someone eventually widens on a Friday to
  clear a queue, and the widening is invisible afterwards."*
- A non-zero delta is `MISMATCH` (`R03`), immediately escalated to
  `MANUAL_REVIEW` (`R05`, *"a mismatch is never left unattended"*), and it opens
  `RECONCILIATION_MISMATCH` on the settlement (`T21`). It never settles: `F5` and
  `F6` both refuse, and a test asserts both refusals rather than one.
- A `MATCHED` reconciliation carrying a non-zero delta is **unwritable** — a
  database `CHECK` refuses the row, and `F5` checks the status and the delta
  separately because they are separately falsifiable.
- Resolution is attributed and requires an explicit answer to *"did value move
  incorrectly"* (`R06`, `INV-27`). The service refuses to infer it. Inferring it
  would be answering `D-14` by accident, in the one place nobody would look.

**Commercial policy: EXTERNAL.**

What happens *after* the mismatch is recorded — top up the shortfall, reverse the
settlement, absorb it, bill it — is not decided and no code path assumes one. The
resolver states what they did and why; the system records it. The evidence the
policy will eventually need is already being collected: every mismatch carries
its signed delta, its direction, its source and its resolution note, so the rate
and shape of the case are measurable before anyone has to price it.

---

## D-17 — returned settlements

The register's questions are all about the **customer**: fees, which rate, who
bears the difference. There is a separate, prior question that is not commercial
at all, and Stage 6 has to answer it to function: *the facility lent funding
currency, the return came back in INR — what does the facility get back?*

**Technical mechanism: CLOSED.**

Repayment is **pro rata against the original drawdown**:

```
repayment = floor(drawn × returned ÷ delivered)
```

- **No FX rate is applied.** Not the original, not today's. Choosing between them
  *is* `D-17`, and this arithmetic never has to choose: it uses only the
  settlement's own frozen numbers and asks a question with a rate-free answer —
  *what fraction of the delivery came back?*
- A **full** return is exact: `drawn × delivered ÷ delivered` is `drawn`, with no
  residue. Partial returns floor, so cumulative repayments can never exceed the
  drawdown; the alternative rounds up and repays value that was never drawn.
- Confirmation **requests** the repayment and posts nothing (`INV-41`).
  Availability moves on `Y03`/`Y06` and on nothing else (`INV-46`), at which
  point the return reaches `REPAID` (`N05`).
- The settlement row and its receipt are byte-identical throughout (`INV-42`,
  `INV-48`), and cumulative confirmed returns are capped at the delivered amount
  (`INV-49`) in three places: the domain function, the row lock, and a database
  `CHECK` that holds without the lock.

**Commercial treatment: EXTERNAL.**

Nothing is decided about fees, the rate the customer is made whole at, or who
bears the movement. No fee is refunded, no rate is applied, no adjustment is
posted to the customer. The `ReturnNotice` states the amount returned and the
reason; it makes no claim about what the customer is owed, because that claim
would be `D-17` answered by a document template.

---

## Consequences

- Both remain open on the economics, and both are needed before the first real
  customer is charged for a settlement that later returns — Stage 11 in practice.
- Both mechanisms are already built and tested, so answering them is
  configuration and policy rather than a redesign.
- The pro-rata rule is the one piece of arithmetic here that could be mistaken
  for a commercial answer. It is not: it is the *absence* of one. If `D-17`
  eventually says the customer is made whole at the original rate, or today's, or
  net of fees, none of that changes what the facility gets back — which is, and
  should be, the fraction of its own money that came home.

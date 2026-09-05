# The Alex test — record

**Result: NOT RUN.**

This sheet is empty on purpose. It is filled in by a founder, by hand, after
running the session in `ALEX_TEST_PROTOCOL.md` with a real person who has never
seen INRSettle.

Nothing in this repository may mark the Stage 10 exit criterion

> *"An unbriefed payments operator completes a settlement without help — the
> Alex test, run with a real person, recorded"*

as met while this file says NOT RUN. That is enforced by
`scripts/check-alex-test.mjs`, which reads the status line below and fails the
build if any Stage 10 summary claims the criterion is closed while it is open.

---

## Session 1

| Field | Value |
|---|---|
| Date | |
| Facilitator | |
| Note-taker | |
| Participant role | *(payments / treasury / finance operations — and where)* |
| Confirmed unbriefed | ☐ never seen the product, a deck, a screenshot or this repo |
| Environment | *(sandbox build, commit SHA)* |
| Recording | *(file reference)* |

### Prior sentence — before anything was opened

> *"What do you expect a product called INRSettle to do?"*

```
(verbatim)
```

### The task

| Measure | Result |
|---|---|
| **A1** Completed the settlement | ☐ yes ☐ no — *(if no, where they stopped)* |
| **A2** Without help | ☐ yes ☐ no — highest rung used: ___ |
| **A3** Time to complete | ___ min ___ s |
| **A5** Never needed the mechanism | ☐ yes ☐ no |
| **A6** Knew what the final button would do | ☐ yes ☐ no |

Every facilitator intervention, in order, with the rung and what prompted it:

```
1.
2.
```

Moments of hesitation over ten seconds, and what was on screen:

```
1.
2.
```

Anything they said out loud that surprised you:

```
```

### A4 — the Alex sentence

> *"In one or two sentences — what does this product do?"*

```
(verbatim, including hesitations)
```

Compared against `PRODUCT.md § 17`:

| Meaning | Present |
|---|---|
| They specify **who in India** and **how much INR** | ☐ |
| **INRSettle does the rest** — they do not describe arranging funding, buying currency, or choosing a rail | ☐ |
| **One result**, not a set of moving parts to track | ☐ |
| *(fail)* They described the mechanism instead | ☐ |

**A4 verdict:** ☐ pass ☐ fail

### A7 — Overview's four questions

Named unprompted: ☐ what is moving ☐ what is settled ☐ what needs attention
☐ how much can be settled now — **___ of 4**

Their words for the screen:

```
```

### Close

> *"Any moment you felt stuck, or weren't sure what would happen?"*

```
```

---

## Session 2

*(copy the Session 1 block)*

---

## Session 3

*(copy the Session 1 block)*

---

## Verdict

**Status: NOT RUN**

<!--
  Change the status line above to exactly one of:

    Status: PASS — <n> unbriefed participants, all completed unaided
    Status: FAIL — <one sentence on what stopped them>

  `scripts/check-alex-test.mjs` reads that line and nothing else. A PASS is
  claimable only when A1 and A2 both passed for at least one unbriefed
  participant, and no participant failed either. Do not average across
  participants; the criterion is not a score.
-->

| Criterion | Sessions passing | Verdict |
|---|---|---|
| **A1 + A2** — completed unaided *(the exit criterion)* | | |
| **A4** — explained the product *(`PRODUCT.md § 17`)* | | |

### Findings

What the sessions showed, and what changed because of it. A failure is not a
setback to be minimised here — the risk register names *"the product becomes
another fintech dashboard"* as the failure this test exists to catch, and the
only way it catches it is if what happened is written down plainly.

```
```

### Changes made in response

```
```

### Re-run

A product changed in response to a failed session must be re-run with a **new**
participant. The original participant has now seen it, and a second session with
them tests their memory rather than the product.

| Date | Participant | Result |
|---|---|---|
| | | |

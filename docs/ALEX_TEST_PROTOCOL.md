# The Alex test — protocol

**Status: not run.** This document is the instrument. The result is
`ALEX_TEST_RECORD.md`, which is empty until a founder runs the session with a
real, unbriefed person.

> `IMPLEMENTATION_PLAN.md`, Stage 10 exit criteria:
> *"An unbriefed payments operator completes a settlement without help — the
> Alex test, run with a real person, recorded"*
>
> `PRODUCT.md § 17`:
> *"The product fails if a payments professional needs a long explanation."*

---

## Why this cannot be simulated

Everything else in Stage 10 is checkable by machine, and Stage 10 checks it: the
five states, the seven animations, WCAG 2.2 AA on composed screens, the keyboard
path from an empty form to an authorized settlement. All of that can be true of a
product nobody can use.

The Alex test asks a different question — *does a person who has never seen this
know what to do?* — and there is exactly one way to find out. An agent
role-playing an unbriefed operator is not evidence: it has read the source, the
frozen documents and the copy, and cannot un-know them. A self-certified pass
here would be the single most expensive lie in the project, because it would
close the one criterion designed to catch the failure mode the risk register
names: *"The product becomes another fintech dashboard."*

So this criterion is **founder/manual**. It stays open until a person runs it.

---

## Who Alex is

One participant per session, matching all of:

- Works or has worked in **payments operations, treasury operations, or
  finance operations** — someone who has actually sent money to a supplier,
  chased a payment, or reconciled a bank statement as part of their job.
- Has **never seen INRSettle**: not the product, not a deck, not a screenshot,
  not this repository.
- Has **not been told what the product does** before the session starts.
  This is the whole variable. One sentence of context from you invalidates the
  session, and it is very easy to give one by accident.

Explicitly **not** valid participants:

| Not valid | Why |
|---|---|
| Anyone who has seen a deck or demo | They are testing recall, not comprehension |
| Engineers on the project | They know the model |
| A friend told "it's for sending money to India" | That sentence is the test |
| An LLM, however prompted | It cannot be unbriefed |

Three participants is a reasonable minimum for confidence. One is enough to fail.

---

## Setup

1. Sandbox environment, seeded per `PRODUCT.md § 18` — deterministic simulators,
   so every session sees the same product.
2. A workspace with **a facility enabled** and **no beneficiaries and no
   settlements**. Alex starts where a new customer starts.
3. Screen and audio recording, with consent asked before recording starts.
4. Desktop, 1440×900 or wider. § 8 puts creating a settlement in the desktop
   experience; testing it on a phone tests something else.
5. A second person to take notes, so the facilitator can watch rather than write.

Have ready but do not volunteer: the beneficiary's details (name, account
number, IFSC), an amount (₹5,00,000), and a purpose (software services).

---

## The script

Read the bracketed lines **verbatim**. The words are the experiment.

### 1. Consent and framing

> *"Thanks for doing this. I'm going to ask you to try a piece of software
> neither of us will talk about much. I'll record the screen and our audio, and
> I'll delete it whenever you ask. There are no wrong answers and you cannot
> break anything — if something is confusing, that's information about the
> software, not about you."*

Do **not** say what the product is. Not "it's a payments tool", not "it's for
India". If asked directly, say:

> *"I'd rather you tell me. That's most of what I'm trying to learn."*

### 2. The prior sentence

Before anything is opened, ask:

> *"Nothing's on screen yet. Based on nothing at all — what do you expect a
> product called INRSettle to do?"*

Record the answer verbatim. This is the control: the gap between it and the
answer in step 5 is what the product itself taught them.

### 3. The task

Open the Overview screen. Then:

> *"Send five lakh rupees to Aarti Sharma. Her account details are on the card
> in front of you. Talk out loud as you go — what you're looking at, what you
> expect to happen, anything that surprises you."*

Then stop talking.

### 4. Facilitation, and the help ladder

The criterion is *"completes a settlement **without help**"*, so every
intervention is a recorded cost. Escalate one rung at a time, never further than
needed, and write down every rung used:

| Rung | What you say | Counts as |
|---|---|---|
| 0 | *(silence)* | Not help |
| 1 | *"What are you thinking?"* | Not help |
| 2 | *"What would you try?"* | Not help |
| 3 | *"What do you think that does?"* | Not help |
| 4 | *"Try it and see."* | **Help — the run is not a clean pass** |
| 5 | Pointing at the screen, or naming a control | **Help — failed** |

Silence is uncomfortable and thirty seconds of it is often where the finding is.
Count to ten before rung 1.

Stop the task at fifteen minutes, whatever has happened. Record where they were.

### 5. The Alex sentence

Immediately after the task, before any discussion:

> *"In one or two sentences — what does this product do?"*

Record it **verbatim**, including the hesitations. Then compare it to
`PRODUCT.md § 17`:

> *"Tell INRSettle who in India must receive how much INR. INRSettle executes the
> settlement through connected liquidity and payout infrastructure and gives you
> one final settlement result."*

The comparison is on **meaning**, not wording. It passes if their sentence
carries all three of:

- **who and how much** — they say the customer specifies a recipient in India
  and an amount in rupees;
- **INRSettle does the rest** — they do not describe themselves as arranging
  funding, buying currency, or choosing a rail;
- **one result** — they describe a single outcome, not a set of moving parts to
  track.

It fails if they describe the mechanism — *"you buy stablecoins and it converts
them"* — because the mechanism is what `§ 12` spends its whole length keeping
off the screen. It also fails if they cannot answer.

### 6. The four questions

Show the Overview screen again:

> *"Looking at this screen — what would you say it's telling you?"*

`PRODUCT.md § 12.1` says Overview answers four questions. Record how many they
name unprompted: what is moving, what is settled, what needs their attention,
how much they can settle now.

### 7. Close

> *"Last thing — was there any moment you felt stuck, or where you weren't sure
> what would happen if you clicked something?"*

Then thank them and stop recording.

---

## What is being measured

| # | Measure | Passes if |
|---|---|---|
| A1 | Completed the settlement | Reached the authorization action and used it |
| A2 | Without help | Facilitator never went past rung 3 |
| A3 | Time to complete | Recorded; no threshold, but a long time is a finding |
| A4 | Explained the product | Their sentence carries all three meanings above |
| A5 | Never needed the mechanism | Did not ask what happens to the money in between |
| A6 | Knew what the button would do | Read the amount off the final action before pressing |
| A7 | Overview's four questions | How many they named unprompted |

**A1 and A2 together are the exit criterion.** A4 is `PRODUCT.md § 17`. The rest
are the findings that make a failure actionable.

---

## Recording the result

Fill in `ALEX_TEST_RECORD.md` — one section per participant, then the verdict.
File the screen recordings alongside it.

A run counts as a pass only if **A1 and A2 both pass** for an unbriefed
participant. A single failure on either is a Stage 10 failure, and the honest
response is to fix the product and run it again with a *new* participant — a
second run with the same person is a test of memory.

Do not average across participants and do not describe a partial result as a
pass. The criterion is not a score.

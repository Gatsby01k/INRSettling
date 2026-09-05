# Stage 10 — UI and UX hardening

`PRODUCT.md § 12.1`, `§ 12.2`, `§ 12.3`, `§ 17`;
`DESIGN_SYSTEM.md § 5`, `§ 6`, `§ 7`, `§ 8`, `§ 10`, `§ 12`.

---

## 1. The shape of the whole stage, in one sentence

**Stage 10 is the first stage that looked at a screen instead of a component,
and most of what it found had been true since Stage 1.**

The polish pass was expected to be the § 12.2 reading order, the amount morph,
the four breakpoints, and the five states — and it was all of those. But the
first hour of it turned up a class of defect nothing in nine stages could have
caught, because every gate the project had was pointed at a smaller unit than the
one that was broken.

`DESIGN_SYSTEM.md § 12` names the principle: *"a component that exists in an app
but not in `packages/ui` is a bug to be closed, not a shortcut to be kept."* The
same sentence turns out to describe a wider family. A class that exists in an app
but in no stylesheet is that bug. A custom property that exists in a stylesheet
but in no token emitter is that bug. Two components sharing one block name is
that bug. None of them fails, because CSS has no failure mode for any of them:
an unknown class does nothing, an undefined custom property is dropped, and the
later rule simply wins.

So the stage did the specified work, and closed that family with gates.

---

## 2. What was broken before this stage started

Four defects, all pre-existing, all invisible to 1,540 passing tests. They are
listed first because they are the reason the exit criterion says *"verified on
composed screens, not only tokens"*, and because each one had been shipping since
the stage that introduced it.

### 2.1 Every error affordance in the product rendered colourless

`primitives.css.ts` read `var(--status-action-required-fg)` in ten places. The
emitter wrote `--status-action_required-fg`, because `statusColor` is keyed by
the `StatusTone` union — whose members are snake_case — and the kebab function
handled only camelCase.

CSS drops an undefined custom property silently, so:

| Affordance | What it actually rendered |
|---|---|
| Invalid field border | the default border colour |
| Error toast border | the default border colour |
| Blocking requirement bar | no bar |
| Action-required status dot and label | the inherited ink colour |
| **Destructive button background** | **transparent — white label on white** |

The last one is a WCAG failure with a contrast ratio of 1:1, on the button that
cancels a settlement.

The token contrast suite passed the entire time, and was right to: it asserts
`#B42318` on `#FEF3F2` at 4.5:1, and that pair is correct. What was wrong was the
bridge between the pair and the pixel, which is precisely the gap the phrase *"not
only tokens"* names.

**Fixed** in the emitter's `kebab`, which now converts `_` as well.

### 2.2 The settlement rail's saffron→teal fill never rendered

`accentGradient` has been exported as a token since Stage 1 and referenced by
`.is-progress__step--done` since Stage 3. It was never emitted as a custom
property at all. `DESIGN_SYSTEM.md § 6` calls this fill the settlement's primary
visual — *"the rail fills from saffron to teal as the settlement advances"* — and
it has never once appeared.

**Fixed** by emitting `--accent-gradient`.

### 2.3 No composed screen in the product had any layout

`is-page__header`, `is-form`, `is-fieldset`, `is-facts`, `is-callout`,
`is-settlement`, `is-new-settlement`, `is-destination`, `is-endpoint`,
`is-delivery`, `is-example`, `is-checklist`, `is-facility`, `is-muted` — every
layout class written into `apps/app` and `apps/ops` from Stage 2 onward, and not
one of them had a rule anywhere. The primitives were styled; the pages they sit
on were not. Storybook rendered a stack of correctly-styled controls in an
unstyled document, and every screenshot of it looked like a design decision.

**Fixed** by `packages/ui/src/components/screens.css.ts`, which is also where the
§ 8 breakpoints now live.

### 2.4 `AmountInput` and `AmountDisplay` shared one block name

Both claimed `.is-amount`, with incompatible rules:

```css
.is-amount { position: relative; display: flex; }        /* the input  */
.is-amount { display: inline-flex; flex-direction: column; }  /* the display */
```

The display's block is declared later, so it won. The input's wrapper lost
`position: relative` — which its absolutely-positioned `₹` symbol depends on, so
the symbol left the field and anchored to whatever ancestor happened to be
positioned — and became an inline-flex column, so the field stopped filling its
width. On *Recipient gets ₹*, the first figure typed on the screen `§ 12.2` calls
the most important in the product.

The cascade did exactly what it is specified to do. The mistake was two
components claiming one name, and nothing said so.

**Fixed** by renaming the input's block to `is-amount-field`.

### 2.5 `aria-label` on a bare `div`, in every loading state in the product

Found by the first axe run over a composed screen: ten loading skeletons across
`apps/app` and `apps/ops` carried `aria-label` on a `<div>` with no role, which
is prohibited and a WCAG 4.1.2 failure. Each one individually looked correct.

**Fixed** by adding `role="status"`, which is what a loading region is.

---

## 3. The specified work

### 3.1 The two deferred § 5 domain components

`MetricTile` and `EventRow`, the last two the § 5 table names that earlier stages
deferred. Both were genuinely needed: Overview cannot exist without a tile, and
the Developers event log has been building its own rows inside `apps/app` since
Stage 8 — the exact shape § 12 calls a bug.

`ReceiptDocument` stays deferred, and the reason is not scheduling. `INV-29`
requires one template to serve both the screen and the PDF, so writing the screen
half now would produce a second template to reconcile later — which is the
failure `INV-29` exists to prevent.

`MetricTile` takes `Money | number | null`, and the `null` is load-bearing:

> `PRODUCT.md § 12.1` shows **Available to settle** *"only when a liquidity
> facility is actually enabled"*, and a workspace *"can exist before a facility is
> provisioned"*.

So absent and zero are different answers, and only one of them tells a customer
they have no headroom. The tile renders `—`, and Overview drops the tile entirely
rather than rendering it empty — a distinction the type carries, not a convention
somebody has to remember.

### 3.2 Overview — `§ 12.1`

*"Overview answers four questions and nothing else."*

The presentation type has **four named metric slots and no array to push a fifth
into**. That is the whole design: a `readonly MetricView[]` would make adding a
metric a one-line change no reviewer would question, and Revision 5 of the frozen
document exists because a fifth one was proposed once already. Naming them makes
it a decision.

Below the metrics: open exceptions first, then active settlements. Exceptions
above, because that section answers *what needs my attention* and burying it
under a longer list answers it last.

The tests assert the absences directly — no chart, no comparison to yesterday, no
"welcome back", no returning-to-facility figure — because absence is what this
section specifies and a screen that has quietly grown a chart still passes every
assertion about what it contains.

### 3.3 New Settlement — `§ 12.2`

Two gaps against the frozen text:

**The fifth input did not exist.** The reading order is *"Beneficiary → Recipient
gets ₹ → Purpose → Funding currency → Reference / documents if needed"*, and the
screen stopped at funding currency. Added, with the *"if needed"* half honoured:
the documents control appears only when the chosen purpose requires it, because a
file input on every settlement implies one is expected — and *preflight* decides
that, not this screen.

**The quote blanked on every keystroke.** `DESIGN_SYSTEM.md § 6` is explicit:

> *"Amount morph — when a quote re-prices, digits transition in place. The figure
> never blanks and re-renders; that reads as uncertainty about money."*

`QuoteSummary` replaced its entire body with skeletons whenever `loading` was
set, so a live ₹50,00,000 vanished each time the customer typed a digit. Now
`loading` (first pricing, nothing to blank) and `repricing` (a figure is on
screen) are different states: a re-price keeps the recipient amount rendered and
morphing, and only the derived lines — you pay, rate, fees — wait, because those
genuinely are unknown until the new quote lands.

### 3.4 Settlement detail — `§ 12.3`

Three things the section requires that the screen did not have:

- **The plain-language timeline**, which § 12.3 prints verbatim. Every label is a
  sentence about the customer's money, and the status→label mapping is
  deliberately *partial*: a transition with no plain words produces no row rather
  than a row naming the state. `PAYOUT_SUBMITTED` is the moment we started doing
  something, not a moment anything happened to their money. Silence beats jargon,
  and a timeline is not an audit log — the audit log exists and is not this.
- **The frozen-destination note.** *"A small note says so, rather than leaving
  someone to wonder why the account they just corrected is not reflected here."*
  Shown only once authorized, because before that the page shows the live
  destination and the note would be false.
- **The return notice.** Stage 6 built `returnNotice` and **no screen ever
  rendered it**, though § 12.3 says it *"is the first thing read on that page"*.
  Now first, above the rail, with the settlement's badge beside it still reading
  Settled — both facts are true, and `STATE_MACHINES.md § 8.5` records that
  tension as accepted deliberately.

The line replacing Cancel once the payout is sent now says *why* — § 12.3 asks
for *"a single line explaining why"*, and a line that only states the fact
explains nothing.

### 3.5 Motion — `§ 6`

The seven permitted animations are now data (`packages/ui/src/tokens/motion.ts`),
each carrying the document's own words, its token, and what
`prefers-reduced-motion` leaves. Three of the seven had never been implemented:
the status progression, the liquidity reservation feedback, and the settled
confirmation.

Every one fires **on a state change and never on mount**, which is § 6's subtlest
clause — *"anything that moves while the user is reading a number"* is banned, so
a settled settlement opened a week later must not replay the settlement. That is
behaviour a stylesheet cannot express and a CSS gate cannot see, so it has its
own test file.

The liquidity feedback is directional: § 6 says *"when it decreases"*, and an
increase is capacity arriving, which needs no acknowledgement. A decrease is the
moment the customer's own settlement consumed some — the one mechanic they never
otherwise see happen.

`scripts/check-motion.mjs` enforces the closed list. Its most useful clause is
the one that looks least important: **every duration must come from a motion
token**. Reduced motion is implemented by zeroing `--motion-*-duration` inside
the media query, so a hardcoded `300ms` keeps animating for someone who asked
their operating system for no animation — and nothing about the rule looks wrong.

### 3.6 Responsive — `§ 8`

The three thresholds are declared once, in `responsive.ts`, and
`check-styles.mjs` rejects any media query at a width that is not one of them. A
stray `max-width: 900px` is not wrong the way a broken selector is wrong; it
works, it just puts the layout change 124px from where the document says, and
nobody notices until two files disagree about where "mobile" starts.

The `<768px` **monitoring experience** is the row with a product decision in it:

> *"Creating a batch, managing API keys and CSV import are desktop tasks and say
> so plainly rather than degrading."*

*Rather than degrading* is the hard half. The easy thing is a responsive form
that technically works at 360px — and for API keys that is actively harmful,
because a new key is shown once and never again, so a phone-sized version wastes
the one moment the secret is visible. `DesktopTask` says what the task is, why it
needs a computer, and what to do; the Developers page swaps the keys tab for it
below 768px and keeps every monitoring tab, which is what § 8 says a phone is
for.

The width is measured, not sniffed: a narrow window on a laptop is the same
problem as a phone, and a user agent string is a guess about a person. An
*unmeasured* viewport is explicitly not a small one — defaulting the other way
would hide the tab in every environment that does not report a width.

### 3.7 Accessibility — WCAG 2.2 AA on composed screens

Twelve screens rendered with the real stylesheet attached and audited with axe,
scoped to the AA tags. `best-practice` rules are deliberately excluded: they are
opinions worth having, and mixing them in would make a failure ambiguous about
whether the product is non-conformant or merely unfashionable.

The audit covers the Stage 2 and Stage 8 screens as well as Stage 10's, which is
how § 2.5 above was found.

**What this run does not cover, stated plainly:** jsdom does not lay out or
paint, so axe's own colour-contrast rule cannot execute and reports *incomplete*
rather than a pass. Contrast is covered by the token suite (every status pair
asserted at 4.5:1) and by the Storybook a11y addon, which runs in a real browser.
What the jsdom run covers is the half a person is worst at catching by eye:
names, roles, relationships, heading order, labels and focusability across a
whole screen at once.

The keyboard criterion has its own file, and it walks the flow rather than
checking that controls are focusable: type into the combobox, arrow down, Enter,
type an amount, select a purpose, Enter on an action that names the amount. A
screen can pass an axe audit and still fail that.

### 3.8 Five states on every screen — `§ 10`

The primitive registry has enforced five states per *component* since Stage 1 and
it works. But a screen made entirely of components that each handle emptiness
correctly can still have no answer for its own: an Overview whose four tiles each
render a tidy dash, on a page that never says the workspace is new. Every
component passes; the screen has no state at all.

`apps/app/src/screens.ts` is the same discipline one level up, with one
difference. A primitive names its stories after the states because it has nothing
else to call them. A screen's states have real names — *Past the point of no
return*; *Day one, nothing set up yet* — and renaming those to `Empty` would make
Storybook less readable to the person doing the reviewing, which is the whole
purpose of the criterion. So each state points at the story that demonstrates it,
and the test reads the **built** Storybook index.

Doing this surfaced a small structural defect: settlement detail had no Storybook
title of its own. Its stories lived in the New Settlement file and therefore
published under that screen's name. Two screens under one title makes *"reviewed"*
impossible — there is no way to look at one screen's five states without the
other's mixed in. Split into `detail.stories.tsx`.

---

## 4. Exit-criteria matrix

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | WCAG 2.2 AA verified on composed screens, not only tokens | **Met** | `apps/app/src/__tests__/accessibility.test.tsx` — 12 screens, axe at AA tags, real stylesheet attached; found and fixed a 4.1.2 failure in every loading state. Contrast covered by `tokens.test.ts` + the Storybook a11y addon (see § 3.7 on the jsdom limit) |
| 2 | The whole New Settlement flow is completable by keyboard alone | **Met** | `apps/app/src/__tests__/keyboard.test.tsx` — empty screen to authorized settlement, no pointer; plus tab order matching the § 12.2 reading order |
| 3 | `prefers-reduced-motion` removes all motion with no loss of meaning | **Met** | `scripts/check-motion.mjs` (every animation reduced or disabled; every duration from a token, which is what the media query zeroes) + `motion.behaviour.test.tsx` (meaning survives: the rail still says where it is, in text) |
| 4 | Loading, empty, error and disabled states exist everywhere and are reviewed | **Met, with a note** | `apps/app/src/screens.ts` + `screens.test.ts` against the built Storybook. The *"and are reviewed"* half is a person looking; what the gate guarantees is that there is something to look at and that every exemption is an argument |
| 5 | An unbriefed payments operator completes a settlement without help — the Alex test, run with a real person, recorded | **OPEN — founder/manual** | `docs/ALEX_TEST_PROTOCOL.md` is prepared. `docs/ALEX_TEST_RECORD.md` says **NOT RUN**. `scripts/check-alex-test.mjs` fails the build if any document in this repository claims otherwise |

**Stage 10 is not complete.** Criterion 5 is open by instruction and by design.

---

## 5. The Alex test, and why nothing here claims it

The instruction was to prepare the protocol and recording sheet and *not*
simulate or self-certify the result. That is the right instruction, and it is
worth writing down why rather than only complying.

Everything else in this stage is checkable by machine, and all of it can be true
of a product nobody can use. The Alex test asks whether a person who has never
seen this knows what to do, and there is exactly one way to find out. An agent
role-playing an unbriefed operator is not evidence: it has read the source, the
frozen documents and the copy, and cannot un-know them. A self-certified pass
would be the most expensive lie available in this project, because it would close
the one criterion designed to catch the failure the risk register names —
*"the product becomes another fintech dashboard."*

So the criterion is **founder/manual**, and it is enforced rather than merely
stated. `check-alex-test.mjs` reads the status line in the record and, while it
says NOT RUN, fails the build on any line in any document that marks the test
passed, complete, met, satisfied, verified or closed. The honest forms — *"not
run"*, *"founder/manual"*, *"open until"* — are allowed, because a gate that
flagged every mention is a gate nobody can write notes around, and it gets
switched off. The gate cannot be satisfied by editing code. It is satisfied by
running the session.

The protocol is built to make a *clean* result possible rather than a flattering
one: a five-rung help ladder where rungs 4 and 5 disqualify the run, a fifteen
minute stop, the prior-expectation sentence recorded before anything is opened as
a control, and the Alex sentence compared on meaning against `PRODUCT.md § 17`
with mechanism-talk counted as a failure — because the mechanism is what § 12
spends its whole length keeping off the screen.

---

## 6. New gates

| Gate | Closes |
|---|---|
| `scripts/check-styles.mjs` | A class with no rule; a `var()` the tokens do not emit; two components sharing one block name; a media query at a width § 8 does not name |
| `scripts/check-motion.mjs` | An eighth animation; anything over 400ms; a hardcoded duration reduced motion cannot reach; an animation with no reduced-motion treatment; the § 6 banned list by name |
| `scripts/check-alex-test.mjs` | Any document claiming the Alex test is done while the record says NOT RUN |
| `apps/app/src/__tests__/screens.test.ts` | A composed screen that has not decided its five states, or declares a story that was never published |
| `packages/ui/src/tokens/tokens.test.ts` | The stylesheet and the token emitter disagreeing on a property name |

Each has its own self-test asserting it **rejects** the defect that motivated it,
including the near-misses it must not flag. A gate that has never rejected
anything is indistinguishable from one that cannot.

`pnpm verify` is now:

```
typecheck → check-source-tree → lint → check-money-columns →
check-requirement-copy → check-liquidity-copy → check-finality →
check-ops-boundaries → check-migration-order → check-styles →
check-motion → check-alex-test → build-storybook → test
```

---

## 7. Deviations from the frozen documents

None. Every question this stage raised was answerable from the documents, and the
places where it would have been easy to invent — what a desktop-only message
says, which transitions earn a timeline row, whether a reconciliation figure
shows paise — were answered from what the documents already commit to rather than
from taste.

Two judgements worth surfacing for review, neither a divergence:

- **The reconciliation timeline row shows paise** (`₹50,00,000.00 expected ·
  ₹50,00,000.00 observed`) where § 12.3's example shows `₹5,000,000`. A
  reconciliation line is exactly where exactness is the point: figures that
  rounded would be unable to show the mismatch the line exists to show.
- **The timeline's status→label map is partial by design.** Five internal
  transitions produce no row. If a future revision wants them, they need plain
  words first — adding the state name would be the machine leaking through the
  one surface that exists to keep it out.

---

## 8. Open decisions

No new decisions. Unchanged and still open: `D-01`, `D-02`, `D-04b`, `D-05b`,
`D-06`, `D-08b`, `D-09b`, `D-11`, `D-13`, `D-14b`, `D-15`, `D-16b`, `D-17b`,
`D-18b`, `D-20`. `D-01`/`D-02` remain the counsel gate and the Stage 11 blocker.

---

## 9. Verification

| Check | Result |
|---|---|
| `pnpm verify` (full chain above) | **clean** — 83 files, 1,653 tests |
| `./scripts/verify-fresh-cluster.sh` | **PASS** — 17 migrations applied to a cluster that had never seen this project |
| Storybook build | clean; every primitive × state and every declared screen state published |

---

## 10. What Stage 11 inherits

- A stylesheet that reaches the screens, and gates that keep it reaching them.
  The next person to add a screen cannot ship a class with no rule.
- A motion catalogue that is data rather than a paragraph, so the eighth
  animation is a conversation instead of a commit.
- Screen-level state coverage, which a new screen must satisfy before its
  stories will pass.
- **An open exit criterion.** Stage 11 does not start until the Alex test has
  been run with an unbriefed person and this stage reviewed.

# v6 as the product frontend — conformance review

Decision of 2026-09-11: the v6 static workspace becomes the product frontend. The
React screens in `apps/app/src` and the component library in `packages/ui` are
retired. This note records what that decision costs, what breaks on contact, and
what has to happen before the workspace can sit in front of the Stage 1–9 backend.

Reviewed: `INRSettle-Landing-App-v6/dist/app/` — `index.html`, `workspace.css`
(92 KB), `workspace.js` (80 KB), `data.js`. Syntax clean; its own eight tests pass.

---

## 1. What the decision itself revises

Two frozen documents stop describing reality the moment v6 is adopted. Both need a
new revision and a new SHA-256 manifest before anything is merged.

| Document | Statement that becomes false |
|---|---|
| `ARCHITECTURE.md` | The app stack is Next.js App Router + TypeScript. v6 is hand-written HTML, CSS and ES modules with no build step and no type system. |
| `DESIGN_SYSTEM.md § 12` | "Components live in `packages/ui`, documented in Storybook with all five states from § 10, and covered by visual regression tests. A component that exists in an app but not in `packages/ui` is a bug." v6 has no component library, no Storybook and no visual regression. |

`DESIGN_SYSTEM.md § 12` also says tokens are authored once and exported to both CSS
custom properties and a typed TypeScript object. v6 authors its tokens directly in
`workspace.css`. Either the export direction is reversed — `tokens.ts` stays the
source and generates the CSS v6 consumes — or § 12 loses that sentence too. Keeping
`tokens.ts` as the source is the cheaper of the two and preserves the contrast test
that pins the five status pairs.

## 2. The gate layer

Six gates run in `pnpm verify`. Adopting v6 changes what four of them can see.

| Gate | Effect | What it needs |
|---|---|---|
| `check-styles.mjs` | **Breaks.** It reads `packages/ui/src/components`, `tokens/to-css.ts`, `tokens/tokens.ts` and `components/responsive.ts` by path. Retiring `packages/ui` makes it throw, not fail. | Repoint at `workspace.css`, or retire it — retiring is a quality-bar revision, not a refactor. |
| `check-motion.mjs` | **Fails on v6.** `workspace.css` carries a `.55s` transition and a `100s` animation. § 6 caps everything at 400ms and bans looping ambient motion outright. | Fix the two values in v6, then repoint the gate. |
| `check-liquidity-copy.mjs` | **Fails on v6.** `balance`/`balances` appear about 28 times and `wallet` 8 times across `workspace.js` and `data.js`. The gate rejects balance / wallet / credit / facility in customer-facing text. | Section 6 below. |
| `screens.test.ts` | **Cannot run.** It asserts five declared states per screen against the React screens. v6 has empty states (3) and error paths (8) but no loading state anywhere — `skeleton` does not appear in either file. | A static equivalent, plus real loading states in v6. |
| `accessibility.test.tsx` | **Cannot run.** It is React Testing Library plus axe. | Rewrite as Playwright + axe-core against the served pages. This is the one gate worth rebuilding first: it is the only automated check on § 7. |
| `check-secrets.mjs`, `check-alex-test.mjs` | Unaffected. | — |

Every gate has a test proving it rejects the defect it was written against. Those
tests need to survive the repointing, or the gates become decoration.

## 3. Product surface

v6 ships seven sections: Overview, Settlements, Liquidity, Counterparties,
Reconciliation, Developers, Settings.

`PRODUCT.md § 12` fixes five — Overview, Settlements, Beneficiaries, Batches,
Developers — and then names the exclusions explicitly: *"No customer navigation
section for: Treasury, **Liquidity**, Providers, Compliance, **Reconciliation**,
Documents, Analytics, Wallet, Crypto, Stablecoins."* It also places Settings under
account/workspace controls rather than in the primary nav.

So three of v6's seven sections are named in the prohibition, one is a renaming of
Beneficiaries, and Batches is missing entirely.

| v6 section | Disposition |
|---|---|
| Overview | Keep. Content corrections in § 4. |
| Settlements | Keep. |
| Counterparties | Rename to **Beneficiaries** — `§ 16` is explicit that the record is a beneficiary, never a payee, recipient or contact. The screen itself is sound. |
| Liquidity | Remove from the nav. The one figure a customer needs, *Available to settle*, is an Overview metric. The rest is Internal Operations. |
| Reconciliation | Remove from the nav. Reconciliation surfaces as one line on a settled settlement, not as a product area. |
| Developers | Keep. |
| Settings | Move under account/workspace controls. |
| — | **Batches is missing.** `PRODUCT.md § 10` defines it and § 12 lists it. |

Keeping Liquidity and Reconciliation as customer sections is a `§ 12` revision, and
the reasoning in § 12 is that they do not become top-level areas "without user
research proving they must". There is no such research.

## 4. Overview

v6 shows Total Settlement Volume, Active Corridors, Success Rate and Avg. Settlement
Time, each with a delta chip.

`§ 12.1` fixes four different metrics — **Available to settle** (shown only when a
liquidity facility is active), **In flight**, **Settled today**, **Needs attention**
— and closes with *"No decorative charts. No vanity metrics. No 'welcome back'
hero."* Revision 5 removed a proposed fifth metric on the grounds that Overview
answers four questions.

Zero of v6's four match. All four are vanity metrics of the kind § 12.1 names. The
`MetricTile` spec in `DESIGN_SYSTEM.md § 5` also forbids a delta chip unless the
delta is actionable; none of these are.

The Featured Corridor card, Quick Actions grid, Liquidity & Treasury summary and
Reconciliation & Audit summary are not in § 12.1 either, which specifies active
settlements and open exceptions below the metrics and nothing else.

## 5. Statuses

v6 uses Settled, Processing, Ready, Action required, Failed.

- **Processing** — `§ 16` names it directly: use *Settling*, never "Processing,
  pending, in progress".
- **Failed** — does not exist. Decision `D-03` is closed: five customer-facing
  states and no sixth. A failure projects to CANCELLED carrying a `resolution`
  string. The reasoning is recorded because the pressure to add the sixth state was
  expected to return; this is that pressure. v6 also lacks CANCELLED entirely.
- **Colours.** v6 renders Processing blue (`#1a87c7`) and Ready teal (`#05aa93`).
  `§ 2.4` binds SETTLING to saffron `#9C5808` and READY to neutral `#33465F`, with
  SETTLED on teal `#0A6B55`. The saffron→teal progression is the product's core
  semantic and the only reason `§ 2.3` lets the gradient exist at all. As shipped,
  v6 spends teal on *Ready* and gives *Settling* a colour with no meaning in the
  system, which empties the progress rail of content.
- Revision 4 darkened two of those foregrounds specifically to pass 4.5:1. v6's
  values have not been through that check.

## 6. Language

`check-liquidity-copy.mjs` fails on the archive as it stands: `balance` and
`balances` about 28 times, `wallet` 8 times. `§ 16` additionally bars drawdown,
reservation (present once), prefunding, stablecoin, USDT liquidity, provider and any
internal state name from customer-facing text, and maps the vocabulary:

| Use | v6 currently says |
|---|---|
| Available to settle | Balance, wallet |
| Settling | Processing |
| Beneficiary | Counterparty |
| Recipient gets | — |

The detail panel also surfaces routing, settlement network and a transaction hash in
the primary reading path. `§ 4` lists stablecoin liquidity operations and FX
execution mechanics among the things a customer must never be required to
understand; they belong in collapsed technical detail, the API, or Internal
Operations.

## 7. Design system conformance

- **Typeface.** v6 loads Nimbus Sans (URW's Helvetica clone, AGPL-3 with the font
  exception) under the CSS alias `INRSans`. `§ 3` specifies Inter for UI and
  JetBrains Mono for IDs, UTRs, IFSC and API keys. v6 uses the generic `monospace`
  keyword once. Either § 3 is revised to name the real faces, or the fonts change.
  The licence file must keep travelling with the OTFs wherever they end up.
- **Breakpoints.** v6 uses 370, 560, 760, 1020, 1240, 1260, 1300 and 1499px. `§ 8`
  defines exactly four: ≥1280, 1024–1279, 768–1023, <768, with the sub-768 tier
  being a monitoring experience that says plainly which tasks are desktop work.
  `check-styles.mjs` rejects breakpoints outside that set.
- **Motion.** Two values exceed § 6: a `.55s` transition and a `100s` animation.
  The 100s value is looping ambient motion, banned by name.
- **States.** § 10 requires all five states on every component and every screen.
  v6 has no loading state — no skeletons, no `is-loading` — so tables and panels
  pop in. § 10 is specific that loading is a skeleton at final dimensions, never a
  spinner over content and never a layout shift.
- **Accessibility.** v6 ships `prefers-reduced-motion` and, better than the document
  asks, `prefers-contrast: more`. Keep both. The status pills still need the § 2.4
  contrast pairs and the dot-plus-label rule.

## 8. What is genuinely good in v6 and should survive

The shell anatomy, density and rhythm. The detail drawer. Keyboard handling, the
skip link, focus management, native dialogs, lazy loading. Filters, sorting,
selection with mixed state, pagination and CSV export. The three-stage settlement
walkthrough with a preserved draft and explicit preflight feedback — that is the
shape `§ 12.2` asks for. The brand assets. The absence of any dependency.

## 9. Order of work

1. Revise `ARCHITECTURE.md` and `DESIGN_SYSTEM.md § 12`; issue a new manifest.
   Nothing else should land before this, or the manifest check fails on every
   subsequent commit.
2. Decide `tokens.ts` or `workspace.css` as the token source, and wire the contrast
   test to whichever wins.
3. Content pass on the workspace: five sections, the four § 12.1 metrics, five
   states with § 2.4 colours, § 16 vocabulary, Batches added.
4. Fix the two motion values and add loading states.
5. Repoint `check-styles`, `check-motion` and `check-liquidity-copy` at the static
   sources, keeping each gate's own rejection test. Rebuild the accessibility gate
   on Playwright + axe.
6. Wire to `/v1`: HTTP client, view-model mapping, session, error boundaries,
   network-failure states. This is the Stage 10.5 scope, unchanged by the decision —
   only the technology it lands in changed.
7. Then the Alex test, against the finished workspace, and only then Stage 10 closes.

## 10. Two traps

**`dist/` is in `.gitignore`.** v6 serves from `dist/`. Dropped into the monorepo
under that name, every file of the new frontend is silently untracked. Rename the
directory or amend the ignore rule deliberately.

**The landing is gone from this repository.** It now lives at
`~/Documents/inrsettle-landing`, its own git repository, `public/` as the web root.
The two properties share only brand assets, which are duplicated on purpose. Four
links in the landing still point at `/app/` and need the real workspace URL before
the site is public.

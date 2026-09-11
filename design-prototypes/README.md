# design-prototypes

Visual prototypes produced in the design/UI-UX workstream. **Nothing in this folder
is part of the build.** No package imports from it, no gate reads it, `pnpm verify`
does not touch it.

## What is here

| File | What it is |
|---|---|
| `inrsettle-landing.html` | The marketing landing, one self-contained file. Reference-identical. |
| `inrsettle-console.html` | Overview and Settlements product screens, one self-contained file. Reference-identical. |
| `brand/inrsettle-mark.png` | The "S" mark, trimmed, transparent. |
| `brand/inrsettle-lockup.png` | The INRSETTLE wordmark with the signature line, trimmed, transparent. |
| `src/inrsettle-landing.src.html` | Landing source with `__MARK__` / `__WM__` placeholders; the shipped file is this with the two PNGs inlined as data URIs. |

Both HTML files are plain HTML, CSS and vanilla JS. The only external request is
Google Fonts (Inter). All motion is CSS and SVG; there is no animation library.

## What this is NOT

- **Not `packages/ui`.** These are hand-written prototypes. `DESIGN_SYSTEM.md § 12`
  still holds: a component that exists in an app but not in `packages/ui` is a bug.
  Nothing here has been promoted to a component, and nothing here should be
  copy-pasted into `apps/` as-is.
- **Not the app shell.** There is still no entry point, router, HTTP client or
  browser session. That work is Stage 10.5 (decided 2026-09-06) and has not started.
- **Not a Stage 10 exit criterion.** Stage 10 stays open on the Alex test, which is
  founder-run and still `NOT RUN` in `docs/ALEX_TEST_RECORD.md`.

## Deliberate divergences from the frozen documents

The prototypes reproduce supplied visual references *exactly*, on purpose, so the
founder could judge the visual direction against the real thing. That means the
console prototype currently contradicts the frozen product surface in ways that are
known and must not be carried into the product:

- Navigation shows Liquidity, Counterparties, Reconciliation and Settings in the
  primary nav. `PRODUCT.md § 12` names five surfaces — Overview, Settlements,
  Beneficiaries, Batches, Developers — and explicitly forbids a customer nav section
  for Liquidity and Reconciliation.
- Overview shows Total Settlement Volume, Active Corridors, Success Rate and Average
  Settlement Time. `§ 12.1` fixes four different metrics: Available to settle,
  In flight, Settled today, Needs attention — and forbids vanity metrics and a
  "welcome back" hero.
- Status vocabulary shows *Processing* and *Failed*. `§ 6` has five states and
  decision `D-03` is closed: SETTLING, not Processing; a failure projects to
  CANCELLED with a stated resolution, there is no sixth state.
- Status colours do not carry the saffron→teal semantic. `§ 2.4` binds SETTLING to
  saffron and SETTLED to teal; the prototype uses the reference's blue/green.
- The detail panel surfaces on-chain routing, network and transaction hash in the
  primary reading path. `§ 4` and `§ 16` keep that vocabulary out of customer view.
- All figures are placeholder, including the landing's `1000+`, `99.9%` and `50+`.
  The footer of each file carries a "visual prototype" badge for this reason.

Every colour is a CSS custom property in `:root`, and each divergence from the frozen
palette is commented beside the token with its frozen value, so switching a prototype
onto the real tokens is one block of edits.

## What to take from here

The layout, density, rhythm, glass and motion vocabulary, and the brand assets.
Not the navigation, not the metrics, not the status names, not the copy.

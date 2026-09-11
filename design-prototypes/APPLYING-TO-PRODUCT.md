# Applying the prototypes to the product

How the visual work in `design-prototypes/` reaches `packages/ui` and `apps/app`
without touching a frozen document or weakening a gate.

Read `design-prototypes/README.md` first. It lists the deliberate divergences.

---

## 1. Order of work

**Content correctness first, visual refinement second.** Restyling a screen that
shows the wrong metrics just produces a prettier wrong screen. Fix what each screen
says, then how it looks.

## 2. Content mapping — prototype element → what it actually becomes

| In the prototype | In the product | Authority |
|---|---|---|
| Sidebar: Overview, Settlements, Liquidity, Counterparties, Reconciliation, Developers, Settings | Overview, Settlements, Beneficiaries, Batches, Developers. Settings lives under account/workspace controls, not primary nav | `PRODUCT.md § 12` |
| Overview tiles: Total Settlement Volume, Active Corridors, Success Rate, Average Settlement Time | **Available to settle** (only when a facility is active), **In flight**, **Settled today**, **Needs attention** | `§ 12.1` |
| Delta chips on every tile (+12%, −62% vs industry average) | Removed. `MetricTile` takes no sparkline and no delta chip unless the delta is actionable | `DESIGN_SYSTEM.md § 5` |
| Featured Corridor card, Quick Actions grid, Liquidity & Treasury card, Reconciliation & Audit card | Removed. Below the metrics: active settlements and open exceptions. No decorative charts, no vanity metrics, no "welcome back" hero | `§ 12.1` |
| "Good morning, Rohit" + marketing subtitle | Removed | `§ 12.1` |
| Status pills: Settled, Processing, Ready, Action required, Failed | READY, SETTLING, SETTLED, ACTION_REQUIRED, CANCELLED. A failure projects to CANCELLED with a stated `resolution`; there is no sixth state | `§ 6`, decision `D-03` |
| Status colours: green Ready, blue Processing | READY `#33465F` on `#F1F3F6`; SETTLING saffron `#9C5808` on `#FDF4E7`; SETTLED teal `#0A6B55` on `#E9F5F1`. Dot **plus** label, always | `§ 2.4`, `§ 7` |
| Corridor column: INR → USDC/USDT/EURC/AED | The V1 product is Global → India. Funding currency in, exact ₹ to an Indian beneficiary out | `PRODUCT.md § 2` |
| Detail panel tiles: Routing INR→USDC, Settlement Network USDC (Ethereum), Tx hash, View on Explorer, "On-chain + partner liquidity" | Out of the primary reading path entirely. Header carries three things — the ₹ amount, the beneficiary, the customer-facing status. Then the Ready → Settling → Settled progression as the primary visual. Technical detail collapsed by default and, expanded, in plain language: `Settlement ready`, `Liquidity secured`, `INR payout confirmed · UTR …`, `Reconciled · ₹X expected · ₹X observed` | `§ 4`, `§ 12.3`, `§ 16` |
| — (missing in the prototype) | **Cancel settlement** above the fold while the settlement is still cancellable, stating what cancelling does; replaced by one line explaining why once the payout has been sent. **Return notice** above the fold when it applies, read first, with the settlement still reading SETTLED beside it | `§ 12.3` |
| All figures | Real view-model data. Every number in the prototype is placeholder | — |

## 3. What crosses visually, and what does not

**Crosses — anatomy and density.** The shell (sidebar, top bar with ⌘K search,
filter toolbar with the primary action on the right, dense table, right-hand detail
drawer instead of a separate page). Row height, cell padding, label sizes, the
uppercase letterspaced micro-labels, the 1px hairlines doing the structural work,
the generous white space. The drawer pattern itself — it keeps the list context.
The real brand assets in `design-prototypes/brand/`.

**Does not cross — the atmosphere.** Ambient light ribbons in the app chrome, the
dotted world map, the city silhouette in the sidebar, glass panels with backdrop
blur, layered soft shadows, gradient washes, the "INDIA TO THE WORLD" and "LIQUIDITY
CONNECTS OPPORTUNITIES" marketing lines.

Why, specifically:

- `DESIGN_SYSTEM.md § 1.3` — depth comes from typography and spacing, not from
  shadows, gradients or glass.
- `§ 11` — glassmorphism beyond a single subtle overlay scrim is prohibited, as is
  stock photography of skylines and India-flag decoration.
- `§ 2.3` — the saffron→teal gradient has a closed list of permitted uses: the logo
  lockup, the settlement progress rail as it completes, a 2px rule at the top of the
  settlement receipt, and the brand signature on marketing surfaces. Ambient ribbons
  in the application chrome are not on that list.
- `§ 16` — the brand signature *INR ↔ STABLECOINS • GLOBAL SETTLEMENTS* lives on the
  site, the deck, the login and the footer. It is not product UI copy, so the
  sidebar lockup uses the mark and wordmark without the signature line.

**Motion** crosses only within `§ 6`: the seven permitted animations, nothing over
400ms, nothing looping, nothing moving while a number is being read, and
`prefers-reduced-motion` collapsing every transition. The landing's drifting ribbons,
travelling pulses, scroll parallax, count-ups and hover lifts on cards are marketing
motion and stay in the landing repository.

## 4. Where the code goes

- Every visual change lands in `packages/ui`. Nothing styled ad hoc inside
  `apps/app` — a component that exists in an app but not in `packages/ui` is a bug
  (`§ 12`).
- Values come from `tokens.ts` only. No raw hex, no raw pixel values in components;
  `check-styles.mjs` rejects a `var()` that the tokens do not emit, a class with no
  rule, two components on one block, and a breakpoint outside `§ 8`.
- Every component and every screen keeps all five states from `§ 10`
  (`screens.test.ts` enforces it on screens).
- `accessibility.test.tsx` runs axe against the composed screens with the real CSS.
  Note that the prototype's micro-labels sit around `#93A1B2` on white — roughly
  2.6:1 — which is fine for decorative marketing text and fails `§ 7` as product
  content. Anything carrying meaning uses `--ink-muted` or darker.
- `check-liquidity-copy.mjs` rejects balance / wallet / credit / facility in
  customer-facing strings. `§ 16` also bars drawdown, reservation, prefunding,
  stablecoin, USDT liquidity, provider and internal state names.
- **Do not weaken a gate to let something through.** Each gate has a test proving it
  rejects the specific defect it was written against.

## 5. What needs a founder decision, not an implementation choice

Stop and ask if any of these come up. Each is a revision of a frozen document, which
means a new revision note and a new SHA-256 manifest:

1. A new token — a colour, an elevation level, a radius, a motion duration — that
   `tokens.ts` does not already emit. Express the look with existing tokens, or list
   what is missing and stop.
2. Any softening of `§ 1.3` or `§ 11` to allow more of the prototype's material
   language (glass, layered shadows, gradient surfaces) inside the product.
3. Any addition to the closed gradient list in `§ 2.3`.
4. A sixth primary navigation item, a fifth Overview metric, or a sixth
   customer-facing state.
5. A new primitive that is not in the `§ 5` catalogue.

## 6. Sequence, and the Alex test

Restyling the five screens is Stage 10 work — it does not open a new stage. But it
changes what a test subject sees, so:

1. Restyle and correct the screens inside Stage 10.
2. **Then** run the Alex test once, against the finished screens.
3. Record the result in `docs/ALEX_TEST_RECORD.md` and close Stage 10.
4. Stage 10.5 — the app shell: entry point, router, HTTP client to `/v1` with
   view-model mapping, browser session, error boundaries, loading and network
   failure states, build and hosting.
5. Stage 11 — provider integrations.

An Alex test run before the restyle is invalidated by it. Do not run it early.

The landing lives in its own repository. Do not add Framer Motion, marketing
dependencies or landing routes to this monorepo.

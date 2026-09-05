# DESIGN_SYSTEM.md

Status: **Stage 0 — Revision 4 · FROZEN 2026-09-01 · accessibility correction**
Depends on: `PRODUCT.md`

The quality benchmark is Stripe, Modern Treasury, Airwallex and Linear-level
interaction polish. Benchmark, not reference: nothing here copies their visual
language.

---

## 1. Principles

1. **The number is the interface.** On every screen there is one figure that
   matters most. It gets the most space, the most weight and the most contrast,
   and nothing competes with it.
2. **Restraint reads as trust.** A financial product earns confidence by being
   quiet. Colour is used for meaning, never for decoration.
3. **Hierarchy over ornament.** Depth comes from typography and spacing, not from
   shadows, gradients or glass.
4. **Every colour means something.** If a colour appears with no semantic job,
   remove it.
5. **Motion explains state.** An animation that does not explain state or improve
   perceived responsiveness is deleted.

## 2. Colour

### 2.1 Foundation

| Token | Value | Use |
|---|---|---|
| `--bg-base` | `#FBFBF9` | Application background, off-white and slightly warm |
| `--bg-surface` | `#FFFFFF` | Cards, tables, panels |
| `--bg-sunken` | `#F5F5F2` | Inset areas, code blocks, table headers |
| `--bg-hover` | `#F2F3F5` | Row and control hover |
| `--border` | `#E5E7EB` | The 1px line that does most of the structural work |
| `--border-strong` | `#D3D7DE` | Input borders, dividers that must read |

### 2.2 Ink

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0A1A2F` | Deep navy. Primary type, amounts, headings |
| `--ink-secondary` | `#33465F` | Secondary type, labels with content |
| `--ink-muted` | `#6B7B90` | Metadata, timestamps, helper text |
| `--ink-disabled` | `#9AA6B5` | Disabled only. Never for real content |
| `--ink-inverse` | `#FFFFFF` | Type on filled surfaces |

### 2.3 Brand accent

The saffron → teal accent is the brand's, and it is also the product's core
semantic: **settling → settled**. That is why it earns its place, and it is the
only place the two hues appear together.

| Token | Value |
|---|---|
| `--accent-saffron` | `#E8871E` |
| `--accent-saffron-deep` | `#C46B0F` |
| `--accent-teal` | `#0E8A6E` |
| `--accent-teal-deep` | `#0A6B55` |
| `--accent-gradient` | `linear-gradient(90deg, #E8871E 0%, #0E8A6E 100%)` |

**The gradient is an accent, never a background.** Its total permitted uses:
the logo lockup, the settlement progress rail as it completes, a 2px rule at the
top of the settlement receipt, and the brand signature on marketing surfaces.
Nowhere else.

### 2.4 Semantic status

Each customer-facing status has exactly one colour pair, used everywhere it
appears.

| Status | Dot / text | Surface | Meaning |
|---|---|---|---|
| `READY` | `#33465F` | `#F1F3F6` | Nothing is happening yet, nothing is wrong |
| `SETTLING` | `#9C5808` | `#FDF4E7` | In motion. Saffron. |
| `SETTLED` | `#0A6B55` | `#E9F5F1` | Complete. Teal. |
| `ACTION_REQUIRED` | `#B42318` | `#FEF3F2` | You must do one specific thing |
| `CANCELLED` | `#5F6E82` | `#F5F5F2` | Terminal, no delivery |

`ACTION_REQUIRED` is red because it needs the customer, not because something
broke. The copy carries that distinction — see `PRODUCT.md § 7.1`.

**Revision 4 — accessibility correction.** Two foreground values changed:
`SETTLING` from `#B36A0C` (3.87:1) to `#9C5808` (5.05:1), and `CANCELLED` from
`#6B7B90` (3.96:1) to `#5F6E82` (4.76:1). As originally specified both failed
the 4.5:1 requirement that § 7 of this document sets. Hue and semantic role are
unchanged; each foreground is darkened only far enough to pass. A contrast test
over the tokens now pins all five pairs, so a regression fails the build rather
than shipping. **No product, domain or architecture change is implied or
made.**

**No status is encoded by colour alone.** Every status renders as a dot *plus* a
text label, always.

### 2.5 Dark mode

The product is light. A dark mode is not V1. If it is ever built it must be a
designed palette with its own contrast decisions, never a programmatic
inversion — and it must not drift toward the crypto-dark aesthetic this product
deliberately rejects.

## 3. Typography

**UI:** Inter (variable), with the system stack as fallback.
**Mono:** JetBrains Mono — IDs, UTRs, IFSC, API keys, JSON, code.

Global: `font-feature-settings: 'tnum' 1, 'ss01' 1;` — **tabular numerals are on
by default everywhere**. In a settlement product, digits must align in every
column, every list and every total, without anyone remembering to ask.

| Token | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|
| `display-xl` | 48 / 52 | 600 | −0.022em | The settlement amount on detail |
| `display-l` | 36 / 40 | 600 | −0.020em | *Recipient gets* on the quote |
| `display-m` | 28 / 34 | 600 | −0.016em | Overview metric values |
| `h1` | 24 / 32 | 600 | −0.011em | Page titles |
| `h2` | 20 / 28 | 600 | −0.008em | Section headings |
| `h3` | 16 / 24 | 600 | 0 | Card headings |
| `body` | 14 / 20 | 400 | 0 | Default |
| `body-strong` | 14 / 20 | 550 | 0 | Emphasis in body |
| `body-sm` | 13 / 18 | 400 | 0 | Table cells, secondary |
| `label` | 12 / 16 | 560 | +0.04em | Uppercase field and metric labels |
| `caption` | 12 / 16 | 400 | 0 | Timestamps, helper text |
| `mono` | 13 / 20 | 400 | 0 | IDs, references |
| `mono-sm` | 12 / 18 | 400 | 0 | Dense technical detail |

### 3.1 Rendering money

- The ₹ symbol renders at `0.72em` of the figure, baseline-aligned, with 0.08em
  of space after it. At `display-xl` this is what stops the symbol overwhelming
  the number.
- Customer surfaces use the symbol: **₹5,000,000.00**. The string `INR` appears
  only in mono contexts — API payloads, logs, exports.
- Digit grouping follows the workspace's `number_format` setting: `international`
  (default) or `indian` (`₹50,00,000.00`). The setting applies everywhere at
  once; the two groupings never appear on the same screen.
- Trailing paise are always shown on receipts and detail views, and may be
  suppressed only in dense list views where the value is exactly `.00`.
- Amounts never wrap and never truncate. If a container cannot hold the figure,
  the container is wrong.

## 4. Space, radius, elevation

**Base 4px.** Scale: `2 4 6 8 12 16 20 24 32 40 48 64 80`.

Radius: `--r-sm 4` (inputs, chips) · `--r-md 6` (buttons) · `--r-lg 8` (cards,
panels) · `--r-xl 12` (modals) · pill `999` — pills are reserved for status and
count badges only; the master prompt's warning about excessive pills is a rule
here.

Elevation, deliberately shallow:

```
--shadow-sm: 0 1px 2px rgba(10, 26, 47, 0.04);
--shadow-md: 0 4px 12px rgba(10, 26, 47, 0.06);
--shadow-lg: 0 12px 32px rgba(10, 26, 47, 0.10);   /* overlays only */
```

Cards use a 1px border and no shadow by default. Shadow is reserved for things
that genuinely float: menus, popovers, modals, the sticky quote summary when it
detaches.

Layout: 12-column grid, 24px gutters, content max 1280px, detail pages max
960px for readability. Desktop-first.

## 5. Components

**Primitives.** Button (primary, secondary, ghost, destructive) · IconButton ·
Input · AmountInput · Select · Combobox · DatePicker · Checkbox · Radio ·
Switch · Textarea · FileDrop · Tooltip · Popover · Modal · Drawer · Toast ·
Tabs · Breadcrumb · Skeleton · Spinner · Divider.

**Domain components** — the ones that carry the product:

| Component | Notes |
|---|---|
| `AmountDisplay` | Renders `Money`. Never accepts a number. Handles symbol sizing, grouping, tabular alignment. |
| `AmountInput` | INR entry. `inputmode="decimal"`, no spinners, paste-tolerant (strips ₹, commas, spaces, non-breaking spaces). Never reformats mid-keystroke. |
| `StatusIndicator` | Dot + label. The single source of status rendering. |
| `SettlementProgress` | Ready → Settling → Settled rail. The completed portion carries the accent gradient. |
| `QuoteSummary` | Recipient-first. Sticky. The recipient figure morphs on change. |
| `RequirementCard` | Title, detail, one action button. Cannot render without all three. |
| `BeneficiaryPicker` | Search-first combobox, shows destination summary and verification state inline. |
| `Reference` | Monospace ID with a copy affordance on hover and on focus. |
| `EventRow` | Developer event log row; new rows insert with the motion in §6. |
| `ReceiptDocument` | The canonical receipt. One template for UI and PDF (`INV-29`). |
| `MetricTile` | Overview only. Label, value, and one line of context. No sparkline, no delta chip unless the delta is actionable. |
| `EmptyState` | Title, one sentence, one action. No illustrations. |

**Tables** are the product's workhorse: 44px rows, 13px body, sticky header,
right-aligned tabular amounts, monospace references, status as dot + label,
row hover `--bg-hover`, whole row clickable with a real focus ring, and a
loading state of skeleton rows at the same height so nothing shifts.

## 6. Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `--motion-micro` | 120ms | `cubic-bezier(0.2, 0, 0, 1)` | Hover, focus, checkbox |
| `--motion-standard` | 180ms | `cubic-bezier(0.2, 0, 0, 1)` | Panels, disclosure, tabs |
| `--motion-enter` | 240ms | `cubic-bezier(0.2, 0, 0, 1)` | Modal, drawer, toast |
| `--motion-exit` | 160ms | `cubic-bezier(0.4, 0, 1, 1)` | Everything leaving |
| `--motion-amount` | 320ms | `cubic-bezier(0.2, 0, 0, 1)` | Amount morph |

The permitted animations, and nothing else:

- **Amount morph** — when a quote re-prices, digits transition in place. The
  figure never blanks and re-renders; that reads as uncertainty about money.
- **Status progression** — the rail fills from saffron to teal as the settlement
  advances. 320ms, once, on state change.
- **Liquidity reservation feedback** — a single restrained confirmation on the
  *Available to settle* figure when it decreases. It is the only feedback the
  customer gets for a mechanic they never see.
- **Event log insertion** — new rows slide 4px and fade in over 180ms. No bounce.
- **Skeleton loading** — a shimmer no faster than 1.4s, matching final layout so
  content never shifts.
- **Hover and focus** — 120ms, colour and border only, never scale.
- **Settled confirmation** — the status indicator transitions to teal, once,
  240ms. That is the entire celebration.

Explicitly banned: confetti, checkmark explosions, particle systems, parallax,
cinematic sequences, looping ambient motion, anything longer than 400ms,
and anything that moves while the user is reading a number.

`prefers-reduced-motion: reduce` collapses every transition to opacity-only or
instant. The amount morph becomes an instant swap. Nothing is left in motion.

## 7. Accessibility

Target: **WCAG 2.2 AA**, verified in CI on the token pairs and in review on the
composed screens.

- Contrast: 4.5:1 for body, 3:1 for large text and UI boundaries. Every semantic
  pair in §2.4 is checked against its surface.
- Status is never colour alone — dot **plus** label, always (§2.4).
- Focus: 2px ring in `--accent-teal-deep` at 2px offset, on every interactive
  element, never removed. Keyboard focus is as visible as hover.
- The entire New Settlement flow is completable by keyboard, including the
  beneficiary combobox and the authorize action.
- Status changes are announced through a polite live region.
- Minimum target 24×24px; 44×44px on touch.
- Amount inputs are labelled, describe their currency, and announce validation
  errors by association, not by colour.
- Icons that carry meaning have accessible names; decorative icons are hidden.
- Motion respects `prefers-reduced-motion`; nothing depends on animation to be
  understood.

## 8. Responsive

Desktop-first, because this is an operations tool.

| Breakpoint | Behaviour |
|---|---|
| `≥1280px` | Full layout: sidebar nav, tables at full width, sticky quote summary |
| `1024–1279px` | Sidebar collapses to icons; tables drop low-priority columns |
| `768–1023px` | Single column; tables become stacked rows keyed by amount and beneficiary |
| `<768px` | **Monitoring experience** |

On mobile the product does four things well: see what is moving, see what needs
attention, open a settlement, and authorize one. Creating a batch, managing API
keys and CSV import are desktop tasks and say so plainly rather than degrading.

## 9. Iconography

One 20px line set, 1.5px stroke, square caps, no fills — except the status dot,
which is the only filled mark in the system. Icons never carry meaning alone.
No emoji anywhere in the product. No illustration in empty states; a sentence
does the work.

## 10. States every component must define

No component is complete until all five exist and are reviewed:

1. **Default**
2. **Loading** — skeleton at the final dimensions; never a spinner over content,
   never a layout shift.
3. **Empty** — title, one sentence, one action. Says what to do, not that there
   is nothing.
4. **Error** — specific and actionable, following the copy rule in
   `PRODUCT.md § 7.1`. "Something went wrong" is not shippable.
5. **Disabled** — with a reason available on focus or hover. A disabled control
   that does not say why is a bug.

## 11. Prohibited

Generic crypto dark UI · neon · glassmorphism beyond a single subtle overlay
scrim · glowing coins · 3D token or USDT assets · India flag decoration
(the saffron→teal accent is semantic, and it never becomes a flag) · dashboards
full of charts · vanity metrics · excessive pills · playful gamification ·
mascots · progress bars that do not track real progress · meaningless AI visual
patterns · stock photography of handshakes, globes or skylines.

## 12. Delivery

Tokens are the source of truth, authored once and exported to CSS custom
properties and a typed TypeScript object. Components live in `packages/ui`,
documented in Storybook with all five states from §10, and covered by visual
regression tests. A component that exists in an app but not in `packages/ui` is
a bug to be closed, not a shortcut to be kept.

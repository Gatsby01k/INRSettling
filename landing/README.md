# INRSettle — marketing site

The public marketing site, in `landing/` inside the product repository. Static
HTML, CSS and vanilla JavaScript, plus a Node inquiry endpoint with no third-party
runtime dependencies. `landing/public/` is the web root.

Use the **repository root** as the Vercel Root Directory so the inquiry endpoint
and workspace access middleware are included. See `DEPLOY.md`.

## Run it

```bash
node landing/scripts/serve-site.mjs
```

Then http://localhost:8080/. Serve it — opening the file from disk breaks the
absolute `/assets/…` paths.

## Layout

```
landing/
  public/
    index.html          the page: semantic markup, inline icon sprite, dialogs
    styles.css          tokens in :root, layout, motion
    app.js              navigation, role tabs, settlement walkthrough, dialogs
    market.js           business scenarios, corridor discovery and inquiry handoff
    planner-picker.js   keyboard-operable selection grids with currency artwork
    settlement-planner.js  validated discovery selections and downloadable briefs
    hero-flow.js        travelling light trails along the original ribbon curves
    assets/             fonts, brand marks, three background renders, icons
  scripts/
    set-app-url.mjs     repoints the Explore App link
    serve-site.mjs      local website and inquiry endpoint preview
  brand/                originals, kept out of the web root on purpose
  DEPLOY.md             push, Vercel project, DNS, end-to-end checklist
```

## What changed relative to the v6 archive

The v6 export supplies the original visual system and brand assets. Two asset
optimizations were made on import, both reversible from `brand/`:

1. **Brand assets re-encoded at render resolution.** The four brand files are PNG
   artwork inside an SVG viewport wrapper, and they shipped embedding the full
   1254px original — the favicon alone was 859 KB. Wrappers, `viewBox` values and
   filenames are untouched; only the embedded raster was resized to what the
   largest on-screen use needs. `assets/` went from 2.8 MB to 1.0 MB, the favicon
   from 859 KB to 19 KB.
2. **Icon fallbacks added.** An SVG favicon alone leaves Safari and older Windows
   without an icon, so `favicon.ico` and `icon-180.png` were generated from the
   original artwork and linked in the head. `icon-512.png` is there for a future
   web app manifest.

## Typography

The page loads `assets/regular.otf` and `assets/bold.otf` as the family `INRSans`.
Those files are **Nimbus Sans** by (URW)++ — the Helvetica clone — under AGPL-3
with the font exception. `assets/font-license.txt` must keep travelling with them.

The frozen product design system specifies Inter for UI type (`DESIGN_SYSTEM.md
§ 3`). The site is on Nimbus Sans, which is a marketing divergence that was never
written down. If a licensed brand face is ever bought, this is where it changes.

## Scope

Real payments, banking providers, authentication, account creation and production
APIs are outside this directory. The settlement walkthrough on the page is a local
demonstration and initiates no financial transaction. Dashboard and corridor data
are illustrative; the hero cards describe settlement capabilities. The inquiry
endpoint is separate from the product API — see `DEPLOY.md`.


## Brand-preserving landing enhancement

The original typography, glass surfaces, navigation, scene and hero statement
**Cross-border settlement infrastructure for India** are retained. Travelling light trails follow the original gold and mint ribbons; a Pause control, reduced-motion
handling, hidden-tab and offscreen pause keep the effect optional. The five
original capability cards use factual descriptions instead of invented scale
figures. The positioning stays cross-border settlement infrastructure for India.

Five business scenarios, an India ↔ World discovery guide, operating controls,
integration steps and FAQ add concrete buyer detail. The guide generates a route
brief for download or inquiry context; it never creates a quote or payment.
Selected workflow context is delivered separately from the visitor's message.
Inquiry topics and walkthrough currencies use visible radio cards; the landing
has no remaining platform-native select menus. Native radio semantics preserve
keyboard selection, form values and reset behaviour. The separate workspace
already enhances its filters and form selects with branded choice controls.
See [RESEARCH.md](RESEARCH.md) for primary market references and claim boundaries,
and [brand/image-cleanup.md](brand/image-cleanup.md) for backdrop cleanup prompts.

To preview the website including the inquiry endpoint, use Node 24+:

```sh
node landing/scripts/serve-site.mjs
```

Online inquiry delivery supports **@inrslead_bot → the owner's personal chat** or
**info@inrsettle.com** via Resend. `CONTACT_DELIVERY=telegram` uses server-only
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and canonical `SITE_URL` settings.
`CONTACT_DELIVERY=email` uses `RESEND_API_KEY` and a verified `CONTACT_FROM`.
Only the selected channel is used; copies to both channels are not enabled.
Until the selected channel is configured, the contact dialog explicitly opens
an email draft for the visitor to review and send. Success requires a provider
acknowledgement. See [TELEGRAM.md](TELEGRAM.md) for personal-chat setup.

The endpoint and middleware live at the repository root. A Vercel deployment
using the endpoint must use the repository root, not `landing`, as Root Directory.
Configure deployment-level abuse rate limiting and delivery monitoring;
the in-memory guard covers only one warm function instance. Confirm delivery to
the real recipient before announcing online inquiry submission. No credentials or
production deployment access were supplied for this change.

The hero emblem and scene are static: no pointer parallax or lens sweep. Canvas
light trails travel at a constant distance along the ribbon curves, with tapered
tails, bloom and a finer parallel strand. The frame loop stops when paused,
offscreen or inactive. The planner uses custom selection grids, real currency
artwork and separate currency labels. The flow diagram uses a vector INR mark,
the existing USDT/USDC assets and a globe with transfer arrows. Currency artwork
credits remain in `public/assets/currencies/LICENSE.txt`.

# INRSettle landing and product workspace

A dependency-free implementation of the supplied visual reference. The complete site is in `dist/` and can be served by any static web server.

## Included

- The reference's seven-part composition, typography, glass surfaces and saffron/teal palette.
- Three original background renders, supplied as optimized local WebP assets.
- Responsive navigation, keyboard-operated business-role tabs, settlement-flow controls and feature dialogs.
- Interactive product preview with overview, chart controls, searchable settlements, liquidity, counterparties, corridors and downloadable CSV reports.
- A three-stage settlement walkthrough with editable sample amount and funding currency.
- A locally prepared contact brief with download and copy actions. No form submission service is connected.
- Reduced-motion and higher-contrast preferences, native accessible dialogs, focus management and lazy loading.
- Desktop proportions calibrated to the 1122px reference, with a narrower header, compact section rhythm, city-backed product display and glass insight tile.
- The latest supplied original emblem and wordmark throughout the header, hero, settlement flow, dashboard, dialogs, footer and favicon. SVG viewport wrappers embed the original PNG bytes without redrawing or recoloring the logo.
- A layered hero using a cleared glass scene, the exact brand emblem, restrained independent parallax, a lens highlight and pedestal signature.

## Data and integration boundary

Marketing figures reproduce the supplied reference and are labelled illustrative. Dashboard data, business names, routes and the API snippet are illustrative. The walkthrough does not initiate payments. Replace these with approved product information before any public commercial launch.

The contact form prepares a text brief locally. It neither transmits nor persists personal information. Real inquiry delivery, account creation, banking providers, authentication and production APIs are outside this landing's scope.

## Files

- `dist/index.html`: semantic page, reusable icons and dialogs.
- `dist/styles.css`: shared tokens, responsive layouts and motion.
- `dist/app.js`: local interaction and illustrative product data.
- `dist/assets/`: optimized imagery, original brand PNGs and viewport wrappers, local fonts, favicon and font license.
- `dist/app/index.html`: standalone product workspace entered from the landing's Get Started buttons.
- `dist/app/workspace.css`: app-specific responsive glass interface, sidebar, tables, detail panel and dialogs.
- `dist/app/workspace.js`: navigation, overview, settlements, liquidity, counterparties, reconciliation, developers, settings and local interaction flows.
- `dist/app/data.js`: illustrative records, search/filter rules, formatting, quote estimates and CSV generation.

## Product workspace

The `/app/` entry opens Overview. Hash routes select the seven sections without a server router. Overview and Settlements follow the supplied application references, including the branded sidebar, four summary cards, featured corridor, quick actions, liquidity and reconciliation summaries, settlement filters, selectable table rows and detailed timeline. The other sections extend this same system.

All actions are local demonstrations: search, status/corridor/currency/date filters, sorting, selection, pagination, exports, sample settlement creation, counterparty review, liquidity previews and settings. The settlement creation flow preserves a draft while moving back and forward, uses explicit preflight feedback and adds a reviewable sample record. Records and profile changes last for the current page session; only notification preferences are stored on the current device. No payment, screening, account authentication or financial provider is connected. Reports are labelled as demo records, not payment evidence.

The latest uploaded logos are byte-identical to the existing original brand assets; the app reuses them unchanged. Background imagery is reused from the landing. All assets are local.

### Product refinement

- Readable paired amounts and dates in settlement rows, consistent spacing and status colors, precise decimal amounts, contextual row actions and accessible mixed-state selection.
- A single detail drawer on narrow layouts, with no duplicate inline panel; direct links open the matching record and page after clearing incompatible filters.
- Timelines are derived per record with ordered timestamps, correct failed/blocked/ready states, and the correct fiat or blockchain payout rail.
- Create Similar and counterparty entry preserve the transfer direction. The form supports both existing inbound and outbound corridors, shows its illustrative rate, and retains the draft through preflight and beneficiary review.
- Monthly settlement and audit exports now contain the data their labels describe. Form controls use explicit button types and accessible labels.

## Validation

Run `node --check dist/app.js`, `node --check dist/app/workspace.js`, `node --check dist/app/data.js` and `node --test tests/workspace-data.test.mjs`. All assets are local, with no runtime third-party dependencies. Plain static output requires no compilation step. Browser testing was not requested; verification is limited to source, data logic, template structure and local references.

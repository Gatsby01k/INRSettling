# INRSettle — marketing site

The public marketing site, in `landing/` inside the product repository. Static
HTML, CSS and vanilla JavaScript, no build step, no runtime dependencies.
`landing/public/` is the web root.

It deploys as its own Vercel project with **Root Directory = `landing`**, so it
releases independently of the product even though it shares this repository. See
`DEPLOY.md`.

## Run it

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory landing/public
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
    assets/             fonts, brand marks, three background renders, icons
  scripts/
    set-app-url.mjs     repoints the four Get Started / Open App links
  brand/                originals, kept out of the web root on purpose
  DEPLOY.md             push, Vercel project, DNS, end-to-end checklist
```

## What changed relative to the v6 archive

The page markup, styles and behaviour are the v6 export unchanged. Two things were
done on the way in, both reversible from `brand/`:

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
demonstration and initiates nothing. Every figure on the page reproduces the design
reference and is labelled illustrative — see the last section of `DEPLOY.md`.

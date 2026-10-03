# Search appearance and indexing

## Audit — 2 October 2026

Direct public HTTP requests confirmed the following production responses before
this change. Search results are observations of indexed/cached content, not a
Search Console report or a measurement of rankings.

| URL | Observed response | Change |
| --- | --- | --- |
| `https://www.inrsettle.com/` | 200; title and description, no canonical or social metadata | Canonical, unique metadata, WebSite/Organization/WebPage JSON-LD and sharing card |
| `/robots.txt` | 404 | Public crawl policy and sitemap discovery |
| `/sitemap.xml` | 404 | Seven canonical public page URLs |
| `/developers` | 404; older content still appeared in search | Restore a public integration overview |
| `/docs` | 404; older content still appeared in search | Restore a public workflow guide |
| `/docs/integration` | 404; older content still appeared in search | Restore a relevant provider integration guide |
| `/security` | 404; older content still appeared in search | Restore a page explaining the product model and preview boundaries |
| `/docs/reconciliation.html` | Historical 404 confirmed in Search Console | Restore `/docs/reconciliation` and normalize the old HTML URL |
| `/legal/privacy.html`, `/contact.html` | Historical 404s confirmed in Search Console | Permanent redirects to inquiry privacy and the inquiry dialog |
| `/app` | 401 with an access-code gate and noindex | Keep the gate; add noindex to static workspace HTML and headers even when the gate is disabled |

The existing homepage renders its text in static HTML, has one H1, a language,
responsive styles, local fonts, sized images, high-priority hero loading and lazy
loading for lower-page imagery. Those foundations are preserved. Illustrative
dashboard and walkthrough content is marked `data-nosnippet` so sample amounts
are not presented as business performance in Google snippets.

## Sources and regeneration

- Canonical origin, titles, descriptions and public page copy:
  `landing/content/pages.mjs`.
- Owner-provided LinkedIn, X and Telegram profiles live in `socialProfiles` in
  that same file. The build uses them for every public footer and Organization
  `sameAs`; `twitterHandle` identifies the official account in sharing metadata.
- Build: `node landing/scripts/build-seo.mjs` or `pnpm build:seo`. It regenerates
  the homepage SEO and footer blocks, resource HTML, sitemap and robots.txt deterministically.
- Footer layout and social icons are shared by all public pages through the SEO
  generator and `landing/public/footer.css`.
- Public resource styles: `landing/public/resources.css`. The resource pages are
  readable without JavaScript and link into the existing inquiry dialog.
- Sharing artwork source: `landing/brand/seo-share.svg`. It reuses the brand marks
  and renders to `landing/public/assets/seo-share-20261002.png` (1200 × 630).
  To regenerate, run `node landing/scripts/render-share.mjs` with Sharp available,
  or pass the path of an installed Sharp module as its first argument. Sharp is
  an optional authoring dependency, never a production build dependency.
- When changing the sharing artwork, use a new filename and update `shareImage`:
  `/assets/*` has an immutable one-year cache.
- Avoid fabricated ratings, prices, certifications, banking relationships and
  regulatory approvals. No FAQ rich-result eligibility or site-search action is
  claimed. Add social profile `sameAs` URLs only after ownership is confirmed.

The root Vercel configuration is authoritative for the full deployment. Static
fallback configurations are also updated. Set the root build command to
`node landing/scripts/build-seo.mjs` if a Vercel dashboard override is present.
The apex redirect matches only `inrsettle.com`, so local and preview hosts are
usable. Do not replace missing routes with a blanket 200 homepage rewrite.

`robots.txt` deliberately allows crawling of `/app`: a crawler must receive its
noindex directive to remove it from results. Access control remains independent
of indexing. The sitemap excludes the workspace, API, fragments and preview
hosts. No artificial `lastmod` values are generated.

## Verification

```sh
node landing/scripts/build-seo.mjs
node --test 'landing/tests/*.test.mjs'
```

SEO regression tests request the actual local HTTP server and verify canonical
HTML, structured data, sitemap contents, PNG dimensions, internal links and
fragments, permanent duplicate-URL redirects, real 404s and noindex without a
configured access code. Vercel configuration checks cover domain-path preservation
and workspace headers. Legacy redirect checks preserve query parameters and contact
fragments. With Vercel `cleanUrls`, custom redirect sources omit `.html`; verify
the original HTML URLs on the deployed preview too. Local tests do not emulate the Vercel edge; confirm its
headers and redirects on the deployed preview before merging.

## Owner handoff after publication

1. In [Google Search Console](https://search.google.com/search-console), reuse the
   existing verified Domain property for `inrsettle.com`. Existing authenticated
   access was confirmed during this audit; no new verification is needed.
2. Resubmit the existing `https://www.inrsettle.com/sitemap.xml` entry after it
   returns the new XML. Inspect the homepage and restored public URLs; check
   crawl permission, rendered HTML and the selected
   canonical. Request indexing once the deployed responses are correct.
3. Validate the structured data with
   [Google’s Rich Results Test](https://search.google.com/test/rich-results).
   Organization and site identity markup describe the brand; appearance remains
   subject to Google’s eligibility and selection rules.
4. Inspect Page Indexing for the previous 404s, the homepage canonical and unwanted app URLs. Do not
   block a URL in robots.txt before its noindex can be read. Check that preview
   deployments return noindex and do not appear in the production sitemap.
   Redirect and alternate-canonical exclusions are usually expected. Review old
   discovered URLs individually: restore useful content or redirect to a true
   equivalent, and retain a real 404 for retired pages without an equivalent.
   Legal terms, compliance assurances and a service-status page need business-
   approved content and an actual operational source before publication.
5. Add or reuse a verified site in
   [Bing Webmaster Tools](https://www.bing.com/webmasters) and submit the same
   sitemap. Use the canonical website URL consistently in verified company
   profiles, including LinkedIn.
6. Review Search Console query/page performance after recrawling: branded
   queries, India settlement infrastructure, India payout workflows, stablecoin
   settlement workflows and settlement integration. These are themes to
   evaluate, not claims of measured keyword demand. Use actual impressions and
   inquiries to prioritize further content.
7. Run mobile PageSpeed Insights and monitor real-user Core Web Vitals after
   deployment. No Lighthouse score, search position, search traffic gain or
   rich-result appearance has been measured or guaranteed by this change.

Google can choose a different title or snippet and needs time to recrawl. These
changes make pages discoverable, consistent and technically ready; competitive
rankings also depend on useful content, verified business information and
relevant external references.

## Primary guidance

- [Site names](https://developers.google.com/search/docs/appearance/site-names)
- [Organization structured data](https://developers.google.com/search/docs/appearance/structured-data/organization)
- [Titles](https://developers.google.com/search/docs/appearance/title-link)
- [Snippets and data-nosnippet](https://developers.google.com/search/docs/appearance/snippet)
- [Robots meta and X-Robots-Tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)
- [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json)

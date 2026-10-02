# Deploying the site

One Vercel project, one domain, one repository. The site is `landing/public/`
and the demo workspace is `landing/public/app/` inside it, so `/` and `/app/` come
from the same deployment.

The repository root carries a `vercel.json` pointing `outputDirectory` at
`landing/public` with installation disabled and a dependency-free SEO build, so importing this
repository with **default settings** serves the site. The inquiry endpoint and
workspace middleware are at the repository root, so keep Root Directory there.
A static-only deployment from `landing` excludes both server features.

The production canonical origin is `https://www.inrsettle.com`. The apex redirects
to `www`, preserving the path and query. DNS is at Njalla.

---

## 1. Push

Review and commit the intended changes before pushing the deployment branch.
The repository origin is `github.com/Gatsby01k/INRSettling`:

```bash
git push
```

If git asks for a password, GitHub wants a personal access token, not the account
password — Settings → Developer settings → Personal access tokens → Fine-grained,
with **Contents: read and write**. The macOS keychain remembers it afterwards.

## 2. Vercel project for the site

vercel.com/new → import `Gatsby01k/INRSettling`.

- **Root Directory: repository root** (leave the field blank)
- Framework preset: Other
- Build command: `node landing/scripts/build-seo.mjs` — set in `vercel.json`
- Output directory: `landing/public` — already in the root `vercel.json`
- Install command: empty
- Node runtime: 24.x

Deploy, then check the `*.vercel.app` URL before touching DNS.

For an existing project, check for dashboard overrides to the root configuration.
The marketing site needs no monorepo build. Confirm `/api/contact` responds with
JSON and `/app` is gated when `APP_ACCESS_CODE` is set.

## 3. Domain

Project → Settings → Domains → Add `inrsettle.com`, then `www.inrsettle.com`. Vercel
shows the exact records.

**Use the values from that screen, not from this file.** They are per-project now:
the apex A record is usually `76.76.21.21` but the dashboard is authoritative, and
the subdomain CNAME target looks like `d1d4fc829fe7bc7c.vercel-dns-017.com`. The
old shared `cname.vercel-dns.com` no longer applies.

In the Njalla DNS panel:

| Name | Type | Value |
|---|---|---|
| `@` | A | the apex value Vercel showed |
| `www` | CNAME | the per-project target Vercel showed |

Njalla has no ALIAS/ANAME, which is why the apex is an A record. Leave existing MX
and TXT records alone — you are changing web records, not moving nameservers.
Vercel issues the certificate itself once the records resolve.

## 4. Keeping the workspace private

`middleware.js` at the repository root gates `/app` behind a shared access code.
It runs at the edge, before anything is served, which is the only place a gate
on a static site can hold: the workspace files sit on a public CDN, so a check
written inside `workspace.js` is read and skipped by opening that file directly.

One setting turns it on — Vercel project → Settings → Environment Variables →
`APP_ACCESS_CODE`, for Production (and Preview, if you want previews closed too).
Redeploy after setting it.

- **Unset** — the gate does nothing and `/app` is open. That is the default, so
  deploying the file changes nothing until you decide.
- **Set** — `/app` asks for the code and remembers a correct answer for 30 days
  in a signed, HttpOnly cookie scoped to `/app`.

The code is also the signing key. **To revoke everyone, change the variable and
redeploy** — every cookie issued under the old code stops verifying. There is no
list to clean up.

The gate logs one line per entry to the function log, with the email if the
visitor typed one, so you can see who came in. It never logs the code.

What it is not: this is not the product's authentication. `SECURITY.md § 3.1`
fixes that — email identity with a mandatory second factor, TOTP at minimum and
WebAuthn preferred, sessions short, device-bound and revocable — and it needs the
API behind an HTTP host with a database, which is Stage 10.5. This is a shared
code on a preview of demonstration data. The gate page says so in those words,
and no copy on it suggests an account or a sign-in.

## 5. The workspace

The v6 demo workspace ships inside the site at `landing/public/app/` — four static
files, hash routing, no network calls, sharing `/assets/` with the site. It needs
no subdomain, no second Vercel project and no rewrite rules. Explore App points
at `/app/`; Get Started opens a business inquiry.

`landing/scripts/set-app-url.mjs` stays for the day the real product frontend gets
its own deployment: it moves the Explore App link to an absolute URL and back,
without changing inquiry CTAs.

The workspace uses illustrative data and makes no financial API calls. The landing
labels its embedded dashboard as a product preview and the tour as an illustrative
walkthrough. Use `APP_ACCESS_CODE` for private prospect walkthroughs.

## Inquiry delivery

`api/contact.js` supports business inquiries through **@inrslead_bot** to the
owner's personal Telegram chat, or to **info@inrsettle.com** through
[Resend's email API](https://resend.com/docs/api-reference/emails/send-email).
Configure server environment variables (see `.env.example`):

- `SITE_URL=https://www.inrsettle.com`: the canonical HTTPS origin. The apex currently redirects to `www`; submissions from other origins are rejected.
- `CONTACT_DELIVERY=telegram`: use the personal Telegram chat.
- `TELEGRAM_BOT_TOKEN`: the token of @inrslead_bot, server-only.
- `TELEGRAM_CHAT_ID`: the owner's positive numeric personal-chat ID.

See [TELEGRAM.md](TELEGRAM.md) for safe chat-ID discovery. To use email instead,
set `CONTACT_DELIVERY=email`, `RESEND_API_KEY` and a verified `CONTACT_FROM`
such as `INRSettle <website@inrsettle.com>`. Both channels are not sent together.
Existing email-only deployments without `CONTACT_DELIVERY` remain compatible;
when Telegram settings are present, auto-selection chooses Telegram and requires
complete valid settings rather than silently falling back to email.

The form always submits to `/api/contact`. Missing configuration or a failed
readiness check shows an availability notice, never opens a mail draft. The form
retains entered details on failed confirmation so submission can be retried.
Success is shown only after the provider acknowledges delivery.
Telegram acknowledgements must identify the configured personal chat. Long
inquiries are split into numbered messages without discarding route context.
For Telegram, `GET /api/contact` verifies @inrslead_bot with `getMe` and the
personal destination with `getChat`, without sending messages. Results are cached
for one minute per warm instance. A successful metadata check does not establish
send permission; verify delivery with a controlled inquiry after setup.

The endpoint validates and limits input, checks origin, binds retries to the
message, includes a honeypot and avoids logging inquiry data. Its in-memory limit
is per warm instance. Configure deployment-level rate limiting on `/api/contact`
and delivery monitoring before public launch. Telegram retries are coalesced and
acknowledged message parts are resumed for ten minutes within one warm instance.
Telegram's API does not provide an idempotency key: this guard cannot prevent
duplicates across instances or after an ambiguous timeout. Each message carries
the inquiry reference. A persistent outbox is needed for durable retry tracking.
Send a controlled test and verify it arrives in the owner's chat before enabling
online submission publicly.

## 6. End-to-end check

- [ ] `www.inrsettle.com` serves over HTTPS; `inrsettle.com` redirects to `www`, preserving path and query
- [ ] Favicon in the tab; fonts load (page is in Nimbus Sans, not Arial)
- [ ] All three background renders appear: hero plate, city, flow
- [ ] Get Started / Talk to Our Team open the inquiry dialog; Explore App opens `/app/`
- [ ] The workspace's brand link in the sidebar returns to the site
- [ ] With `APP_ACCESS_CODE` set, `/app` asks for it and `/app/workspace.js` is not served without it
- [ ] Lighthouse mobile run on both `/` and `/app/`
- [ ] `/robots.txt` and `/sitemap.xml` return 200 with text and XML content types
- [ ] `/developers`, `/docs`, `/docs/integration`, `/docs/reconciliation`, `/security` and `/privacy` return 200
- [ ] Legacy `/legal/privacy.html`, `/contact.html` and `/docs/reconciliation.html` redirect to their current equivalents, preserving query parameters and the inquiry fragment
- [ ] Public pages have one canonical URL on `https://www.inrsettle.com`
- [ ] `/app` and `/app/workspace.js` carry `X-Robots-Tag: noindex` even when the access code is unset
- [ ] The Open Graph PNG URL returns 200 without authentication
- [ ] Hero ribbon motion works; Pause and reduced-motion preferences are respected
- [ ] Inquiry validation, retry and failure states preserve visitor input
- [ ] A controlled inquiry arrives in the owner's Telegram chat (or email for email mode), including all fields and selected workflow

## Before public launch

Confirm the operational claims, supported corridors and current availability with
the business. Hero cards do not claim invented throughput, uptime or customer
counts. The embedded dashboard and corridor list remain illustrative product
examples, and should not be presented as actual business performance.

## Search appearance after deployment

See [SEO.md](SEO.md) for the verified audit, metadata sources and Search Console
handoff. Keep the build command in sync with the repository configuration; an
old dashboard override of an empty build command skips metadata regeneration.
The generated public HTML is committed too, so static deployments still have
complete metadata. Inspect deployment responses before requesting indexing.

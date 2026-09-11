# Deploying the site

One Vercel project, one domain, one repository. The site is `landing/public/`
and the demo workspace is `landing/public/app/` inside it, so `/` and `/app/` come
from the same deployment.

The repository root carries a `vercel.json` pointing `outputDirectory` at
`landing/public` with the install and build commands blanked, so importing this
repository with **default settings** serves the site. Setting Root Directory to
`landing` works too — Vercel then reads `landing/vercel.json` instead — but it is
no longer the setting everything depends on.

Replace `example.com` with the real domain. DNS is at Njalla.

---

## 1. Push

Everything is committed on `main` in this repository, whose origin is
`github.com/Gatsby01k/INRSettling`. From the repository root on the Mac:

```bash
git push
```

If git asks for a password, GitHub wants a personal access token, not the account
password — Settings → Developer settings → Personal access tokens → Fine-grained,
with **Contents: read and write**. The macOS keychain remembers it afterwards.

## 2. Vercel project for the site

vercel.com/new → import `Gatsby01k/INRSettling`.

- **Root Directory: `landing`** — this is the one setting that matters; without it
  Vercel tries to build the monorepo
- Framework preset: Other
- Build command: empty
- Output directory: `public` — already in `landing/vercel.json`, leave it
- Install command: empty

Deploy, then check the `*.vercel.app` URL before touching DNS.

Note: a Vercel project already exists against this repository from an earlier
attempt and fails on every push, because it tries to build the product app that has
no entry point. Point that project at `landing` or delete it — otherwise every push
keeps producing a failed deployment.

## 3. Domain

Project → Settings → Domains → Add `example.com`, then `www.example.com`. Vercel
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

## 4. The workspace

The v6 demo workspace ships inside the site at `landing/public/app/` — four static
files, hash routing, no network calls, sharing `/assets/` with the site. It needs
no subdomain, no second Vercel project and no rewrite rules, and the four CTAs
already point at `/app/`, so nothing has to be repointed.

`landing/scripts/set-app-url.mjs` stays for the day the real product frontend gets
its own deployment: it moves those four links to an absolute URL and back.

**It is a demo, and the page barely says so.** No provider, no authorization, no
API; the figures are invented. The only standing disclosure is a "Demo workspace"
caption in the footer — every other one ("Production endpoints and credentials are
not connected", "No money has been sent") appears only after the visitor interacts
with something. A prospect who clicks "Open App" sees a working-looking dashboard
first and the disclaimer second. Decide whether that is the impression you want
before the domain is announced.

## 6. End-to-end check

- [ ] `example.com` serves over HTTPS, `www` redirects to it
- [ ] Favicon in the tab; fonts load (page is in Nimbus Sans, not Arial)
- [ ] All three background renders appear: hero plate, city, flow
- [ ] All four CTAs open `/app/` and the workspace renders
- [ ] The workspace's brand link in the sidebar returns to the site
- [ ] Lighthouse mobile run on both `/` and `/app/`
- [ ] The contact dialog still only prepares a local brief

## Before this is a launch rather than a preview

The illustrative figures are still on the page — `1000+`, `99.9%`, `50+`, `< 60s`,
the dashboard numbers, the corridor list. They reproduce the design reference and
are not claims about the business; a B2B buyer checks these in diligence. Replace
or remove them, and connect the contact form to a real inbox, before the domain is
announced anywhere.

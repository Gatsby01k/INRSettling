# Deploying the site

Two properties on one domain, two Vercel projects, one repository:

| | Source | Vercel Root Directory |
|---|---|---|
| `example.com` + `www` | `landing/` | `landing` |
| `app.example.com` | the product workspace | set when it has a home |

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

## 4. The workspace subdomain

The workspace is the product frontend and does not live in `landing/`. When it has
a home in this repository, create a second Vercel project pointed at that
directory, add `app.example.com` to it, and create the CNAME with **that**
project's target — it differs from the site's.

## 5. Point the site's buttons at the workspace

Four links — header CTA, hero CTA, "Open App", closing CTA — point at `/app/`.
Once the subdomain answers:

```bash
node landing/scripts/set-app-url.mjs https://app.example.com
node landing/scripts/set-app-url.mjs          # verify: ×4 at the new URL
git commit -am "Point the site's app links at the workspace" && git push
```

Idempotent and reversible — pass `/app/` to put them back.

## 6. End-to-end check

- [ ] `example.com` serves over HTTPS, `www` redirects to it
- [ ] Favicon in the tab; fonts load (page is in Nimbus Sans, not Arial)
- [ ] All three background renders appear: hero plate, city, flow
- [ ] All four CTAs land on `app.example.com`
- [ ] The workspace loads there and its brand link returns to `example.com`
- [ ] Lighthouse mobile run on both
- [ ] The contact dialog still only prepares a local brief

## Before this is a launch rather than a preview

The illustrative figures are still on the page — `1000+`, `99.9%`, `50+`, `< 60s`,
the dashboard numbers, the corridor list. They reproduce the design reference and
are not claims about the business; a B2B buyer checks these in diligence. Replace
or remove them, and connect the contact form to a real inbox, before the domain is
announced anywhere.

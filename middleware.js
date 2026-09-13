/**
 * A gate in front of `/app/`, enforced at the edge.
 *
 * The workspace is a demo — no provider, no authorization, no money — but its
 * files sit on a public CDN, so anything that checks access inside
 * `workspace.js` is theatre: open `/app/workspace.js` directly and you have
 * read the check and skipped it. The only place a gate can actually hold is in
 * front of the request, which is what this is.
 *
 * What this is NOT: it is not the product's authentication. `SECURITY.md § 3.1`
 * fixes that — email identity with a mandatory second factor, TOTP at minimum
 * and WebAuthn preferred, sessions short and device-bound — and none of it can
 * exist until the API has an HTTP host and a database it can reach. This is a
 * shared access code on a preview. It keeps the page off search engines and out
 * of the hands of whoever finds the link. It does not identify anybody, and no
 * copy on the gate page suggests otherwise.
 *
 * One environment variable, `APP_ACCESS_CODE`, set in the Vercel project:
 *
 *   - unset  → the gate does nothing and `/app/` stays open, so deploying this
 *              file changes nothing until you decide to turn it on;
 *   - set    → `/app/*` asks for the code, and remembers a correct answer for
 *              30 days in a signed, HttpOnly cookie.
 *
 * The code is also the signing key, so changing it in Vercel invalidates every
 * cookie that was issued under the old one. That is how you revoke access: edit
 * the variable and redeploy.
 *
 * No dependencies. `@vercel/functions` exports a `next()` helper for continuing
 * the chain, but a middleware that returns nothing continues anyway, and a
 * gate worth trusting is one you can read end to end without installing
 * something first.
 */

export const config = {
  // Only `/app`. The site itself, its assets and the currency icons are public
  // and must stay that way — the gate is for the workspace, not the pitch.
  matcher: ['/app', '/app/:path*'],
}

const COOKIE = 'inrsettle_preview'
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60

const encoder = new TextEncoder()

/** Constant-time comparison, so a wrong code leaks nothing through timing. */
function equals(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function base64url(bytes) {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
}

/**
 * A ticket is `expiry.signature`, and nothing else.
 *
 * Deliberately not a session: it carries no identity, grants no capability and
 * is checked against one shared secret. Whoever holds it has the code.
 */
async function issue(secret) {
  const expiry = String(Date.now() + MAX_AGE_SECONDS * 1000)
  return `${expiry}.${await sign(expiry, secret)}`
}

async function valid(ticket, secret) {
  if (typeof ticket !== 'string') return false
  const dot = ticket.indexOf('.')
  if (dot < 1) return false
  const expiry = ticket.slice(0, dot)
  const signature = ticket.slice(dot + 1)
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now()) return false
  return equals(signature, await sign(expiry, secret))
}

function readCookie(request, name) {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * The gate page.
 *
 * Borrows the site's own stylesheet by link — `/styles.css` is public and the
 * matcher does not cover it — so this reads as part of the site rather than as
 * a server error page. The copy says what this is: a private preview with
 * demonstration data, not an account you are signing in to.
 */
function gate(message) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Private preview · INRSettle</title>
<link rel="icon" type="image/svg+xml" href="/assets/brand-favicon.svg">
<link rel="stylesheet" href="/styles.css">
<style>
  .gate{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .gate-card{width:100%;max-width:400px}
  .gate-card img{height:34px;width:auto;margin-bottom:28px}
  .gate-card h1{font-size:24px;margin:0 0 10px}
  .gate-card p{margin:0 0 22px;opacity:.72;line-height:1.5}
  .gate-card label{display:block;font-size:13px;margin-bottom:7px}
  .gate-card input{width:100%;padding:12px 14px;margin-bottom:14px;font:inherit;
    border:1px solid rgba(0,0,0,.16);border-radius:9px;background:#fff}
  .gate-card button{width:100%;padding:12px 14px;font:inherit;cursor:pointer}
  .gate-note{font-size:12px;margin:20px 0 0;opacity:.55}
  .gate-error{font-size:13px;color:#b42318;margin:0 0 14px}
</style>
</head>
<body>
<main class="gate">
  <form class="gate-card" method="POST" action="/app">
    <a href="/"><img src="/assets/brand-lockup.svg" alt="INRSettle"></a>
    <h1>Private preview</h1>
    <p>The workspace is not open yet. Enter the access code you were given and it
       will stay unlocked on this device for 30 days.</p>
    ${message ? `<p class="gate-error">${message}</p>` : ''}
    <label for="email">Email <span style="opacity:.55">(optional)</span></label>
    <input id="email" name="email" type="email" autocomplete="email" placeholder="you@company.com">
    <label for="code">Access code</label>
    <input id="code" name="code" type="password" autocomplete="off" autofocus required>
    <button class="button primary" type="submit">Open the workspace</button>
    <p class="gate-note">This preview runs on demonstration data. No provider,
       no authorization and no payment is connected, and nothing here moves
       money. It is not an account and this is not a sign-in.</p>
  </form>
</main>
</body>
</html>`,
    { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } },
  )
}

export default async function middleware(request) {
  const secret = process.env.APP_ACCESS_CODE

  // Not configured: stay out of the way entirely. Shipping this file must not
  // be able to take the workspace down on its own.
  if (!secret) return

  if (await valid(readCookie(request, COOKIE), secret)) return

  if (request.method === 'POST') {
    let form
    try {
      form = await request.formData()
    } catch {
      return gate('That did not come through. Try again.')
    }
    const code = String(form.get('code') ?? '')
    if (!equals(code, secret)) {
      // Logged without the code itself, so the function log never becomes a
      // place the code can be read back out of.
      console.warn('preview gate: wrong code', { email: String(form.get('email') ?? '') || null })
      return gate('That code is not right.')
    }

    const email = String(form.get('email') ?? '').trim()
    // The only record that anyone came in. Vercel's function logs are enough
    // at this stage; when it stops being enough, this is the line to change.
    console.log('preview gate: opened', { email: email || null })

    return new Response(null, {
      status: 303,
      headers: {
        // A literal path, never one derived from the request: the destination
        // of a redirect this function issues is not the caller's to choose.
        // `/app` without the slash, because `vercel.json` sets
        // `trailingSlash: false` and would otherwise redirect once more.
        location: '/app',
        'set-cookie': `${COOKIE}=${await issue(secret)}; Path=/app; Max-Age=${MAX_AGE_SECONDS}; `
          + 'HttpOnly; Secure; SameSite=Lax',
      },
    })
  }

  return gate(null)
}

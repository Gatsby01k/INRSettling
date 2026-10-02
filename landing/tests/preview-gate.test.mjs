/**
 * The preview gate — `middleware.js`.
 *
 * Worth testing rather than eyeballing, because every failure mode here is
 * silent: a gate that lets everyone through looks exactly like a gate that
 * works, until someone sends you the link they should not have had.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import middleware, { config } from '../../middleware.js'

const CODE = 'correct-horse-battery-staple'

function get(path = '/app', cookie = null) {
  return new Request('https://inrsettle.test' + path, {
    headers: cookie ? { cookie } : {},
  })
}

function post(fields, path = '/app') {
  const body = new URLSearchParams(fields)
  return new Request('https://inrsettle.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie')
  assert.ok(header, 'expected a set-cookie header')
  return header.slice(0, header.indexOf(';'))
}

test('with no code configured the gate stays out of the way', async () => {
  delete process.env.APP_ACCESS_CODE
  assert.equal(await middleware(get()), undefined)
})

test('a visitor with no ticket is asked for the code, and is not served the app', async () => {
  process.env.APP_ACCESS_CODE = CODE
  const response = await middleware(get())
  assert.equal(response.status, 401)
  const html = await response.text()
  assert.match(html, /Private preview/)
  // The gate must never print the thing it is checking.
  assert.ok(!html.includes(CODE))
  // And it must not claim to be something it is not.
  assert.match(html, /not an account and this is not a sign-in/)
  assert.match(response.headers.get('x-robots-tag'), /noindex/)
})

test('the wrong code does not open it', async () => {
  process.env.APP_ACCESS_CODE = CODE
  const response = await middleware(post({ code: 'nearly-the-right-code' }))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.match(await response.text(), /not right/)
})

test('a code of the right length but wrong content does not open it', async () => {
  // The constant-time comparison returns early on a length mismatch, so the
  // interesting case is the one where the lengths agree.
  process.env.APP_ACCESS_CODE = CODE
  const sameLength = 'x'.repeat(CODE.length)
  assert.equal(sameLength.length, CODE.length)
  const response = await middleware(post({ code: sameLength }))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('set-cookie'), null)
})

test('the right code issues a ticket that then opens it', async () => {
  process.env.APP_ACCESS_CODE = CODE
  const response = await middleware(post({ code: CODE, email: 'a@b.test' }))
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/app')

  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /Secure/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.match(setCookie, /Path=\/app/)
  // The ticket carries no identity and is not the code.
  assert.ok(!setCookie.includes(CODE))
  assert.ok(!setCookie.includes('a@b.test'))

  assert.equal(await middleware(get('/app', cookieFrom(response))), undefined)
  assert.equal(await middleware(get('/app/workspace.js', cookieFrom(response))), undefined)
})

test('a ticket signed with a different code is refused', async () => {
  // This is how revocation works: change the variable in Vercel and every
  // ticket issued under the old one stops verifying.
  process.env.APP_ACCESS_CODE = CODE
  const cookie = cookieFrom(await middleware(post({ code: CODE })))
  process.env.APP_ACCESS_CODE = 'a-new-code-entirely'
  const response = await middleware(get('/app', cookie))
  assert.equal(response.status, 401)
})

test('a tampered or expired ticket is refused', async () => {
  process.env.APP_ACCESS_CODE = CODE
  const cookie = cookieFrom(await middleware(post({ code: CODE })))
  const [name, ticket] = [cookie.slice(0, cookie.indexOf('=')), cookie.slice(cookie.indexOf('=') + 1)]
  const [expiry, signature] = [ticket.slice(0, ticket.indexOf('.')), ticket.slice(ticket.indexOf('.') + 1)]

  for (const forged of [
    `${name}=${expiry}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`, // guaranteed edit
    `${name}=${Number(expiry) + 86400000}.${signature}`,      // expiry pushed out
    `${name}=${Date.now() - 1000}.${signature}`,              // already expired
    `${name}=${expiry}`,                                      // no signature at all
    `${name}=`,                                               // empty
  ]) {
    const response = await middleware(get('/app', forged))
    assert.equal(response.status, 401, forged)
  }
})

test('the gate covers the workspace and nothing else', () => {
  assert.deepEqual(config.matcher, ['/app', '/app/:path*'])
  // The site, its stylesheet and its assets have to stay public — the gate
  // page itself loads /styles.css and /assets/brand-lockup.svg.
  for (const open of ['/', '/styles.css', '/assets/brand-lockup.svg', '/app.js'])
    assert.ok(!config.matcher.some((m) => open === m || open.startsWith('/app/')), open)
})

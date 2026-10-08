import test, { afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import middleware, { config } from '../../middleware.js'

const CODE = 'fixture-preview-code-never-a-real-secret'
const ORIGIN = 'https://inrsettle.test'
const previousCode = process.env.APP_ACCESS_CODE

afterEach(() => {
  if (previousCode === undefined) delete process.env.APP_ACCESS_CODE
  else process.env.APP_ACCESS_CODE = previousCode
  mock.restoreAll()
})

function get(path = '/app/sign-in', cookie = '') {
  return new Request(ORIGIN + path, { headers: { cookie } })
}
function post(fields, cookie = '', path = '/app/sign-in', extra = {}) {
  return new Request(ORIGIN + path, {
    method: 'POST', headers: { origin: ORIGIN, cookie, 'content-type': 'application/x-www-form-urlencoded', ...extra },
    body: fields instanceof URLSearchParams ? fields : new URLSearchParams(fields),
  })
}
function cookies(response) {
  return response.headers.getSetCookie().filter(v => !v.includes('Max-Age=0'))
    .map(v => v.split(';')[0]).join('; ')
}
async function form() {
  process.env.APP_ACCESS_CODE = CODE
  const response = await middleware(get())
  const html = await response.text()
  const csrf = html.match(/name="csrf"\s+value="([^"]+)"/)?.[1]
  assert.ok(csrf, 'sign-in must include a server-issued CSRF token')
  return { csrf, cookie: cookies(response), html, response }
}
async function enter() {
  const initial = await form()
  const response = await middleware(post({ csrf: initial.csrf, code: CODE }, initial.cookie))
  assert.equal(response.status, 303)
  return { ...initial, response, cookie: cookies(response) }
}

test('missing configuration fails closed for pages, assets and session', async () => {
  delete process.env.APP_ACCESS_CODE
  for (const path of ['/app', '/app/sign-in', '/app/workspace.js', '/app/session']) {
    const response = await middleware(get(path))
    assert.equal(response.status, 503, path)
    assert.match(response.headers.get('cache-control'), /no-store/)
    assert.equal(response.headers.get('set-cookie'), null)
  }
})

test('unauthenticated app redirects to the branded entry; assets cannot bypass it', async () => {
  process.env.APP_ACCESS_CODE = CODE
  const response = await middleware(get('/app'))
  assert.equal(response.headers.get('location'), '/app/sign-in')
  for (const path of ['/app/workspace.js', '/app/index.html', '/app/session'])
    assert.equal((await middleware(get(path))).status, 401)
  const initial = await form()
  assert.equal(initial.response.status, 200)
  assert.ok(!initial.html.includes(CODE))
  assert.match(initial.html, /Private preview/)
  assert.doesNotMatch(initial.html, /name="email"/)
  assert.match(initial.response.headers.get('x-robots-tag'), /noindex/)
  assert.match(initial.response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
})

test('wrong code does not issue access; error is associated with the input', async () => {
  const initial = await form()
  for (const code of ['incorrect', 'x'.repeat(CODE.length)]) {
    const response = await middleware(post({ csrf: initial.csrf, code }, initial.cookie))
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('set-cookie'), null)
    const html = await response.text()
    assert.match(html, /aria-invalid="true"/)
    assert.match(html, /role="alert"/)
  }
})

test('correct code grants a browser-bound 12-hour HttpOnly ticket', async () => {
  const access = await enter()
  const headers = access.response.headers.getSetCookie()
  const ticket = headers.find(v => v.startsWith('__Host-inr_preview='))
  assert.match(ticket, /Max-Age=43200/)
  assert.match(ticket, /Path=\//)
  assert.match(ticket, /HttpOnly; Secure; SameSite=Lax/)
  assert.ok(!ticket.includes(CODE))
  assert.equal(access.response.headers.get('location'), '/app')
  for (const path of ['/app', '/app/workspace.js'])
    assert.equal(await middleware(get(path, access.cookie)), undefined)
  assert.equal((await middleware(get('/app/sign-in', access.cookie))).headers.get('location'), '/app')
  assert.equal((await middleware(get('/app/session', access.cookie))).status, 200)
})

test('ticket alone, duplicate cookie, legacy ticket or different browser cannot grant access', async () => {
  const access = await enter()
  const ticket = cookies(access.response).split('; ').find(v => v.startsWith('__Host-inr_preview='))
  const other = await form()
  for (const cookie of [ticket, ticket + '; ' + other.cookie, access.cookie + '; ' + ticket, 'inrsettle_preview=legacy'])
    assert.notEqual(await middleware(get('/app', cookie)), undefined, cookie)
})

test('ticket tampering and code rotation revoke access', async () => {
  const access = await enter()
  const tampered = access.cookie.replace(/(__Host-inr_preview=\d+\.)[A-Za-z0-9_-]/, '$1!')
  assert.notEqual(await middleware(get('/app', tampered)), undefined)
  process.env.APP_ACCESS_CODE = 'different-fixture-preview-code'
  assert.notEqual(await middleware(get('/app', access.cookie)), undefined)
})

test('expired ticket cannot serve app and entry explains expiry', async () => {
  const access = await enter()
  const future = Date.now() + 12 * 60 * 60 * 1000 + 1000
  mock.method(Date, 'now', () => future)
  assert.notEqual(await middleware(get('/app', access.cookie)), undefined)
  assert.match(await (await middleware(get('/app/sign-in', access.cookie))).text(), /preview access has expired/)
})

test('cross-origin and same-site sibling requests cannot submit valid login forms', async () => {
  const initial = await form()
  for (const extra of [{ origin: 'https://attacker.test' }, { origin: 'null' }, { origin: '' }, { 'sec-fetch-site': 'same-site' }]) {
    const response = await middleware(post({ code: CODE, csrf: initial.csrf }, initial.cookie, '/app/sign-in', extra))
    assert.equal(response.status, 403)
  }
})

test('missing, forged, cross-device and expired CSRF proofs are rejected', async () => {
  const initial = await form()
  const other = await form()
  for (const [csrf, cookie] of [['', initial.cookie], [initial.csrf + 'a', initial.cookie], [initial.csrf, other.cookie]])
    assert.equal((await middleware(post({ code: CODE, csrf }, cookie))).status, 403)
  const future = Date.now() + 20 * 60 * 1000 + 1000
  mock.method(Date, 'now', () => future)
  assert.equal((await middleware(post({ code: CODE, csrf: initial.csrf }, initial.cookie))).status, 403)
})

test('oversized, duplicate and invalid-content form submissions are refused', async () => {
  const initial = await form()
  const duplicate = new URLSearchParams({ code: CODE, csrf: initial.csrf })
  duplicate.append('code', CODE)
  assert.equal((await middleware(post(duplicate, initial.cookie))).status, 401)
  duplicate.delete('code'); duplicate.append('code', CODE); duplicate.append('csrf', initial.csrf)
  assert.equal((await middleware(post(duplicate, initial.cookie))).status, 403)
  assert.equal((await middleware(post({ code: CODE, csrf: initial.csrf, padding: 'x'.repeat(5000) }, initial.cookie))).status, 403)
  assert.equal((await middleware(post({ code: CODE, csrf: initial.csrf }, initial.cookie, '/app/sign-in', { 'content-type': 'text/plain' }))).status, 403)
})

test('logout is an origin- and CSRF-protected POST that clears both access cookies', async () => {
  const access = await enter()
  const session = await (await middleware(get('/app/session', access.cookie))).json()
  assert.equal(session.mode, 'preview')
  const response = await middleware(post({ csrf: session.csrf }, access.cookie, '/app/sign-out'))
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/app/sign-in?status=signed-out')
  assert.equal(response.headers.getSetCookie().length, 4)
  for (const value of response.headers.getSetCookie()) assert.match(value, /Max-Age=0/)
  assert.equal((await middleware(post({ csrf: session.csrf }, access.cookie, '/app/sign-out', { origin: 'https://attacker.test' }))).status, 403)
  // Visiting a GET link cannot clear a visitor's access.
  assert.equal((await middleware(get('/app/sign-out', access.cookie))).headers.get('set-cookie'), null)
})

test('unrecognised POST targets and methods do not reach workspace files', async () => {
  const initial = await form()
  assert.equal((await middleware(post({ code: CODE, csrf: initial.csrf }, initial.cookie, '/app/workspace.js'))).status, 405)
  assert.equal((await middleware(new Request(ORIGIN + '/app', { method: 'DELETE' }))).status, 405)
})

test('public form signatures cannot be used to guess the access code offline', async () => {
  const initial = await form()
  const [expiry, nonce, signature] = initial.csrf.split('.')
  const device = initial.cookie.split('; ').find(v => v.startsWith('__Host-inr_device=')).split('=')[1]
  assert.notEqual(createHmac('sha256', CODE).update(`csrf:${expiry}.${nonce}:${device}`).digest('base64url'), signature)
})

test('login preserves only known workspace views and cannot redirect outside the app', async () => {
  const initial = await form()
  for (const view of ['developers', 'settings', '//attacker.test', 'https://attacker.test', 'settings#anything']) {
    const response = await middleware(post({ code: CODE, csrf: initial.csrf, view }, initial.cookie))
    assert.equal(response.headers.get('location'), ['developers', 'settings'].includes(view) ? `/app#/${view}` : '/app')
  }
  const wrong = await middleware(post({ code: 'wrong', csrf: initial.csrf, view: 'developers' }, initial.cookie))
  assert.match(await wrong.text(), /name="view" value="developers"/)
})

test('middleware scope protects only app paths', () => {
  assert.deepEqual(config.matcher, ['/app', '/app/:path*'])
})

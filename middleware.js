/**
 * Server-enforced access to the illustrative workspace. This is a shared-code
 * preview, not customer identity or authorization to execute payments.
 * Real accounts require the IdP + database-backed session host described by
 * SECURITY.md §3.1; no client form can substitute for that boundary.
 */
import { renderAccessPage } from './landing/lib/access-page.mjs'

export const config = { matcher: ['/app', '/app/:path*'] }

const TICKET = '__Host-inr_preview'
const DEVICE = '__Host-inr_device'
const FORM = '__Host-inr_form'
const MAX_AGE = 12 * 60 * 60
const CSRF_AGE = 20 * 60
const VIEWS = new Set(['overview', 'settlements', 'liquidity', 'beneficiaries', 'batches', 'reconciliation', 'developers', 'settings'])
const encoder = new TextEncoder()
const secureHeaders = {
  'cache-control': 'private, no-store, max-age=0',
  'x-robots-tag': 'noindex, nofollow, nosnippet',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
}

function equals(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function base64url(bytes) {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function random() { return base64url(crypto.getRandomValues(new Uint8Array(32))) }

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
}

function readCookie(request, name) {
  const matches = (request.headers.get('cookie') ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(name + '='))
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null
}

function cookie(name, value, age = MAX_AGE) {
  return `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`
}

async function issueTicket(secret, device) {
  const expiry = String(Date.now() + MAX_AGE * 1000)
  return `${expiry}.${await sign(`preview:v2:${expiry}:${device}`, secret)}`
}

async function validTicket(ticket, secret, device) {
  if (!device || !/^[A-Za-z0-9_-]{43}$/.test(device) || !/^\d{13}\.[A-Za-z0-9_-]{43}$/.test(ticket ?? '')) return false
  const [expiry, signature] = ticket.split('.')
  if (Number(expiry) <= Date.now() || Number(expiry) > Date.now() + MAX_AGE * 1000) return false
  return equals(signature, await sign(`preview:v2:${expiry}:${device}`, secret))
}

async function issueCsrf(formKey, device) {
  const payload = `${Date.now() + CSRF_AGE * 1000}.${random()}`
  // A random per-browser key keeps a public form from becoming an offline
  // guessing oracle for the shared access code.
  return `${payload}.${await sign(`csrf:${payload}:${device}`, formKey)}`
}

async function validCsrf(token, formKey, device) {
  if (!device || !/^[A-Za-z0-9_-]{43}$/.test(formKey ?? '') || !/^\d{13}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token ?? '')) return false
  const [expiry, nonce, signature] = token.split('.')
  if (Number(expiry) <= Date.now() || Number(expiry) > Date.now() + CSRF_AGE * 1000) return false
  return equals(signature, await sign(`csrf:${expiry}.${nonce}:${device}`, formKey))
}

function sameOrigin(request) {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  return origin === new URL(request.url).origin && (!site || site === 'same-origin')
}

async function readForm(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return null
  if (Number(request.headers.get('content-length') ?? 0) > 4096) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  let length = 0
  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 4096) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new URLSearchParams(new TextDecoder().decode(bytes))
}

function redirect(location, status = 303) {
  return new Response(null, { status, headers: { ...secureHeaders, location } })
}

async function page(request, secret, options = {}, status = 200) {
  const previous = readCookie(request, DEVICE)
  const device = /^[A-Za-z0-9_-]{43}$/.test(previous ?? '') ? previous : random()
  const previousKey = readCookie(request, FORM)
  const formKey = /^[A-Za-z0-9_-]{43}$/.test(previousKey ?? '') ? previousKey : random()
  const response = new Response(renderAccessPage({
    action: '/app/sign-in', csrfToken: secret ? await issueCsrf(formKey, device) : '', ...options,
  }), { status, headers: { ...secureHeaders, 'content-type': 'text/html; charset=utf-8' } })
  if (secret && device !== previous) response.headers.append('set-cookie', cookie(DEVICE, device))
  if (secret && formKey !== previousKey) response.headers.append('set-cookie', cookie(FORM, formKey))
  return response
}

export default async function middleware(request) {
  const path = new URL(request.url).pathname.replace(/\/$/, '')
  const secret = process.env.APP_ACCESS_CODE
  const device = readCookie(request, DEVICE)
  const formKey = readCookie(request, FORM)
  const authenticated = secret && await validTicket(readCookie(request, TICKET), secret, device)

  if (!['GET', 'HEAD', 'POST'].includes(request.method))
    return new Response(null, { status: 405, headers: { ...secureHeaders, allow: 'GET, HEAD, POST' } })

  if (request.method === 'POST') {
    if (!['/app', '/app/sign-in', '/app/sign-out'].includes(path))
      return new Response(null, { status: 405, headers: secureHeaders })
    if (!secret) return page(request, null, { state: 'unavailable' }, 503)
    let form
    try { form = sameOrigin(request) ? await readForm(request) : null } catch { form = null }
    if (!form || form.getAll('csrf').length !== 1 || !await validCsrf(form.get('csrf'), formKey, device))
      return page(request, secret, { message: 'This form has expired. Please try again.' }, 403)

    if (path === '/app/sign-out') {
      const response = redirect('/app/sign-in?status=signed-out')
      response.headers.append('set-cookie', cookie(TICKET, '', 0))
      response.headers.append('set-cookie', cookie(DEVICE, '', 0))
      response.headers.append('set-cookie', cookie(FORM, '', 0))
      response.headers.append('set-cookie', 'inrsettle_preview=; Path=/app; Max-Age=0; HttpOnly; Secure; SameSite=Lax')
      return response
    }

    const view = form.getAll('view').length === 1 && VIEWS.has(form.get('view')) ? form.get('view') : ''
    if (form.getAll('code').length !== 1 || !equals(form.get('code'), secret))
      return page(request, secret, { view, message: 'That access code doesn’t match. Check it and try again.' }, 401)

    const response = redirect(view ? `/app#/${view}` : '/app')
    response.headers.append('set-cookie', cookie(TICKET, await issueTicket(secret, device)))
    response.headers.append('set-cookie', cookie(DEVICE, device))
    response.headers.append('set-cookie', cookie(FORM, formKey))
    response.headers.append('set-cookie', 'inrsettle_preview=; Path=/app; Max-Age=0; HttpOnly; Secure; SameSite=Lax')
    return response
  }

  if (path === '/app/session') {
    if (!authenticated) return new Response(null, { status: secret ? 401 : 503, headers: secureHeaders })
    const key = /^[A-Za-z0-9_-]{43}$/.test(formKey ?? '') ? formKey : random()
    const response = new Response(JSON.stringify({ mode: 'preview', csrf: await issueCsrf(key, device) }), {
      headers: { ...secureHeaders, 'content-type': 'application/json; charset=utf-8' },
    })
    if (key !== formKey) response.headers.append('set-cookie', cookie(FORM, key))
    return response
  }

  if (path === '/app/sign-in' || path === '/app/sign-out') {
    if (authenticated) return redirect('/app')
    const message = new URL(request.url).searchParams.get('status') === 'signed-out'
      ? 'Preview access closed on this browser.'
      : readCookie(request, TICKET) ? 'Your preview access has expired. Enter your code to continue.' : ''
    return page(request, secret, { state: secret ? 'preview' : 'unavailable', message, messageKind: 'status' }, secret ? 200 : 503)
  }

  if (authenticated) return
  if (!secret) return page(request, null, { state: 'unavailable' }, 503)
  if (path === '/app' || !path.split('/').pop().includes('.')) return redirect('/app/sign-in')
  return new Response('Workspace access required.', { status: 401, headers: { ...secureHeaders, 'content-type': 'text/plain; charset=utf-8' } })
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createContactHandler } from '../../api/contact.js';
const env = { RESEND_API_KEY: 'unit-test-value', CONTACT_FROM: 'Website <website@example.test>', SITE_URL: 'https://example.test' };
const data = { name: 'Test Operator', email: 'operator@example.test', company: 'Example Co', interest: 'integration', volume: 'evaluating', message: 'We are evaluating supplier payments into India.', website: '' };
const headers = { origin: 'https://example.test', 'content-type': 'application/json', 'idempotency-key': '89dd4ae1-a769-4ccd-a8ba-2ff169d2d731' };
function request(overrides = {}) { return { method: 'POST', headers: { ...headers }, body: { ...data }, ...overrides }; }
async function invoke(handler, req) {
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = JSON.parse(value); } };
  await handler(req, response); return response;
}
test('unconfigured service reports unavailable and never accepts an inquiry', async () => {
  const handler = createContactHandler({ env: {}, send: () => { throw new Error('must not send'); } });
  assert.deepEqual((await invoke(handler, request({ method: 'GET' }))).body, { available: false });
  assert.equal((await invoke(handler, request())).statusCode, 503);
});
test('delivery goes only to the authorized address; success requires provider acknowledgement', async () => {
  let sent;
  const handler = createContactHandler({ env, send: async (url, options) => { sent = { url, options }; return new Response(JSON.stringify({ id: 'test-email-id' })); } });
  const result = await invoke(handler, request({ body: { ...data, to: 'untrusted@example.test' } }));
  assert.equal(result.statusCode, 202); assert.deepEqual(result.body, { accepted: true });
  assert.equal(sent.url, 'https://api.resend.com/emails');
  const body = JSON.parse(sent.options.body);
  assert.deepEqual(body.to, ['info@inrsettle.com']); assert.equal(body.reply_to, data.email); assert.ok(!('html' in body));
  assert.equal(result.headers['Cache-Control'], 'no-store');
});
test('invalid origin, content, fields and honeypot never reach delivery', async () => {
  const handler = createContactHandler({ env, send: () => assert.fail('unexpected network call') });
  const cases = [
    [request({ headers: { ...headers, origin: 'https://attacker.test' } }), 403],
    [request({ headers: { ...headers, 'content-type': 'text/plain' } }), 415],
    [request({ headers: { ...headers, 'content-length': '20000' } }), 413],
    [request({ body: 'not json' }), 400],
    [request({ body: null }), 400],
    [request({ body: [] }), 400],
    [request({ body: { ...data, website: 'spam' } }), 400],
    [request({ body: { ...data, company: 'Header\ninjection' } }), 400],
    [request({ body: { ...data, email: 'invalid' } }), 400],
    [request({ body: { ...data, message: 'x'.repeat(2001) } }), 400],
    [request({ body: { ...data, context: 'x'.repeat(2001) } }), 400],
    [request({ body: { ...data, context: {} } }), 400],
    [request({ body: { ...data, interest: 'unknown' } }), 400],
    [request({ headers: { ...headers, 'idempotency-key': 'bad' } }), 400],
  ];
  for (const [req, code] of cases) assert.equal((await invoke(handler, req)).statusCode, code);
});
test('selected corridor context is delivered alongside the visitor’s own message', async () => {
  let delivered;
  const context = 'Direction: India → World\nProposed currencies: INR → AED\nBusiness use: Platform & marketplace payouts';
  const handler = createContactHandler({ env, send: async (_, options) => { delivered = JSON.parse(options.body); return new Response('{"id":"ok"}'); } });
  assert.equal((await invoke(handler, request({ body: { ...data, context } }))).statusCode, 202);
  assert.ok(delivered.text.includes(data.message));
  assert.ok(delivered.text.includes(context));
});
test('provider failures, timeouts and malformed success never return false success', async () => {
  for (const send of [async () => new Response('{}', { status: 500 }), async () => new Response('{}'), async () => { throw new Error('network failure'); }]) {
    const response = await invoke(createContactHandler({ env, send }), request());
    assert.equal(response.statusCode, 502); assert.equal(response.body.accepted, undefined);
  }
});
test('retry preserves the provider idempotency key, changed content changes it', async () => {
  const keys = [];
  const handler = createContactHandler({ env, send: async (_, options) => { keys.push(options.headers['Idempotency-Key']); return new Response('{"id":"ok"}'); } });
  await invoke(handler, request()); await invoke(handler, request()); await invoke(handler, request({ body: { ...data, message: 'A different, updated inquiry message.' } }));
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
});
test('warm-instance abuse limit expires without storing raw network addresses', async () => {
  let clock = 0; let sends = 0;
  const handler = createContactHandler({ env, now: () => clock, send: async () => { sends++; return new Response('{"id":"ok"}'); } });
  for (let i = 0; i < 5; i++) assert.equal((await invoke(handler, request())).statusCode, 202);
  const limited = await invoke(handler, request()); assert.equal(limited.statusCode, 429); assert.equal(sends, 5);
  clock = 600001; assert.equal((await invoke(handler, request())).statusCode, 202);
});

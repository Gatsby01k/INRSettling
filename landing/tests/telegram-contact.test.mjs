import test from 'node:test';
import assert from 'node:assert/strict';
import { createContactHandler } from '../../api/contact.js';

// Deliberately fake credentials; every delivery call is mocked.
const env = { SITE_URL: 'https://www.inrsettle.com', CONTACT_DELIVERY: 'telegram', TELEGRAM_BOT_TOKEN: '123456789:unit_test_token_1234567890', TELEGRAM_CHAT_ID: '987654321' };
const data = { name: 'Test Operator', email: 'operator@example.test', company: 'Example Co', interest: 'integration', volume: '100k-1m', message: 'We need supplier settlement into India.', context: 'Direction: World → India\nCurrencies: USDC → INR', website: '' };
const headers = { origin: env.SITE_URL, 'content-type': 'application/json', 'idempotency-key': '89dd4ae1-a769-4ccd-a8ba-2ff169d2d731' };
const request = overrides => ({ method: 'POST', headers: { ...headers }, body: { ...data }, ...overrides });
const accepted = (chatId = env.TELEGRAM_CHAT_ID) => new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: Number(chatId), type: 'private' } } }));
async function invoke(handler, req = request()) {
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = JSON.parse(value); } };
  await handler(req, res); return res;
}

test('Telegram-only availability needs the canonical HTTPS origin, a valid token and personal chat ID', async () => {
  assert.deepEqual((await invoke(createContactHandler({ env }), request({ method: 'GET' }))).body, { available: true, channel: 'telegram' });
  const cases = [
    { TELEGRAM_BOT_TOKEN: '' }, { TELEGRAM_CHAT_ID: '' }, { TELEGRAM_CHAT_ID: '@inrslead_bot' },
    { TELEGRAM_CHAT_ID: '-1001234567890' }, { TELEGRAM_CHAT_ID: '1/other' },
    { TELEGRAM_BOT_TOKEN: 'invalid/token' }, { SITE_URL: 'http://www.inrsettle.com' },
    { SITE_URL: 'https://user:password@www.inrsettle.com' }, { CONTACT_DELIVERY: 'unknown' },
  ];
  for (const override of cases) {
    const handler = createContactHandler({ env: { ...env, ...override }, send: () => assert.fail('unexpected network call') });
    assert.deepEqual((await invoke(handler, request({ method: 'GET' }))).body, { available: false });
    assert.equal((await invoke(handler)).statusCode, 503);
  }
});

test('Telegram settings take priority automatically and partial settings do not silently fall back to email', async () => {
  const automatic = { ...env, CONTACT_DELIVERY: '', RESEND_API_KEY: 'fake-key', CONTACT_FROM: 'Website <website@example.test>' };
  assert.equal((await invoke(createContactHandler({ env: automatic }), request({ method: 'GET' }))).body.channel, 'telegram');
  const partial = { ...automatic, TELEGRAM_CHAT_ID: '' };
  assert.equal((await invoke(createContactHandler({ env: partial }), request({ method: 'GET' }))).body.available, false);
  assert.equal((await invoke(createContactHandler({ env: { ...partial, CONTACT_DELIVERY: 'email' } }), request({ method: 'GET' }))).body.channel, 'email');
});

test('Telegram receives the full inquiry and route only at the server-configured personal destination', async () => {
  let sent;
  const handler = createContactHandler({ env, send: async (url, options) => { sent = { url, options, body: JSON.parse(options.body) }; return accepted(); } });
  const res = await invoke(handler, request({ body: { ...data, chat_id: '666', TELEGRAM_BOT_TOKEN: 'visitor-value', to: 'other@example.test' } }));
  assert.equal(res.statusCode, 202);
  assert.equal(sent.url, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`);
  assert.equal(sent.body.chat_id, env.TELEGRAM_CHAT_ID);
  for (const value of [data.name, data.email, data.company, data.message, data.context, 'API integration', '$100k–$1m', headers['idempotency-key']]) assert.ok(sent.body.text.includes(value));
  assert.equal(sent.body.parse_mode, undefined);
  assert.deepEqual(sent.body.link_preview_options, { is_disabled: true });
  assert.ok(!JSON.stringify(res.body).includes(env.TELEGRAM_BOT_TOKEN));
});

test('invalid origins and honeypots cannot reach Telegram', async () => {
  const handler = createContactHandler({ env, send: () => assert.fail('unexpected delivery') });
  assert.equal((await invoke(handler, request({ headers: { ...headers, origin: 'https://attacker.test' } }))).statusCode, 403);
  assert.equal((await invoke(handler, request({ body: { ...data, website: 'spam' } }))).statusCode, 400);
});

test('Telegram errors, missing acknowledgements and wrong chats never report success or leak secrets', async () => {
  const responses = [
    () => new Response('{"ok":false}', { status: 403 }),
    () => new Response('{"ok":false}', { status: 200 }),
    () => new Response('{"ok":true,"result":{}}'),
    () => accepted('111'),
    () => new Response('{"ok":true,"result":{"message_id":42,"chat":{"id":987654321,"type":"group"}}}'),
    () => { throw new Error('timeout with credential-bearing URL'); },
  ];
  for (const send of responses) {
    const res = await invoke(createContactHandler({ env, send }));
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: 'delivery_failed' });
  }
});

test('long Unicode inquiries preserve all content and respect Telegram message bounds', async () => {
  const bodies = []; const signals = [];
  const message = '💡'.repeat(1000); const context = '🙂'.repeat(1000);
  const handler = createContactHandler({ env, send: async (_, options) => { bodies.push(JSON.parse(options.body)); signals.push(options.signal); return accepted(); } });
  assert.equal((await invoke(handler, request({ body: { ...data, message, context } }))).statusCode, 202);
  assert.equal(bodies.length, 2);
  const unprefixed = bodies.map(body => body.text.replace(/^INRSettle · [^\n]+\nPart \d+\/\d+\n\n/, '')).join('');
  assert.ok(unprefixed.includes(message)); assert.ok(unprefixed.includes(context));
  for (const body of bodies) { assert.ok(body.text.length <= 4096); assert.ok(body.text.isWellFormed()); }
  assert.equal(signals[0], signals[1]);
});

test('acknowledged Telegram parts are skipped when the remaining part is retried', async () => {
  const sent = []; let fail = true;
  const handler = createContactHandler({ env, send: async (_, options) => {
    sent.push(JSON.parse(options.body).text);
    if (sent.length === 2 && fail) { fail = false; return new Response('{"ok":false}', { status: 500 }); }
    return accepted();
  } });
  const req = () => request({ body: { ...data, message: 'a'.repeat(2000), context: 'b'.repeat(2000) } });
  assert.equal((await invoke(handler, req())).statusCode, 502);
  assert.equal((await invoke(handler, req())).statusCode, 202);
  assert.equal(sent.length, 3); assert.equal(sent[1], sent[2]); assert.notEqual(sent[0], sent[2]);
});

test('concurrent and acknowledged retries do not duplicate Telegram messages in a warm instance', async () => {
  let calls = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createContactHandler({ env, send: async () => { calls++; await gate; return accepted(); } });
  const first = invoke(handler); const second = invoke(handler);
  assert.equal(calls, 1); release();
  for (const res of await Promise.all([first, second])) assert.equal(res.statusCode, 202);
  assert.equal((await invoke(handler)).statusCode, 202); assert.equal(calls, 1);
  assert.equal((await invoke(handler, request({ body: { ...data, message: 'A changed inquiry must reach the team.' } }))).statusCode, 202);
  assert.equal(calls, 2);
});

test('Telegram retry state expires and destination changes cannot reuse an old acknowledgement', async () => {
  let clock = 0; let calls = 0;
  const settings = { ...env };
  const handler = createContactHandler({ env: settings, now: () => clock, send: async (_, options) => { calls++; return accepted(JSON.parse(options.body).chat_id); } });
  await invoke(handler); await invoke(handler); assert.equal(calls, 1);
  settings.TELEGRAM_CHAT_ID = '12345'; await invoke(handler); assert.equal(calls, 2);
  clock = 600001; await invoke(handler); assert.equal(calls, 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the shipped contact controller against an isolated DOM fixture.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const controller = app.slice(app.indexOf('  const contactForm ='), app.indexOf('  function showInquiryPrivacy()'));
function formFixture(send) {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: false, disabled: false, textContent: '', innerHTML: '', listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      classList: { toggle() {} }, focus() {},
    });
    return elements.get(selector);
  };
  const values = { name: 'Test Operator', email: 'operator@example.test', company: 'Example Co', interest: 'integration', volume: 'evaluating', message: 'Supplier settlement into India.', context: '', website: '' };
  const form = $('#contact-form');
  form.reportValidity = () => true;
  form.elements = { interest: {}, volume: {}, context: {} };
  form.resets = 0; form.reset = () => { form.resets++; };
  $('#contact-result').hidden = true;
  let navigation = 0;
  const window = { location: { set href(value) { navigation++; } } };
  const context = { $, icon: () => '<svg></svg>', window, document: { addEventListener() {} },
    crypto: { randomUUID: () => '89dd4ae1-a769-4ccd-a8ba-2ff169d2d731' }, AbortSignal,
    FormData: class { constructor() { return Object.entries(values); } }, fetch: send };
  runInNewContext(controller, context);
  return { $, values, form, check: context.checkInquiryDelivery, submit: () => form.listeners.submit({ preventDefault() {} }), navigation: () => navigation };
}

test('unavailable or failed readiness never opens email and submission still retries the server', async () => {
  for (const failedReadiness of [false, true]) {
    const calls = [];
    const fixture = formFixture(async (_, options) => {
      calls.push(options);
      if (options.method === 'POST') return new Response('{"accepted":true}', { status: 202 });
      if (failedReadiness) throw new Error('network unavailable');
      return new Response('{"available":false}');
    });
    await fixture.check();
    assert.match(fixture.$('#contact-submit').innerHTML, /^Send Inquiry/);
    await fixture.submit();
    assert.equal(calls[1].method, 'POST');
    assert.equal(JSON.parse(calls[1].body).message, fixture.values.message);
    assert.equal(fixture.navigation(), 0);
    assert.equal(fixture.$('#contact-result').hidden, false);
    assert.equal(fixture.form.resets, 1);
  }
});

test('clicking submit before readiness completes still posts, and a late check cannot replace Sending', async () => {
  let releaseCheck; let releaseSubmit; let posts = 0;
  const fixture = formFixture(async (_, options) => {
    if (options.method === 'POST') { posts++; return new Promise(resolve => { releaseSubmit = resolve; }); }
    return new Promise(resolve => { releaseCheck = resolve; });
  });
  const check = fixture.check(); const submission = fixture.submit();
  assert.equal(posts, 1); assert.equal(fixture.$('#contact-submit').textContent, 'Sending…');
  releaseCheck(new Response('{"available":false}')); await check;
  assert.equal(fixture.$('#contact-submit').textContent, 'Sending…');
  releaseSubmit(new Response('{"accepted":true}', { status: 202 })); await submission;
  assert.equal(fixture.navigation(), 0);
});

test('failed or unacknowledged submission preserves the form and offers retry without launching email', async () => {
  for (const response of [() => new Response('{"error":"delivery_failed"}', { status: 502 }), () => new Response('{}'), () => { throw new Error('timeout'); }]) {
    const fixture = formFixture(async () => response());
    await fixture.submit();
    assert.equal(fixture.navigation(), 0);
    assert.equal(fixture.form.resets, 0);
    assert.equal(fixture.form.hidden, false);
    assert.equal(fixture.$('#contact-result').hidden, true);
    assert.equal(fixture.$('#contact-status').hidden, false);
    assert.match(fixture.$('#contact-status').textContent, /couldn’t confirm submission/);
    assert.equal(fixture.$('#contact-submit').disabled, false);
  }
});

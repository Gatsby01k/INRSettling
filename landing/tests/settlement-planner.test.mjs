import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, planBrief, currencies, purposes, volumes } from '../public/settlement-planner.js';

const selection = { direction: 'to-india', currency: 'USDC', purpose: 'supplier-payments', volume: 'evaluating' };
test('direction changes both settlement legs and India beneficiary requirements', () => {
  const inbound = buildPlan(selection);
  const outbound = buildPlan({ ...selection, direction: 'from-india' });
  assert.equal(inbound.title, 'USDC → INR');
  assert.match(inbound.checks[0].text, /IFSC/);
  assert.equal(outbound.title, 'INR → USDC');
  assert.equal(outbound.deliveryLabel, 'Digital currency destination');
  assert.match(outbound.checks[0].text, /overseas beneficiary/);
  const fiat = buildPlan({ ...selection, direction: 'from-india', currency: 'AED' });
  assert.equal(fiat.deliveryLabel, 'Overseas bank destination');
});
test('commercial evidence follows the selected business use', () => {
  const invoice = buildPlan(selection).checks[1].text;
  const platform = buildPlan({ ...selection, purpose: 'platform-payouts' }).checks[1].text;
  assert.match(invoice, /Invoice, supplier/);
  assert.match(platform, /Payee records/);
  assert.notEqual(invoice, platform);
});
test('every selectable brief contains its route, purpose, volume and contact without promising coverage', () => {
  for (const direction of ['to-india', 'from-india']) for (const currency of Object.keys(currencies)) for (const purpose of Object.keys(purposes)) for (const volume of Object.keys(volumes)) {
    const plan = buildPlan({ direction, currency, purpose, volume });
    const brief = planBrief(plan);
    for (const value of [plan.title, plan.directionLabel, plan.purposeLabel, plan.volumeLabel, plan.note, 'info@inrsettle.com']) assert.ok(brief.includes(value));
    assert.ok(brief.length <= 2000, 'Brief must fit the inquiry context field');
    assert.match(brief, /eligibility and commercial terms are confirmed/);
  }
});
test('unrecognised and inherited selections are rejected', () => {
  for (const [key, value] of [['direction', 'invalid'], ['currency', 'toString'], ['purpose', 'unknown'], ['volume', '__proto__']]) {
    assert.throws(() => buildPlan({ ...selection, [key]: value }), TypeError);
  }
});

import { buildPlan, planBrief } from './settlement-planner.js';
import { mountPicker } from './planner-picker.js';

const $ = selector => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const scenarios = {
  psps: {
    label: 'For payment service providers', title: 'Embed India settlement into your payment product.',
    text: 'Connect payment instructions, INR liquidity and settlement updates while keeping your own customer experience.',
    steps: [['01', 'Send the instruction', 'Recipient, amount, payment purpose and your customer reference.'], ['02', 'Coordinate execution', 'Funding, agreed route and requirements in the same workflow.'], ['03', 'Return the result', 'Status and settlement references back to your platform.']],
    interest: 'integration'
  },
  merchants: {
    label: 'For merchants & platforms', title: 'Keep cross-border receipts connected to the business.',
    text: 'Scope international customer receipts and supplier obligations around the currencies you use and the records your finance team needs.',
    steps: [['01', 'Link the business', 'Merchant, invoice or order reference and settlement purpose.'], ['02', 'Define the destination', 'Agreed currency, beneficiary and settlement terms.'], ['03', 'Close the books', 'Match the movement to the original commercial reference.']],
    interest: 'settlements'
  },
  otc: {
    label: 'For OTC desks & liquidity teams', title: 'Connect the fiat and digital sides of the trade.',
    text: 'Plan INR and stablecoin settlement around counterparty obligations, funding readiness and a clear execution handoff.',
    steps: [['01', 'Define the obligation', 'Counterparty, currencies, size and the agreed trade reference.'], ['02', 'Check the handoff', 'Funding availability, execution sequence and route requirements.'], ['03', 'Reconcile both legs', 'Match fiat references and digital settlement evidence.']],
    interest: 'settlements'
  },
  operators: {
    label: 'For payment operations teams', title: 'Know what is ready. Know what needs attention.',
    text: 'Give operations a consistent way to follow payment requirements, execution updates and reconciliation across India-linked flows.',
    steps: [['01', 'Review requirements', 'Identify missing beneficiary, purpose or funding information.'], ['02', 'Follow execution', 'Keep stage changes and provider references in context.'], ['03', 'Resolve exceptions', 'Trace the mismatch back to the instruction and evidence.']],
    interest: 'integration'
  },
  banks: {
    label: 'For banks & institutional partners', title: 'Connect local INR rails to cross-border demand.',
    text: 'Structure the institutional handoff around customer eligibility, payment purpose and clearly agreed settlement responsibilities.',
    steps: [['01', 'Define responsibilities', 'Entity roles, jurisdictions and the permitted payment flow.'], ['02', 'Agree the bank leg', 'Beneficiary data, route, funding and operating windows.'], ['03', 'Align the records', 'Provider references, reporting and reconciliation expectations.']],
    interest: 'partnership'
  }
};
let activeRole = 'psps';
function renderScenario(role) {
  const scenario = scenarios[role];
  if (!scenario) return;
  activeRole = role;
  $('#scenario-label').textContent = scenario.label;
  $('#scenario-title').textContent = scenario.title;
  $('#scenario-description').textContent = scenario.text;
  $('#scenario-steps').innerHTML = scenario.steps.map(([number, title, text]) => `<div class="scenario-step"><span>${number}</span><h4>${title}</h4><p>${text}</p></div>`).join('');
  $('#scenario-status').textContent = `Showing ${scenario.label.toLowerCase()} workflow.`;
}
document.addEventListener('inrsettle:role-change', event => renderScenario(event.detail.role));
$('#scenario-contact').addEventListener('click', () => {
  const scenario = scenarios[activeRole];
  document.dispatchEvent(new CustomEvent('inrsettle:inquiry', { detail: { interest: scenario.interest, context: `${scenario.label}\n${scenario.title}`, contextLabel: scenario.label } }));
});
renderScenario(activeRole);

const planner = $('#corridor-planner');
const currencyAssets = {
  INR: ['Indian rupee', 'inr-mark.svg'], USDC: ['USD Coin', 'usdc.svg'], USDT: ['Tether USD', 'usdt.svg'],
  USD: ['US dollar', 'usd.svg'], EUR: ['Euro', 'eur-mark.svg'], AED: ['UAE dirham', 'aed.svg'], SGD: ['Singapore dollar', 'sgd.svg']
};
const currencyArt = code => `<img class="picker-currency-icon" src="/assets/currencies/${currencyAssets[code][1]}" width="32" height="32" alt="">`;
mountPicker($('.picker-currency'), ['USDC', 'USDT', 'USD', 'EUR', 'AED', 'SGD'].map(value => ({ value, label: value, note: currencyAssets[value][0], art: currencyArt(value) })));
mountPicker($('.picker-purpose'), [
  { value: 'supplier-payments', label: 'Supplier payments', note: 'Goods & services', art: icon('file') },
  { value: 'merchant-settlement', label: 'Merchant settlement', note: 'Customer receipts', art: icon('cart') },
  { value: 'platform-payouts', label: 'Platform payouts', note: 'Marketplace payees', art: icon('users') },
  { value: 'treasury-liquidity', label: 'Treasury & liquidity', note: 'Business funding', art: icon('bank') }
]);
mountPicker($('.picker-volume'), [
  { value: 'evaluating', label: 'Still evaluating', note: 'Explore the fit', art: icon('search') },
  { value: 'under-100k', label: 'Under $100k', note: 'Per month', art: icon('chart') },
  { value: '100k-1m', label: '$100k–$1m', note: 'Per month', art: icon('chart') },
  { value: 'over-1m', label: 'Over $1m', note: 'Per month', art: icon('chart') }
]);
let direction = 'to-india';
let currentPlan;
function renderPlan() {
  currentPlan = buildPlan({ direction, currency: $('#plan-currency').value, purpose: $('#plan-purpose').value, volume: $('#plan-volume').value });
  $('#plan-currency-label').textContent = direction === 'to-india' ? 'Funding currency' : 'Settlement currency';
  $('#plan-title').textContent = currentPlan.title;
  $('#plan-purpose-result').textContent = currentPlan.purposeLabel;
  for (const [side, code] of [['source', currentPlan.funding], ['destination', currentPlan.delivery]]) {
    $(`#plan-${side}`).innerHTML = currencyArt(code);
    $(`#plan-${side}`).setAttribute('role', 'img');
    $(`#plan-${side}`).setAttribute('aria-label', currencyAssets[code][0]);
    $(`#plan-${side}-code`).textContent = code;
  }
  $('#plan-source-label').textContent = currentPlan.fundingLabel;
  $('#plan-destination-label').textContent = currentPlan.deliveryLabel;
  $('#plan-checks').innerHTML = currentPlan.checks.map(check => `<li>${icon('check')}<div><strong>${check.title}</strong><p>${check.text}</p></div></li>`).join('');
  $('#plan-note').textContent = currentPlan.note;
  $('#plan-announcement').textContent = `${currentPlan.directionLabel}. ${currentPlan.title}. ${currentPlan.purposeLabel}.`;
}
planner.addEventListener('change', renderPlan);
$('#plan-direction').addEventListener('click', event => {
  const button = event.target.closest('[data-direction]');
  if (!button) return;
  direction = button.dataset.direction;
  document.querySelectorAll('[data-direction]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderPlan();
});
$('#plan-contact').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('inrsettle:inquiry', { detail: { interest: 'settlements', volume: currentPlan.volume, context: planBrief(currentPlan), contextLabel: `${currentPlan.title} · ${currentPlan.purposeLabel} · ${currentPlan.volumeLabel}` } }));
});
$('#plan-download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([planBrief(currentPlan)], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `INRSettle-${currentPlan.funding}-${currentPlan.delivery}-brief.txt`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.querySelectorAll('[data-inquiry-interest]').forEach(button => button.addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('inrsettle:inquiry', { detail: { interest: button.dataset.inquiryInterest } }));
}));
renderPlan();

import { buildPlan, planBrief } from './settlement-planner.js';

const $ = selector => document.querySelector(selector);
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
const currency = $('#plan-currency');
const directions = $('#plan-direction');
let direction = 'to-india';
let currentPlan;
const routeSignal = $('.journey-signal');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let routeAnimation;

function renderPlan() {
  const previousRoute = currentPlan?.title;
  currentPlan = buildPlan({ direction, currency: currency.value, purpose: $('#plan-purpose').value, volume: $('#plan-volume').value });
  $('#plan-currency-label').textContent = direction === 'to-india' ? 'Funding currency' : 'Delivery currency';
  $('#plan-title').textContent = currentPlan.title;
  $('#plan-purpose-result').textContent = currentPlan.purposeLabel;
  $('#plan-volume-result').textContent = currentPlan.volumeLabel;
  $('#plan-source-code').textContent = currentPlan.funding;
  $('#plan-destination-code').textContent = currentPlan.delivery;
  $('#plan-source-label').textContent = currentPlan.fundingLabel;
  $('#plan-destination-label').textContent = currentPlan.deliveryLabel;
  $('#plan-checks').innerHTML = currentPlan.checks.map(check => `<li><strong>${check.title}</strong><p>${check.text}</p></li>`).join('');
  $('#plan-note').textContent = currentPlan.note;
  $('#plan-announcement').textContent = `${currentPlan.directionLabel}. ${currentPlan.title}. ${currentPlan.purposeLabel}. ${currentPlan.volumeLabel}.`;
  if (previousRoute && previousRoute !== currentPlan.title && !reducedMotion.matches) {
    routeAnimation?.cancel();
    routeAnimation = routeSignal.animate(
      [{ transform: 'translateX(-100%)', opacity: 0 }, { opacity: 1, offset: .2 },
        { opacity: 1, offset: .75 }, { transform: 'translateX(330%)', opacity: 0 }],
      { duration: 720, easing: 'cubic-bezier(.2,.65,.25,1)' }
    );
  }
}
planner.addEventListener('change', renderPlan);
function setDirection(next) {
  direction = next;
  directions.querySelectorAll('[data-direction]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.direction === direction)));
}

directions.addEventListener('click', event => {
  const button = event.target.closest('[data-direction]');
  if (!button) return;
  setDirection(button.dataset.direction);
  renderPlan();
});

const routeExamples = $('#hero-route-examples');
$('#hero-plan').addEventListener('click', event => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const selected = routeExamples.querySelector('input:checked');
  setDirection(selected.dataset.direction);
  currency.value = selected.value;
  currency.dispatchEvent(new Event('change', { bubbles: true }));
});
routeExamples.hidden = false;
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

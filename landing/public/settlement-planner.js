// A corridor discovery guide, never a quote, coverage promise or payment request.
export const currencies = {
  USDC: 'USDC', USDT: 'USDT', USD: 'US dollar', EUR: 'Euro', AED: 'UAE dirham', SGD: 'Singapore dollar'
};
export const purposes = {
  'supplier-payments': 'Supplier & service payments',
  'merchant-settlement': 'Merchant settlement',
  'platform-payouts': 'Platform & marketplace payouts',
  'treasury-liquidity': 'Treasury & liquidity movement'
};
export const volumes = {
  evaluating: 'Still evaluating', 'under-100k': 'Under $100k / month',
  '100k-1m': '$100k–$1m / month', 'over-1m': 'Over $1m / month'
};
export function buildPlan({ direction, currency, purpose, volume }) {
  if (!['to-india', 'from-india'].includes(direction) || !Object.hasOwn(currencies, currency) || !Object.hasOwn(purposes, purpose) || !Object.hasOwn(volumes, volume)) {
    throw new TypeError('Invalid corridor discovery selection');
  }
  const inbound = direction === 'to-india';
  const digital = ['USDC', 'USDT'].includes(currency);
  const purposeEvidence = {
    'supplier-payments': 'Invoice, supplier details and the nature of goods or services.',
    'merchant-settlement': 'Merchant identity, underlying transaction records and settlement references.',
    'platform-payouts': 'Payee records, the platform’s business model and payout purpose.',
    'treasury-liquidity': 'Entity relationships, source of funds and the purpose of the movement.'
  }[purpose];
  return {
    direction, currency, purpose, volume,
    title: inbound ? `${currency} → INR` : `INR → ${currency}`,
    funding: inbound ? currency : 'INR', delivery: inbound ? 'INR' : currency,
    directionLabel: inbound ? 'World → India' : 'India → World',
    purposeLabel: purposes[purpose], volumeLabel: volumes[volume],
    fundingLabel: inbound ? (digital ? 'Digital currency funding' : 'Cross-border fiat funding') : 'Local INR funding',
    deliveryLabel: inbound ? 'Indian bank destination' : (digital ? 'Digital currency destination' : 'Overseas bank destination'),
    checks: [
      { title: 'Business & recipient', text: inbound ? 'Business identity, recipient account and IFSC details for the Indian bank leg.' : 'Indian entity, overseas beneficiary and destination-specific bank or wallet details.' },
      { title: 'Purpose & evidence', text: purposeEvidence },
      { title: 'Route & terms', text: 'Permitted route, funding method, FX, fees, limits and delivery windows to confirm.' },
      { title: 'Settlement record', text: 'Instruction reference, status updates, delivery evidence and reconciliation handoff.' }
    ],
    note: 'Indicative workflow. Supported routes, eligibility and commercial terms are confirmed for your business during onboarding.'
  };
}
export function planBrief(plan) {
  return [
    'INRSETTLE — CORRIDOR DISCOVERY BRIEF',
    'Cross-border settlement infrastructure for India', '',
    `Direction: ${plan.directionLabel}`, `Proposed currencies: ${plan.title}`,
    `Business use: ${plan.purposeLabel}`, `Indicative volume: ${plan.volumeLabel}`, '',
    'POINTS TO REVIEW', ...plan.checks.map((check, i) => `${i + 1}. ${check.title}: ${check.text}`), '',
    plan.note, '', 'Contact: info@inrsettle.com'
  ].join('\n');
}

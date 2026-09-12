import {escapeHtml as esc} from './data.js';

export const currencies = {
  INR: {name:'Indian rupee',file:'inr.svg'},
  USDC: {name:'USD Coin',file:'usdc.svg'},
  USDT: {name:'Tether USD',file:'usdt.svg'},
  EURC: {name:'Euro Coin',file:'eurc.png'},
  AED: {name:'UAE dirham',file:'aed.svg'},
  USD: {name:'US dollar',file:'usd.svg'},
  SGD: {name:'Singapore dollar',file:'sgd.svg'}
};

export function currencyIcon(code,modifier='') {
  const asset=currencies[code];
  if(!asset)return `<span class="asset-icon asset-icon--unknown" aria-label="${esc(code)}">${esc(code.slice(0,3))}</span>`;
  return `<span class="asset-icon asset-icon--${code.toLowerCase()} ${modifier}" role="img" aria-label="${asset.name}"><img src="/assets/currencies/${asset.file}" width="32" height="32" alt="" decoding="async"></span>`;
}

export function currencyPair({from,to}) {
  return `<span class="route-pair" aria-label="${esc(from)} to ${esc(to)}"><span class="route-asset">${currencyIcon(from)}<span>${esc(from)}</span></span><svg viewBox="0 0 20 20" class="route-arrow" aria-hidden="true"><path d="M3 10h13m-4-4 4 4-4 4"/></svg><span class="route-asset">${currencyIcon(to)}<span>${esc(to)}</span></span></span>`;
}

export function rupeeMark() {
  return '<svg class="rupee-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M8 7h17M8 12h17M10 7c11 0 11 11 0 11H8l12 10" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

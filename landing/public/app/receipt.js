import {escapeHtml as esc,money,displayDate,settlementTimeline,settlementFacts} from './data.js';
import {currencyIcon} from './currency.js';

export function receiptModel(record,company='Acme Global Pvt Ltd') {
  const timeline=settlementTimeline(record),last=timeline.at(-1);
  const complete=record.status==='Settled'&&last?.phase==='complete'&&Boolean(last.at);
  return {
    record:{...record},company,complete,timeline,facts:settlementFacts(record),
    title:complete?'Settlement receipt':'Settlement report',
    number:`${complete?'RCP':'RPT'}-${record.id.replace(/^STL-/,'')}`,
    completedAt:complete?last.at:null
  };
}

const timestamp=at=>at?`${displayDate(at.slice(0,10))} · ${at.slice(11,16)} UTC`:'Not recorded';
const amount=(value,code)=>Number(value).toLocaleString(code==='INR'?'en-IN':'en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

export function recordMarkup(model,icon) {
  const {record:s,complete,timeline,facts}=model;
  const rows=[
    ['Settlement ID',s.id],['Client reference',s.reference||'Not provided'],
    ['Payout network',facts.network.name],['Created',timestamp(timeline[0].at)],
    ['Compliance',facts.compliance],['Liquidity',facts.liquidity],
    ['Recorded fee',s.fee!=null&&Number.isFinite(Number(s.fee))?money(s.fee,s.feeCurrency||s.from,2):'Not recorded'],
    [complete?'Completed':'Last recorded event',timestamp(complete?model.completedAt:[...timeline].reverse().find(t=>t.at)?.at)]
  ];
  return `<article class="receipt-paper ${complete?'receipt-paper--complete':'receipt-paper--report'}" aria-label="${esc(model.title)} for ${esc(s.id)}">
    <div class="receipt-ribbon" aria-hidden="true"></div>
    <header class="receipt-masthead"><img class="receipt-brand" src="/assets/brand-lockup.svg" width="934" height="152" alt="INRSettle"><div class="receipt-edition"><span>SETTLEMENT RECORD</span><strong>${esc(model.number)}</strong></div></header>
    <div class="receipt-title-row"><h2 id="dialog-title">${esc(model.title)}</h2><span class="receipt-demo-label">Sample document</span></div>
    <section class="receipt-hero">
      <img class="receipt-watermark" src="/assets/brand-symbol.svg" width="200" height="200" alt="" aria-hidden="true">
      <div class="receipt-confirmation"><span class="receipt-seal">${icon(complete?'check':s.status==='Cancelled'?'info':'clock')}</span><div><strong>${complete?'Settlement completed':esc(s.status)}</strong><span>${complete?timestamp(model.completedAt):'Completion not confirmed'}</span></div></div>
      <span class="receipt-amount-label">${complete?'Amount delivered':'Expected receive amount'}</span>
      <div class="receipt-total"><strong>${amount(s.receive,s.to)}</strong><span>${currencyIcon(s.to)}${esc(s.to)}</span></div>
      <p class="receipt-beneficiary">${complete?'Delivered to':'Beneficiary'} <strong>${esc(s.name)}</strong><span>${esc(s.country)}</span></p>
    </section>
    <section class="receipt-route" aria-label="Transfer route"><div><span>Source amount</span><strong>${money(s.send,s.from,2)}</strong><small>${currencyIcon(s.from)}${esc(s.from)}</small></div><div class="receipt-route-center" aria-hidden="true"><span></span><img src="/assets/brand-symbol.svg" width="36" height="36" alt=""><span>${icon('arrow')}</span></div><div><span>${complete?'Delivered amount':'Expected amount'}</span><strong>${money(s.receive,s.to,2)}</strong><small>${currencyIcon(s.to)}${esc(s.to)}</small></div></section>
    <div class="receipt-parties"><div><span>Workspace</span><strong>${esc(model.company)}</strong></div><div><span>Beneficiary</span><strong>${esc(s.name)}</strong><small>${esc(s.country)}</small></div></div>
    <section class="receipt-details"><h3>Settlement details</h3><dl>${rows.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section>
    <section class="receipt-events"><div class="receipt-section-title"><h3>Recorded timeline</h3><span>All times UTC</span></div><ol>${timeline.map((event,index)=>`<li class="receipt-event receipt-event--${event.phase}" style="--event-order:${index}"><span class="receipt-event-marker">${icon(event.phase==='complete'?'check':event.phase==='failed'?'x':'clock')}</span><div><strong>${esc(event.title)}</strong><small>${esc(event.note)}</small></div><time ${event.at?`datetime="${event.at}"`:''}>${event.at?`${event.at.slice(8,10)} ${displayDate(event.at.slice(0,10)).split(' ')[0]} · ${event.at.slice(11,16)}`:'—'}</time></li>`).join('')}</ol></section>
    <footer class="receipt-foot"><p>Illustrative product data. This sample document is not proof of payment.</p><div><span>${esc(model.number)}</span><strong>People. Payments. Progress.</strong><span>INRSETTLE</span></div></footer>
  </article>`;
}

const resourceCache=new Map();
function localAsset(path) {
  if(!resourceCache.has(path))resourceCache.set(path,fetch(path).then(async response=>{
    if(!response.ok)throw new Error('Receipt resource unavailable');
    const blob=await response.blob();
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
  }).catch(error=>{resourceCache.delete(path);throw error;}));
  return resourceCache.get(path);
}

// A standalone, offline-capable record. It embeds the same brand and currency
// assets as the on-screen receipt, and retains the sample-data attribution.
export async function recordDocument(model,icon) {
  let markup=recordMarkup(model,icon);
  const paths=[...new Set([...markup.matchAll(/src="(\/assets\/[^\"]+)"/g)].map(match=>match[1]))];
  const [cssResponse,regular,bold,...assets]=await Promise.all([
    fetch('/app/receipt.css'),localAsset('/assets/regular.otf'),localAsset('/assets/bold.otf'),...paths.map(localAsset)
  ]);
  if(!cssResponse.ok)throw new Error('Receipt stylesheet unavailable');
  const css=await cssResponse.text();
  paths.forEach((path,index)=>{markup=markup.replaceAll(`src="${path}"`,`src="${assets[index]}"`);});
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(model.number)} · INRSettle</title><style>@font-face{font-family:INRSans;src:url('${regular}')}@font-face{font-family:INRSans;src:url('${bold}');font-weight:600 900}${css}</style></head><body class="receipt-document"><div class="receipt-export-tools"><span>${esc(model.title)} · ${esc(model.record.id)}</span><button onclick="window.print()">Print / Save PDF</button></div>${markup}</body></html>`;
}

import {escapeHtml as esc, money, routeQuote} from './data.js';
import {currencyIcon} from './currency.js';

// These are presentation models for the existing local demo, not payment events.
export function preflightAssessment(w, beneficiary) {
  const quote=routeQuote(w.amount,w.from,w.currency);
  const amount=Number(w.amount),minimum=w.from==='INR'?1000:10,maximum=w.from==='INR'?100000000:1000000;
  const validAmount=Number.isFinite(amount)&&amount>=minimum&&amount<=maximum;
  const verified=beneficiary?.status==='Verified';
  const available=Boolean(quote)&&validAmount;
  return {
    ready:verified&&available,
    checks:[
      {key:'beneficiary',label:'Beneficiary',detail:beneficiary?.name||'Choose a beneficiary',state:verified?'passed':'attention',result:verified?'Verified':'Review needed'},
      {key:'compliance',label:'Compliance',detail:'KYC · AML · Sanctions',state:verified?'passed':'pending',result:verified?'Sample checks cleared':'Awaiting review'},
      {key:'liquidity',label:'Liquidity',detail:'Availability for this sample route',state:available?'passed':'pending',result:available?'Available in preview':'Not assessed'},
      {key:'route',label:'Route',detail:`${w.from} → ${w.currency}`,state:available?'passed':'attention',result:available?'Route available':'Check amount & currencies'}
    ]
  };
}

export function attentionGroups(rows) {
  return [
    {key:'review',status:'Action required',one:'beneficiary review',many:'beneficiary reviews',icon:'shield'},
    {key:'cancelled',status:'Cancelled',one:'cancelled settlement',many:'cancelled settlements',icon:'info'},
    {key:'approval',status:'Ready',one:'awaiting approval',many:'awaiting approval',icon:'clock'}
  ].map(group=>({...group,count:rows.filter(row=>row.status===group.status).length})).filter(group=>group.count);
}

export function routeBridge() {
  const wire=side=>`<svg class="transfer-wire transfer-wire--${side}" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true"><path class="wire-track" d="M0 8H100"/><path class="wire-packet" d="M0 8H100" pathLength="100"/></svg>`;
  return `<div class="transfer-bridge" aria-hidden="true">${wire('source')}<span class="transfer-hub"><img src="/assets/brand-symbol.svg" width="44" height="44" alt=""></span>${wire('destination')}</div>`;
}

export function routeSummary(w,ready=false) {
  const quote=routeQuote(w.amount,w.from,w.currency);
  return `<section class="transfer-summary ${ready?'route-confirmed':''}" data-route-motion aria-label="${esc(w.from)} to ${esc(w.currency)} route">
    <div class="transfer-summary-leg"><span class="transfer-label">You send</span><strong>${money(w.amount,w.from)}</strong><span class="transfer-asset">${currencyIcon(w.from)}${esc(w.from)}</span></div>
    <div class="transfer-summary-leg"><span class="transfer-label">Estimated receipt</span><strong>${quote?money(quote.receive,w.currency,2):'—'}</strong><span class="transfer-asset">${currencyIcon(w.currency)}${esc(w.currency)}</span></div>
    ${routeBridge()}
  </section>`;
}

export function preflightMarkup(assessment,icon) {
  return `<section class="flight-panel" aria-label="Preflight results"><div class="flight-heading"><h3>Preflight results</h3><span>Demo checks</span></div><ol class="flight-checks">${assessment.checks.map((check,index)=>`<li class="flight-check flight-check--${check.state}" style="--check-order:${index}"><span class="flight-check-icon">${icon(check.state==='passed'?'check':check.state==='attention'?'info':'clock')}</span><div><strong>${esc(check.label)}</strong><small>${esc(check.detail)}</small></div><span class="flight-result">${esc(check.result)}</span></li>`).join('')}</ol></section>`;
}

import {escapeHtml as esc,money,displayDate,settlementFacts,settlementTimeline} from './data.js';
import {currencyIcon} from './currency.js';

export function settlementDetail(s,{icon,status,btn}) {
  if(!s)return '';
  const facts=settlementFacts(s),timeline=settlementTimeline(s);
  const information=[
    ['user','Beneficiary',s.name,s.country,'wide'],
    ['file','Reference',s.reference,'','wide reference'],
    ['shield','Compliance',facts.compliance,'KYC · AML · Sanctions',facts.compliance==='Cleared'?'cleared':''],
    ['lock','Liquidity',facts.liquidity,facts.liquidity==='Secured'?money(s.send,s.from):facts.liquidity==='Released'?'Back in your available figure':'Secured when you settle it',''],
    ['network','Corridor',s.from+' → '+s.to,s.to==='INR'?'Local payout':'Global payout',''],
    ['layers','Payout network',facts.network.name,s.to+' '+(facts.network.kind==='chain'?'payout':'bank transfer'),'']
  ];
  return `<aside class="sd-card" aria-label="Settlement details for ${s.id}">
    <header class="sd-header"><h2>Settlement Details</h2><button class="icon-button" type="button" data-action="close-detail" aria-label="Close settlement details">${icon('x')}</button></header>
    <div class="sd-body">
      <div class="sd-identity"><h3>${s.id}</h3><button class="icon-button sd-copy" type="button" data-action="copy-id" data-id="${s.id}" aria-label="Copy settlement ID">${icon('copy')}</button></div>
      <div class="sd-meta"><time datetime="${s.date}T${s.time}:00">${displayDate(s.date)} · ${s.time}</time>${status(s.status)}</div>
      <section class="sd-transfer" aria-label="Transfer amounts">
        <div class="sd-amount sd-source"><span class="sd-currency">${currencyIcon(s.from)}<span>${s.from}</span></span><strong>${money(s.send,s.from)}</strong><small>You fund</small></div>
        <div class="sd-amount sd-destination"><span class="sd-currency">${currencyIcon(s.to)}<span>${s.to}</span></span><strong>${money(s.receive,s.to)}</strong><small>Recipient gets</small></div>
        <div class="sd-connection" aria-hidden="true"><span class="sd-source-line"></span><img src="/assets/brand-wordmark.svg" width="934" height="95" alt=""><span class="sd-destination-line">${icon('arrow')}</span></div>
      </section>
      ${s.status==='Action required'?`<div class="sd-alert"><span>${icon('info')}</span><div><strong>Beneficiary review required</strong><p>Complete verification to continue.</p>${btn('Review Beneficiary','review-beneficiary','arrow','',`data-name="${esc(s.name)}"`)}</div></div>`:''}
      ${s.status==='Cancelled'?`<div class="sd-alert sd-alert--failed"><span>${icon('info')}</span><div><strong>This settlement was cancelled</strong><p>${esc(s.resolution??'No money was sent.')}</p></div></div>`:''}
      <dl class="sd-facts">${information.map(([ico,label,value,note,cls])=>`<div class="sd-fact ${cls}"><span class="sd-fact-icon">${icon(ico)}</span><div><dt>${label}</dt><dd>${esc(value)}${note?`<small>${esc(note)}</small>`:''}</dd></div></div>`).join('')}</dl>
      <div class="sd-section-heading"><h3>Settlement Timeline</h3><button class="sd-record" type="button" data-action="transaction" data-id="${s.id}">View Record ${icon('arrow')}</button></div>
      <ol class="sd-timeline">${timeline.map(t=>`<li class="sd-step sd-step--${t.phase}" ${t.phase==='active'?'aria-current="step"':''}><span class="sd-step-marker">${icon(t.phase==='complete'?'check':t.phase==='cancelled'?'x':t.phase==='attention'?'info':'clock')}</span><div><strong>${t.title}</strong><p>${t.note}</p></div><time ${t.at?`datetime="${t.at}" title="${displayDate(t.at.slice(0,10))} · ${t.at.slice(11,16)}"`:''}>${t.at?t.at.slice(11,16):'—'}</time></li>`).join('')}</ol>
    </div>
    <footer class="sd-actions">${btn('Download Report','download-report','download','',`data-id="${s.id}"`)}${btn('Create Similar','create-similar','copy','',`data-id="${s.id}"`)}</footer>
  </aside>`;
}

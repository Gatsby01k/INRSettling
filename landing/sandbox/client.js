const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let apiKey = '', beneficiaries = [], selected = '', polling = false;
let preparation = null;
const intents = new Map();
function message(text, failed = false) { $('#message').textContent = text; $('#message').className = failed ? 'error' : 'success'; }
function operationKey(operation, value) {
  const fingerprint = operation + JSON.stringify(value);
  if (!intents.has(fingerprint)) intents.set(fingerprint, crypto.randomUUID());
  return intents.get(fingerprint);
}
async function api(path, {method='GET', body, key} = {}) {
  const response = await fetch('/v1' + path, { method, credentials:'omit', cache:'no-store',
    headers:{Authorization:'Bearer '+apiKey, ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(key ? {'Idempotency-Key':key} : {})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  const result = await response.json();
  if (!response.ok) throw new Error([result.error?.message, result.error?.detail, result.error?.request_id].filter(Boolean).join('\n'));
  return result;
}
async function action(button, run) {
  button.disabled = true;
  try { await run(); } catch(error) { message(error.message || 'Request failed. Retry with the same details.', true); }
  finally { button.disabled = false; }
}
async function refresh() {
  if (!apiKey || polling) return;
  polling = true;
  try {
    const [people, settlements] = await Promise.all([api('/beneficiaries'), api('/settlements')]);
    beneficiaries = people.data;
    const previous = $('#beneficiary').value;
    $('#beneficiary').innerHTML = '<option value="">Choose a verified beneficiary</option>' + beneficiaries.filter(b => b.destination?.verification_status === 'verified').map(b => `<option value="${esc(b.id)}">${esc(b.display_name)} · ${esc(b.destination.account_number_last4)}</option>`).join('');
    $('#beneficiary').value = previous;
    $('#beneficiaries').innerHTML = beneficiaries.map(b => `<p>${esc(b.display_name)} · <span class="status">${esc(b.destination?.verification_status || b.status)}</span></p>`).join('');
    $('#settlements').innerHTML = settlements.data.length ? `<div class="table-scroll"><table><thead><tr><th>Reference</th><th>Recipient</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${settlements.data.map(s => `<tr><td>${esc(s.external_reference || s.id)}</td><td>${esc(s.beneficiary?.display_name || s.beneficiary_id)}</td><td>${esc(s.recipient_amount.display)}</td><td class="status">${esc(s.status?.replaceAll('_',' ') || 'Preparing')}</td><td><button class="secondary" data-view="${esc(s.id)}">View</button></td></tr>`).join('')}</tbody></table></div>` : '<p>No settlements yet. Add a beneficiary to get started.</p>';
    if (selected) await detail(selected);
  } finally { polling = false; }
}
async function detail(id) {
  const s = await api('/settlements/'+encodeURIComponent(id)); selected = id;
  const quote = s.quote_id ? await api('/quotes/'+encodeURIComponent(s.quote_id)) : null;
  const fees = quote?.fees?.map(f=>`${f.label}: ${f.amount.display}`).join(' · ') || '—';
  $('#detail').innerHTML = `<dl><dt>Settlement</dt><dd>${esc(s.id)}</dd><dt>Recipient receives</dt><dd>${esc(s.recipient_amount.display)}</dd><dt>Funding</dt><dd>${esc(quote?.funding_amount.display || '—')}</dd><dt>Fees</dt><dd>${esc(fees)}</dd><dt>Quote expires</dt><dd>${esc(quote?.expires_at || '—')}</dd><dt>Status</dt><dd class="status">${esc(s.status?.replaceAll('_',' ') || 'Preparing')}</dd></dl>${s.requirements?.length ? `<pre>${esc(JSON.stringify(s.requirements,null,2))}</pre>` : ''}<div class="actions">${s.status === 'ready' && s.quote_id ? `<button data-authorize="${esc(id)}">Authorize ${esc(s.recipient_amount.display)}</button>` : ''}${s.cancellable ? `<button class="secondary" data-cancel="${esc(id)}">Request cancellation</button>` : ''}${s.status === 'settled' ? `<button data-receipt="${esc(id)}">Download receipt</button><button class="secondary" data-record="${esc(id)}">View receipt record</button>` : ''}</div><pre id="record">${esc(s.resolution ? JSON.stringify(s.resolution,null,2) : 'Sandbox funds · simulated provider')}</pre>`;
}
$('#connect-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => {
  apiKey = $('#api-key').value.trim(); await refresh(); $('#api-key').value = ''; $('#workspace').hidden = false; $('#connection').hidden = true; message('Connected to your sandbox workspace.');
}).catch(()=>{}); });
$('#disconnect').addEventListener('click', () => { apiKey=''; selected=''; intents.clear(); $('#workspace').hidden=true; $('#connection').hidden=false; $('#events').textContent='No events loaded.'; $('#webhook-secret').textContent=''; message('Disconnected.'); });
$('#refresh').addEventListener('click', event=>action(event.currentTarget,refresh));
$('#scenario').addEventListener('change', event=>{ $('#account').value='501001234'+event.target.value; });
$('#beneficiary-form').addEventListener('submit', event=>{event.preventDefault();action(event.submitter,async()=>{
  const f = new FormData(event.target); const body = {display_name:f.get('name'),type:'individual',country:'IN',destination:{kind:'bank_account',account_number:f.get('account'),ifsc:f.get('ifsc'),account_type:'savings',account_holder_name:f.get('name')}};
  await api('/beneficiaries',{method:'POST',body,key:operationKey('beneficiary',body)}); await refresh(); message('Beneficiary saved. Verification is running.');
});});
$('#settlement-form').addEventListener('submit', event=>{event.preventDefault();action(event.submitter,async()=>{
  const f=new FormData(event.target); const amount=String(f.get('amount')); if(!/^\d+(\.\d{1,2})?$/.test(amount))throw new Error('Enter INR with up to two decimal places.');
  const [whole,fraction='']=amount.split('.'); const minor=(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'))).toString(); if(BigInt(minor)<=0n)throw new Error('Recipient amount must be positive.');
  const fingerprint=JSON.stringify([...f.entries()]);
  if(!preparation||preparation.fingerprint!==fingerprint)preparation={fingerprint,quoteKey:crypto.randomUUID(),settlementKey:crypto.randomUUID(),reference:f.get('reference')||'sandbox-'+crypto.randomUUID(),quote:null};
  const intent=preparation;
  const quoteBody={funding_currency:'USDT',recipient_amount:{currency:'INR',minor_units:minor}};
  if(!intent.quote)intent.quote=await api('/quotes',{method:'POST',body:quoteBody,key:intent.quoteKey});
  const body={beneficiary_id:f.get('beneficiary'),recipient_amount:{currency:'INR',minor_units:minor},funding_currency:'USDT',purpose_code:f.get('purpose'),quote_id:intent.quote.id,external_reference:intent.reference};
  const created=await api('/settlements',{method:'POST',body,key:intent.settlementKey}); preparation=null; selected=created.id; await detail(created.id); await refresh(); message('Instruction saved. Preflight is running; review its result before authorizing.');
});});
$('#workspace').addEventListener('click', event=>{
  const b=event.target.closest('button'); if(!b)return;
  if(b.dataset.view)return action(b,()=>detail(b.dataset.view));
  if(b.dataset.authorize)return action(b,async()=>{const id=b.dataset.authorize;await api(`/settlements/${id}/authorize`,{method:'POST',body:{},key:operationKey('authorize',id)});await refresh();message('Authorized. Execution continues in the background.');});
  if(b.dataset.cancel)return action(b,async()=>{const id=b.dataset.cancel;await api(`/settlements/${id}/cancel`,{method:'POST',body:{reason:'Requested from sandbox workspace'},key:operationKey('cancel',id)});await refresh();message('Cancellation response recorded. Check the settlement for the outcome.');});
  if(b.dataset.record)return action(b,async()=>{$('#record').textContent=JSON.stringify(await api(`/settlements/${b.dataset.record}/receipt`),null,2);});
  if(b.dataset.receipt)return action(b,async()=>{const r=await fetch('/workspace/receipt?settlement_id='+encodeURIComponent(b.dataset.receipt),{headers:{Authorization:'Bearer '+apiKey},credentials:'omit'});if(!r.ok)throw new Error((await r.json()).error.message);const link=document.createElement('a');link.href=URL.createObjectURL(await r.blob());link.download='settlement-receipt.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);});
});
$('#webhook-form').addEventListener('submit',event=>{event.preventDefault();action(event.submitter,async()=>{const body={url:new FormData(event.target).get('url')};const endpoint=await api('/webhook_endpoints',{method:'POST',body,key:operationKey('webhook',body)});$('#webhook-secret').textContent='Store this signing secret securely: '+endpoint.secret;message('Webhook endpoint created.');});});
setInterval(()=>{if(apiKey&&!document.hidden)refresh().catch(error=>message(error.message,true));},4000);
setInterval(()=>{if(apiKey&&!document.hidden)api('/events?limit=10').then(result=>{$('#events').textContent=JSON.stringify(result.data,null,2);}).catch(()=>{});},12000);

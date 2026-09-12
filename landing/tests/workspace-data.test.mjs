import test from 'node:test';
import assert from 'node:assert/strict';
import {routes,allRoutes,STATUSES,initialSettlements,initialBatches,batchStatus,filterSettlements,csv,csvRows,escapeHtml,money,estimateReceive,routeQuote,settlementTimeline,settlementFacts,settlementNetwork,pageForRecord} from '../public/app/data.js';

test('combined filters narrow by date, status and corridor inclusively',()=>{
  const rows=filterSettlements(initialSettlements,{start:'2024-06-22',end:'2024-06-24',status:'Settled',corridor:'INR-USDC',currency:'USDC'});
  assert.deepEqual(rows.map(r=>r.id),['STL-784521']);
  assert.equal(filterSettlements(initialSettlements,{start:'2024-06-24',end:'2024-06-24'}).length,2);
  assert.equal(filterSettlements(initialSettlements,{start:'2025-01-01'}).length,0);
});

test('search finds references and beneficiaries without modifying source records',()=>{
  assert.equal(filterSettlements(initialSettlements,{query:'  TFI-2024-0624  '})[0].name,'TechFlow Inc.');
  assert.equal(filterSettlements(initialSettlements,{query:'brighttrade'})[0].to,'USDT');
  assert.equal(filterSettlements(initialSettlements,{currency:'INR'}).length,8);
  assert.equal(initialSettlements.length,8);
});

test('CSV handles formulas, quotes and newlines in user supplied references',()=>{
  const data=csv([{...initialSettlements[0],name:'Example, "Company"',reference:'=HYPERLINK("bad")'}]);
  assert.ok(data.includes('"Example, ""Company"""'));
  assert.ok(data.includes('"\'=HYPERLINK(""bad"")"'));
  assert.equal(data.split('\r\n').length,2);
});

test('amounts and estimates retain currency formats and precision',()=>{
  assert.equal(money(2500000,'INR'),'₹ 25,00,000');
  assert.equal(money(29870,'USDC'),'$ 29,870');
  assert.equal(estimateReceive(2500000,'USDC'),29868.58);
  assert.equal(estimateReceive('','USDC'),0);
  assert.equal(escapeHtml('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;');
});

test('timelines follow each record and never move backwards',()=>{
  for(const s of initialSettlements){
    const events=settlementTimeline(s);
    const timestamps=events.filter(e=>e.at).map(e=>Date.parse(e.at));
    assert.equal(timestamps[0],Date.parse(`${s.date}T${s.time}:00Z`));
    for(let i=1;i<timestamps.length;i++)assert.ok(timestamps[i]>=timestamps[i-1],s.id);
    if(s.status==='Settled')assert.equal(events.at(-1).at,`${s.date}T${s.completed}:00.000Z`);
  }
  const crossing={...initialSettlements[0],time:'23:58',completed:'00:02'};
  assert.equal(settlementTimeline(crossing).at(-1).at,'2024-06-25T00:02:00.000Z');
});

test('blocked, ready and cancelled settlements have truthful liquidity and milestone states',()=>{
  const blocked=initialSettlements.find(s=>s.status==='Action required');
  assert.equal(settlementFacts(blocked).liquidity,'Not secured');
  assert.equal(settlementTimeline(blocked)[1].phase,'attention');
  assert.equal(settlementFacts(initialSettlements.find(s=>s.status==='Ready')).liquidity,'Not secured');
  const cancelled=initialSettlements.find(s=>s.status==='Cancelled');
  assert.equal(settlementTimeline(cancelled)[3].phase,'cancelled');
  assert.equal(settlementTimeline(cancelled)[4].phase,'pending');
  assert.equal(settlementFacts(cancelled).liquidity,'Released');
  assert.equal(settlementNetwork(blocked).kind,'fiat');
});

// PRODUCT.md § 12 — "Primary navigation, and nothing else", followed by the
// list of sections that do not become top-level product areas. A nav that
// drifts back is the failure this guards.
test('the primary navigation is the five sections PRODUCT.md fixes',()=>{
  assert.deepEqual(routes.map(r=>r[0]),['overview','settlements','beneficiaries','batches','developers']);
  for(const barred of ['treasury','liquidity','providers','compliance','reconciliation','documents','analytics','wallet','crypto','stablecoins'])
    assert.ok(!routes.some(r=>r[0]===barred),`${barred} is named in § 12's prohibition list`);
  // § 12: "Settings lives under account/workspace controls, not in the primary nav."
  assert.ok(!routes.some(r=>r[0]==='settings'));
  assert.ok(allRoutes.some(r=>r[0]==='settings'));
});

// Decision D-03, closed: five customer-facing states and no sixth. The reasoning
// is recorded because the pressure to add one was expected to return.
test('there are five customer-facing states and Failed is not one of them',()=>{
  assert.deepEqual(STATUSES,['Ready','Settling','Settled','Action required','Cancelled']);
  const used=new Set(initialSettlements.map(s=>s.status));
  for(const state of used) assert.ok(STATUSES.includes(state),state);
  assert.ok(!used.has('Failed')&&!used.has('Processing'));
  // A failure projects to CANCELLED carrying a resolution, rather than becoming
  // a state of its own.
  const cancelled=initialSettlements.find(s=>s.status==='Cancelled');
  assert.ok(cancelled.resolution&&cancelled.resolution.length>10);
});

// § 10 — the batch shows an aggregate; the settlements inside keep their own
// independent lifecycles, and the state that needs a person is read first.
test('a batch reports an aggregate and the states inside it, attention first',()=>{
  const batch=initialBatches.find(b=>b.breakdown['Action required']);
  assert.equal(batchStatus(batch)[0].status,'Action required');
  for(const b of initialBatches){
    assert.equal(Object.values(b.breakdown).reduce((t,v)=>t+v,0),b.count,b.id);
    for(const state of Object.keys(b.breakdown)) assert.ok(STATUSES.includes(state),state);
  }
});

test('quotes preserve inbound and outbound currency directions and monetary fractions',()=>{
  assert.equal(routeQuote(2500000,'INR','USDC').receive,29868.58);
  assert.equal(routeQuote(120000,'USD','INR').receive,9936000);
  assert.equal(routeQuote(75000,'USDC','INR').receive,6277500);
  assert.equal(routeQuote(1,'INR','INR'),null);
  assert.equal(routeQuote(-10,'USD','INR'),null);
  assert.equal(money(25000.75,'INR'),'₹ 25,000.75');
});

test('direct record navigation locates the correct page and audit CSV retains event data',()=>{
  const rows=[...initialSettlements,...initialSettlements.map(s=>({...s,id:s.id+'-new'}))];
  assert.equal(pageForRecord(rows,'STL-784515-new',8),2);
  assert.equal(pageForRecord(rows,'STL-784521',8),1);
  const exported=csvRows(['ID','Event'],[['STL-784521','Settlement executed'],['STL-784515','=unsafe']]);
  assert.ok(exported.includes('Settlement executed'));
  assert.ok(exported.includes("'=unsafe"));
});

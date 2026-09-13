import test from 'node:test';
import assert from 'node:assert/strict';
import {initialSettlements,initialBeneficiaries} from '../public/app/data.js';
import {preflightAssessment,attentionGroups} from '../public/app/experience.js';
import {receiptModel,recordMarkup} from '../public/app/receipt.js';

const wizard={from:'INR',currency:'USDC',amount:2500000};
const icon=()=>'<svg aria-hidden="true"></svg>';

test('preflight distinguishes a verified beneficiary from a blocked review without changing records',()=>{
  const verified=initialBeneficiaries[0],review=initialBeneficiaries[3];
  assert.equal(preflightAssessment(wizard,verified).ready,true);
  const result=preflightAssessment(wizard,review);
  assert.equal(result.ready,false);
  assert.equal(result.checks.find(c=>c.key==='compliance').state,'pending');
  assert.equal(review.status,'Needs review');
  assert.equal(preflightAssessment(wizard,null).ready,false);
});

test('preflight preserves supported directions and enforces the visible amount limits',()=>{
  const beneficiary=initialBeneficiaries[0];
  for(const values of [{amount:0},{amount:-1},{amount:NaN},{amount:100000001},{currency:'INR'}])assert.equal(preflightAssessment({...wizard,...values},beneficiary).ready,false);
  assert.equal(preflightAssessment({from:'USDC',currency:'INR',amount:10},beneficiary).ready,true);
  assert.equal(preflightAssessment({from:'USDC',currency:'INR',amount:9},beneficiary).ready,false);
});

test('attention counts are derived from records, excluding settling and settled payments',()=>{
  assert.deepEqual(attentionGroups(initialSettlements).map(g=>[g.key,g.count]),[['review',1],['cancelled',1],['approval',1]]);
  assert.deepEqual(attentionGroups(initialSettlements.filter(s=>['Settled','Settling'].includes(s.status))),[]);
  const changed=initialSettlements.map(s=>s.status==='Action required'?{...s,status:'Ready'}:s);
  assert.deepEqual(attentionGroups(changed).map(g=>[g.key,g.count]),[['cancelled',1],['approval',2]]);
});

test('only a settled record with a completion timestamp receives a receipt',()=>{
  for(const record of initialSettlements){
    const model=receiptModel(record);
    assert.equal(model.complete,record.status==='Settled');
    assert.equal(model.title,record.status==='Settled'?'Settlement receipt':'Settlement report');
    const markup=recordMarkup(model,icon);
    assert.equal(markup.includes('Amount delivered'),record.status==='Settled');
    assert.ok(markup.includes('not proof of payment'));
  }
  const noCompletion={...initialSettlements[0],completed:undefined};
  assert.equal(receiptModel(noCompletion).complete,false);
});

test('receipt snapshot retains amounts, currencies and the overnight completion date',()=>{
  const record={...initialSettlements[4],time:'23:55',completed:'00:12'};
  const model=receiptModel(record,'Example Workspace');
  assert.equal(model.completedAt,'2024-06-23T00:12:00.000Z');
  assert.equal(model.record.from,'USDC');assert.equal(model.record.to,'INR');
  record.send=1;
  assert.equal(model.record.send,75000);
  const html=recordMarkup(model,icon);
  assert.ok(html.includes('62,19,750.00'));
  assert.ok(html.includes('Indian bank rails'));
  assert.ok(html.includes('Example Workspace'));
});

test('exported document markup escapes references and never invents an unrecorded fee',()=>{
  const model=receiptModel({...initialSettlements[0],name:'<script>alert(1)</script>',reference:'<img src=x onerror=alert(1)>'},'A & B');
  const html=recordMarkup(model,icon);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('A &amp; B'));
  assert.ok(html.includes('Recorded fee</dt><dd>Not recorded'));
});

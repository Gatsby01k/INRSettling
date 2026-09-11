export const routes = [
  ['overview', 'Overview', 'home'], ['settlements', 'Settlements', 'wallet-cards'],
  ['liquidity', 'Liquidity', 'wallet'], ['counterparties', 'Counterparties', 'users'],
  ['reconciliation', 'Reconciliation', 'file-check'], ['developers', 'Developers', 'network'],
  ['settings', 'Settings', 'settings']
];
export const initialSettlements = [
  {id:'STL-784521',date:'2024-06-24',time:'10:24',from:'INR',to:'USDC',name:'TechFlow Inc.',country:'United States',send:2500000,receive:29870,status:'Settled',completed:'11:02',reference:'TFI-2024-0624'},
  {id:'STL-784520',date:'2024-06-24',time:'09:12',from:'INR',to:'USDT',name:'BrightTrade Ltd',country:'Singapore',send:1050000,receive:12580,status:'Processing',eta:'~ 12 mins',reference:'BT-2024-0624'},
  {id:'STL-784519',date:'2024-06-23',time:'18:41',from:'INR',to:'EURC',name:'EuroMart GmbH',country:'Germany',send:5000000,receive:54320,status:'Ready',eta:'~ 2 hours',reference:'EM-2024-0623'},
  {id:'STL-784518',date:'2024-06-23',time:'14:03',from:'INR',to:'AED',name:'Al Noor Trading',country:'United Arab Emirates',send:1500000,receive:63200,status:'Action required',eta:'KYC pending',reference:'AN-2024-0623'},
  {id:'STL-784517',date:'2024-06-22',time:'11:17',from:'USDC',to:'INR',name:'Global Exports',country:'India',send:75000,receive:6219750,status:'Settled',completed:'11:34',reference:'GE-2024-0622'},
  {id:'STL-784516',date:'2024-06-21',time:'16:20',from:'USD',to:'INR',name:'Vertex Brands',country:'India',send:120000,receive:9936000,status:'Settled',completed:'16:47',reference:'VB-2024-0621'},
  {id:'STL-784515',date:'2024-06-20',time:'13:09',from:'INR',to:'USDT',name:'Nova Digital',country:'Singapore',send:875000,receive:10482,status:'Failed',completed:'14:02',reference:'ND-2024-0620'},
  {id:'STL-784514',date:'2024-06-19',time:'10:56',from:'INR',to:'EURC',name:'Sage Imports',country:'France',send:12000000,receive:131540,status:'Settled',completed:'11:28',reference:'SI-2024-0619'}
];
export const initialCounterparties = initialSettlements.map((s,i)=>({id:'CP-'+String(1001+i),name:s.name,country:s.country,currency:s.to,status:s.status==='Action required'?'Needs review':'Verified',email:['finance@techflow.example','treasury@brighttrade.example','payments@euromart.example','finance@alnoor.example','treasury@globalexports.example','finance@vertex.example','finance@novadigital.example','finance@sage.example'][i]}));
export const balances=[{currency:'USDC',amount:5952000,share:48,network:'Ethereum · Polygon',change:'+8.4%',color:'#1fcbb8'},{currency:'USDT',amount:3968000,share:32,network:'Ethereum · Tron',change:'+6.2%',color:'#47d9cc'},{currency:'EURC',amount:1488000,share:12,network:'Ethereum · Base',change:'+3.1%',color:'#84e5de'},{currency:'INR',amount:992000,share:8,network:'Local collection account',change:'+4.8%',color:'#e7af53'}];
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const currencySymbol = currency => ({INR:'₹',USDC:'$',USDT:'$',USD:'$',EURC:'€',AED:'AED',SGD:'S$'}[currency]||currency);
export function money(value,currency='INR',decimals){const n=Number(value);const precision=decimals??(Number.isInteger(n)?0:2);return currencySymbol(currency)+' '+n.toLocaleString(currency==='INR'?'en-IN':'en-US',{minimumFractionDigits:precision,maximumFractionDigits:precision});}
export function displayDate(value){const [y,m,d]=value.split('-').map(Number);return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(y,m-1,d)));}
export function filterSettlements(rows,filters={}){const q=(filters.query||'').trim().toLowerCase();return rows.filter(s=>(!q||[s.id,s.name,s.reference,s.country,s.from,s.to].join(' ').toLowerCase().includes(q))&&(!filters.status||s.status===filters.status)&&(!filters.corridor||s.from+'-'+s.to===filters.corridor)&&(!filters.currency||s.from===filters.currency||s.to===filters.currency)&&(!filters.start||s.date>=filters.start)&&(!filters.end||s.date<=filters.end));}
export function csv(rows){const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};return ['ID,Date,Beneficiary,From,To,Send amount,Receive amount,Status,Reference',...rows.map(s=>[s.id,s.date,s.name,s.from,s.to,s.send,s.receive,s.status,s.reference].map(cell).join(','))].join('\r\n');}
export function csvRows(headers,rows){const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};return [headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n');}
export function estimateReceive(amount,currency){const rates={USDC:83.70,USDT:83.47,EURC:92.05,AED:23.73};return Math.round((Number(amount)||0)/(rates[currency]||83.70)*100)/100;}

export const corridorOptions = {INR:['USDC','USDT','EURC','AED'],USDC:['INR'],USD:['INR']};
const illustrativeInrRates={INR:1,USDC:83.70,USDT:83.47,EURC:92.05,AED:23.73,USD:82.80};
export function routeQuote(amount,from,to){
  if(!corridorOptions[from]?.includes(to)||!Number.isFinite(Number(amount))||Number(amount)<0)return null;
  const rate=illustrativeInrRates[from]/illustrativeInrRates[to];
  return {receive:Math.round(Number(amount)*rate*100)/100,rate};
}
export function settlementNetwork(s){
  if(s.to==='INR')return {name:'Indian bank rails',execution:'Bank transfer confirmed',kind:'fiat'};
  if(s.to==='AED')return {name:'UAE bank rails',execution:'Bank transfer confirmed',kind:'fiat'};
  return {name:s.to==='USDT'?'Tron':'Ethereum',execution:'On-chain transaction confirmed',kind:'chain'};
}
export function settlementTimeline(s){
  const start=new Date(`${s.date}T${s.time}:00Z`).getTime();
  let end=s.completed?new Date(`${s.date}T${s.completed}:00Z`).getTime():null;
  if(end!==null&&end<start)end+=86400000;
  const duration=end===null?null:end-start;
  const timestamps=[start,start+60000,start+120000,end===null?null:end-60000,end];
  if(duration!==null&&duration<180000){for(let i=1;i<4;i++)timestamps[i]=start+Math.floor(duration*i/4);}
  const finished={Settled:5,Processing:3,Ready:2,'Action required':1,Failed:3,Draft:1}[s.status]??1;
  const titles=['Initiated','Compliance cleared','Liquidity reserved','Settlement executed','Completed'];
  const descriptions=['Settlement created','KYC / AML checks passed','Funds reserved',settlementNetwork(s).execution,'Funds delivered to beneficiary'];
  return titles.map((title,i)=>{
    let phase=i<finished?'complete':'pending';
    if(i===finished&&s.status==='Processing')phase='active';
    if(i===1&&s.status==='Action required')phase='attention';
    if(i===3&&s.status==='Failed')phase='failed';
    let at=phase==='complete'?timestamps[i]:phase==='failed'?end:null;
    if(s.status==='Failed'&&i===3)title='Execution failed';
    const note=phase==='complete'?descriptions[i]:phase==='active'?'Awaiting finality':phase==='attention'?'Beneficiary review required':phase==='failed'?'Payout route unavailable':s.status==='Ready'&&i===2?'Awaiting approval':'Not started';
    return {title,phase,note,at:at===null?null:new Date(at).toISOString()};
  });
}
export function settlementFacts(s){
  const cleared=['Settled','Processing','Ready','Failed'].includes(s.status);
  return {compliance:cleared?'Cleared':s.status==='Action required'?'Review required':'Not checked',liquidity:s.status==='Settled'?'Released':s.status==='Processing'?'Reserved':s.status==='Failed'?'Released':'Not reserved',network:settlementNetwork(s)};
}
export function pageForRecord(rows,id,pageSize=8){const i=rows.findIndex(r=>r.id===id);return i<0?1:Math.floor(i/pageSize)+1;}

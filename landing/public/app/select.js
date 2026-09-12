import {escapeHtml as esc} from './data.js';
import {currencies,currencyIcon} from './currency.js';

// The original select remains the form value and validation source.
// The visible combobox and its listbox are shared by filters and forms.
const widgets=new WeakMap();
let sequence=0,active=null,listenersInstalled=false,typeAhead='',typeTimer;
const chevron='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>';
const check='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg>';

function labelFor(select){
  if(select.getAttribute('aria-label'))return select.getAttribute('aria-label');
  const label=select.labels?.[0]||select.closest('label');
  return label?[...label.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').trim():'Choose an option';
}

function optionContent(select,option,expanded=false){
  const value=option.value,text=option.textContent.trim();
  if(currencies[value])return `${currencyIcon(value)}<span class="choice-copy"><span>${esc(value)}</span>${expanded?`<small>${currencies[value].name}</small>`:''}</span>`;
  if(select.name==='beneficiary'){
    const [name,...rest]=text.split(' · ');
    const initials=name.trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('');
    return `<span class="choice-avatar" aria-hidden="true">${esc(initials)}</span><span class="choice-copy"><span>${esc(name)}</span><small>${esc(rest.join(' · '))}</small></span>`;
  }
  if(select.id==='status-filter'&&value)return `<span class="choice-status choice-status--${esc(value.toLowerCase().replaceAll(' ','-'))}" aria-hidden="true"></span><span class="choice-copy"><span>${esc(text)}</span></span>`;
  return `<span class="choice-copy"><span>${esc(text)}</span></span>`;
}

function sync(widget){
  const {select,trigger}=widget;
  const option=select.selectedOptions[0];
  trigger.innerHTML=`<span class="choice-value">${option?optionContent(select,option):'<span>Choose an option</span>'}</span><span class="choice-chevron">${chevron}</span>`;
  trigger.disabled=select.disabled;
  trigger.setAttribute('aria-label',`${widget.label}: ${option?.textContent.trim()||'Choose an option'}`);
  trigger.setAttribute('aria-required',String(select.required));
  trigger.classList.toggle('has-value',Boolean(select.value));
  if(select.validity.valid)trigger.removeAttribute('aria-invalid');
}

export function refreshSelect(select){
  const widget=widgets.get(select);
  if(widget)sync(widget);
}

export function closeSelects(restoreFocus=false){
  if(!active)return;
  const widget=active;active=null;
  widget.trigger.setAttribute('aria-expanded','false');
  widget.trigger.removeAttribute('aria-activedescendant');
  if(typeof widget.popup.hidePopover==='function'&&widget.popup.matches(':popover-open'))widget.popup.hidePopover();
  widget.popup.remove();
  if(restoreFocus&&widget.trigger.isConnected)widget.trigger.focus({preventScroll:true});
  clearTimeout(typeTimer);typeAhead='';
}

function markActive(widget,index){
  widget.index=index;
  const options=[...widget.popup.querySelectorAll('[role=option]')];
  options.forEach((el,i)=>el.classList.toggle('is-active',i===index));
  const option=options[index];
  if(!option)return;
  widget.trigger.setAttribute('aria-activedescendant',option.id);
  const top=option.offsetTop,bottom=top+option.offsetHeight;
  if(top<widget.popup.scrollTop)widget.popup.scrollTop=top;
  else if(bottom>widget.popup.scrollTop+widget.popup.clientHeight)widget.popup.scrollTop=bottom-widget.popup.clientHeight;
}

function commit(widget,index){
  const option=widget.options[index];
  if(!option||option.disabled)return;
  widget.select.selectedIndex=option.index;
  closeSelects(true);
  widget.select.dispatchEvent(new Event('change',{bubbles:true}));
  if(widget.select.isConnected)sync(widget);
}

function open(widget,edge){
  if(widget.select.disabled)return;
  closeSelects();active=widget;
  const {select,trigger,popup}=widget;
  widget.options=[...select.options];
  popup.innerHTML=widget.options.map((option,i)=>`<div id="${widget.id}-option-${i}" role="option" aria-selected="${option.selected}" aria-disabled="${option.disabled}" data-choice-index="${i}" class="choice-option ${option.selected?'is-selected':''}">${optionContent(select,option,true)}<span class="choice-check">${check}</span></div>`).join('');
  (select.closest('dialog')||document.body).append(popup);
  popup.style.maxHeight='320px';
  const rect=trigger.getBoundingClientRect(),viewport=window.visualViewport;
  const vw=viewport?.width||window.innerWidth,vh=viewport?.height||window.innerHeight;
  const below=vh-rect.bottom-12,above=rect.top-12,placeAbove=below<190&&above>below;
  const available=Math.max(100,placeAbove?above:below);
  popup.style.width=`${Math.min(Math.max(rect.width,220),vw-24)}px`;
  popup.style.maxHeight=`${Math.min(320,available)}px`;
  popup.style.left=`${Math.max(12,Math.min(rect.left,vw-Math.min(Math.max(rect.width,220),vw-24)-12))}px`;
  popup.style.top=`${rect.bottom+7}px`;
  if(typeof popup.showPopover==='function')popup.showPopover();
  if(placeAbove)popup.style.top=`${Math.max(12,rect.top-popup.offsetHeight-7)}px`;
  trigger.setAttribute('aria-expanded','true');
  const availableIndices=widget.options.map((o,i)=>!o.disabled?i:-1).filter(i=>i>=0);
  const selected=select.selectedIndex;
  markActive(widget,edge==='first'?availableIndices[0]:edge==='last'?availableIndices.at(-1):selected>=0&&!widget.options[selected].disabled?selected:availableIndices[0]);
}

function handleKey(event){
  const trigger=event.target.closest('.choice-trigger');
  const widget=active||trigger?.choiceWidget;
  if(!widget||event.ctrlKey||event.metaKey)return;
  const key=event.key;
  if(key==='Tab'){closeSelects();return;}
  if(key==='Escape'&&active){event.preventDefault();event.stopImmediatePropagation();closeSelects(true);return;}
  if(['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(key)){
    event.preventDefault();event.stopImmediatePropagation();
    if(!active){open(widget,key==='Home'?'first':key==='End'?'last':undefined);return;}
    if(key==='Enter'||key===' '){commit(widget,widget.index);return;}
    const options=widget.options.map((o,i)=>!o.disabled?i:-1).filter(i=>i>=0);
    const position=options.indexOf(widget.index);
    const next=key==='Home'?0:key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,position+(key==='ArrowDown'?1:-1)));
    markActive(widget,options[next]);return;
  }
  if(key.length===1&&!event.altKey){
    if(!active)open(widget);
    event.preventDefault();event.stopImmediatePropagation();
    clearTimeout(typeTimer);typeAhead+=key.toLowerCase();
    typeTimer=setTimeout(()=>{typeAhead='';},650);
    const index=widget.options.findIndex(o=>!o.disabled&&o.textContent.trim().toLowerCase().startsWith(typeAhead));
    if(index>=0)markActive(widget,index);
  }
}

function installListeners(){
  if(listenersInstalled)return;listenersInstalled=true;
  document.addEventListener('keydown',handleKey,true);
  document.addEventListener('pointerdown',event=>{if(active&&!active.popup.contains(event.target)&&!active.trigger.contains(event.target))closeSelects();},true);
  document.addEventListener('focusin',event=>{if(active&&!active.trigger.contains(event.target)&&!active.popup.contains(event.target))closeSelects();});
  document.addEventListener('scroll',event=>{if(active&&event.target!==active.popup&&!active.popup.contains(event.target))closeSelects();},true);
  window.addEventListener('resize',()=>closeSelects());
}

export function enhanceSelects(root=document){
  installListeners();
  root.querySelectorAll('select:not([multiple])').forEach(select=>{
    if(widgets.has(select)){refreshSelect(select);return;}
    const id=`choice-${++sequence}`,label=labelFor(select),fieldLabel=select.closest('label');
    const wrapper=document.createElement('span');wrapper.className='choice';
    if(select.closest('.filter-toolbar'))wrapper.classList.add('choice--filter');
    if(select.name==='beneficiary')wrapper.classList.add('choice--beneficiary');
    if(select.id)wrapper.dataset.filter=select.id;
    const trigger=document.createElement('button');trigger.type='button';trigger.className='choice-trigger';
    trigger.id=id;trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');
    trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',id+'-list');
    const popup=document.createElement('div');popup.className='choice-list';popup.id=id+'-list';
    popup.setAttribute('role','listbox');popup.setAttribute('aria-label',label);
    if(typeof popup.showPopover==='function')popup.setAttribute('popover','manual');
    const widget={id,label,select,trigger,popup,options:[],index:0};
    widgets.set(select,widget);trigger.choiceWidget=widget;
    select.before(wrapper);wrapper.append(select,trigger);
    // A label must contain only one labelable control. Keep the source select
    // in the same form, outside the visible field's label.
    if(fieldLabel){fieldLabel.after(select);fieldLabel.htmlFor=id;}
    select.classList.add('choice-native');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
    trigger.addEventListener('click',()=>active===widget?closeSelects():open(widget));
    popup.addEventListener('pointerdown',event=>event.preventDefault());
    popup.addEventListener('click',event=>{const option=event.target.closest('[data-choice-index]');if(option)commit(widget,Number(option.dataset.choiceIndex));});
    popup.addEventListener('pointermove',event=>{const option=event.target.closest('[data-choice-index]');if(option&&option.getAttribute('aria-disabled')!=='true')markActive(widget,Number(option.dataset.choiceIndex));});
    select.addEventListener('change',()=>sync(widget));
    select.addEventListener('invalid',event=>{event.preventDefault();trigger.setAttribute('aria-invalid','true');trigger.focus();});
    sync(widget);
  });
}

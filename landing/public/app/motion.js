const reduce=()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const easing='cubic-bezier(.2,.8,.2,1)';
const copies=new WeakMap();

export function revealDetail(root,enter=false) {
  if(!root||reduce())return;
  const body=root.querySelector('.sd-body');
  body?.animate?.([{opacity:.25,transform:`translate${enter?'X':'Y'}(${enter?12:5}px)`},{opacity:1,transform:'translate(0,0)'}],{duration:200,easing});
}

export function pulseRoute(root) {
  if(!root||reduce())return;
  root.classList.remove('route-pulse');
  void root.offsetWidth;
  root.classList.add('route-pulse');
}

export function highlightRecord(id) {
  const row=document.querySelector(`[data-row="${CSS.escape(id)}"]`);
  if(!row||reduce())return;
  row.classList.remove('record-updated');
  void row.offsetWidth;
  row.classList.add('record-updated');
}

export function copyFeedback(button,check) {
  if(!button?.isConnected)return;
  const previous=copies.get(button);
  if(previous)clearTimeout(previous.timer);
  const original=previous?.original??button.innerHTML,label=previous?.label??button.getAttribute('aria-label');
  const svg=button.querySelector('svg');
  if(svg)svg.outerHTML=check;
  button.classList.add('copy-confirmed');
  button.setAttribute('aria-label','Copied');
  const timer=setTimeout(()=>{
    if(button.isConnected){button.innerHTML=original;button.classList.remove('copy-confirmed');if(label)button.setAttribute('aria-label',label);else button.removeAttribute('aria-label');}
    copies.delete(button);
  },1500);
  copies.set(button,{original,label,timer});
}

export function openChoiceMotion(popup,above) {
  if(reduce())return;
  popup.style.transformOrigin=above?'50% 100%':'50% 0%';
  popup.animate?.([{opacity:0,transform:`translateY(${above?4:-4}px) scaleY(.97)`},{opacity:1,transform:'translateY(0) scaleY(1)'}],{duration:150,easing});
}

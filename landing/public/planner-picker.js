// A compact, keyboard-operable selection grid; no platform select chrome.
export function mountPicker(root, options) {
  const trigger = root.querySelector('.picker-trigger');
  const panel = root.querySelector('.picker-panel');
  const input = root.querySelector('input');
  const label = root.querySelector('.picker-label');
  const value = root.querySelector('.picker-value');
  panel.innerHTML = options.map(option => `<button type="button" data-picker-option data-value="${option.value}" aria-pressed="false" tabindex="-1">${option.art}<span><strong>${option.label}</strong>${option.note ? `<small>${option.note}</small>` : ''}</span><svg class="picker-check icon" aria-hidden="true"><use href="#i-check"/></svg></button>`).join('');
  const buttons = [...panel.querySelectorAll('[data-picker-option]')];
  function render() {
    const option = options.find(item => item.value === input.value);
    value.innerHTML = `${option.art}<span><strong>${option.label}</strong>${option.note ? `<small>${option.note}</small>` : ''}</span>`;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === input.value)));
  }
  function close(returnFocus = false) {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    root.classList.remove('picker-open', 'picker-up');
    if (returnFocus) trigger.focus({ preventScroll: true });
  }
  function open() {
    document.dispatchEvent(new CustomEvent('inrsettle:picker-open', { detail: root }));
    panel.hidden = false;
    root.classList.add('picker-open');
    trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect();
    root.classList.toggle('picker-up', window.innerHeight - rect.bottom < panel.offsetHeight + 14 && rect.top > panel.offsetHeight + 14);
    buttons.find(button => button.dataset.value === input.value).focus({ preventScroll: true });
  }
  trigger.addEventListener('click', () => panel.hidden ? open() : close());
  trigger.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
  });
  panel.addEventListener('pointerdown', event => {
    if (event.target.closest('[data-picker-option]')) event.preventDefault();
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-picker-option]');
    if (!button) return;
    input.value = button.dataset.value;
    render(); close(true);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  panel.addEventListener('keydown', event => {
    const index = buttons.indexOf(document.activeElement);
    const columns = Number(root.dataset.columns || 2);
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault();
      buttons[(index + moves[event.key] + buttons.length) % buttons.length].focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1].focus();
    } else if (event.key === 'Escape') { event.preventDefault(); close(true); }
  });
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) close(); });
  root.addEventListener('focusout', () => {
    queueMicrotask(() => { if (!root.contains(document.activeElement)) close(); });
  });
  document.addEventListener('inrsettle:picker-open', event => { if (event.detail !== root) close(); });
  panel.setAttribute('aria-labelledby', label.id);
  render();
}

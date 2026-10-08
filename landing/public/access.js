/* Progressive enhancement only: the server owns access and form validation. */
document.querySelectorAll('[data-access-form]').forEach(form => {
  const submit = form.querySelector('button[type="submit"]');
  const submitLabel = submit?.querySelector('.access-submit-label');
  const spinner = submit?.querySelector('.access-spinner');
  const pending = form.querySelector('[data-access-pending]');
  const originalLabel = submitLabel?.textContent;
  const unavailable = form.getAttribute('aria-disabled') === 'true';
  // Fragments are not sent to the server. Pass only a known route name; the
  // server independently validates it before building its fixed app redirect.
  const route = location.hash.replace(/^#\/?/, '').split('?')[0];
  if (['overview', 'settlements', 'liquidity', 'beneficiaries', 'batches', 'reconciliation', 'developers', 'settings'].includes(route)) {
    const view = form.querySelector('input[name="view"]') || document.createElement('input');
    view.type = 'hidden'; view.name = 'view'; view.value = route;
    if (!view.parentElement) form.append(view);
  }

  function resetPending() {
    form.dataset.busy = 'false';
    form.removeAttribute('aria-busy');
    if (submit) {
      submit.disabled = unavailable;
      submit.classList.remove('is-pending');
    }
    if (submitLabel) submitLabel.textContent = originalLabel;
    if (spinner) spinner.hidden = true;
    if (pending) { pending.hidden = true; pending.textContent = ''; }
  }

  form.addEventListener('submit', event => {
    if (unavailable || form.dataset.busy === 'true') {
      event.preventDefault();
      return;
    }
    form.dataset.busy = 'true';
    form.setAttribute('aria-busy', 'true');
    if (submit) { submit.disabled = true; submit.classList.add('is-pending'); }
    if (submitLabel) submitLabel.textContent = form.dataset.pendingLabel || 'Opening workspace…';
    if (spinner) spinner.hidden = false;
    if (pending) { pending.hidden = false; pending.textContent = 'Please wait while your access is checked.'; }
  });

  window.addEventListener('pageshow', resetPending);
  resetPending();
});

document.querySelectorAll('[data-access-reveal]').forEach(toggle => {
  const input = document.getElementById(toggle.getAttribute('aria-controls'));
  const label = toggle.querySelector('span');
  if (!input) return;
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide access code' : 'Show access code');
    if (label) label.textContent = show ? 'Hide' : 'Show';
  });
});

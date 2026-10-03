'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hoverPointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  // Illustrative data belongs only to the product preview. No financial API is called.
  const settlements = [
    { id: 'STL-10482', name: 'Meridian Commerce', amount: '₹ 12,50,000', value: 1250000, corridor: 'USDT → INR', status: 'Settled', date: '12 Aug 2026' },
    { id: 'STL-10481', name: 'Atlas Global', amount: '₹ 8,40,000', value: 840000, corridor: 'USDC → INR', status: 'Settled', date: '12 Aug 2026' },
    { id: 'STL-10480', name: 'Northstar Trading', amount: '₹ 24,00,000', value: 2400000, corridor: 'USDT → INR', status: 'In progress', date: '12 Aug 2026' },
    { id: 'STL-10479', name: 'Meridian Commerce', amount: '₹ 6,75,000', value: 675000, corridor: 'USDC → INR', status: 'Settled', date: '11 Aug 2026' },
    { id: 'STL-10478', name: 'Horizon Payments', amount: '₹ 18,20,000', value: 1820000, corridor: 'USDT → INR', status: 'Settled', date: '11 Aug 2026' }
  ];
  const corridors = [
    { flag: 'in', symbol: '●', name: 'INR → USDT', detail: 'India · Tether', volume: '$ 92.4M', time: '46s' },
    { flag: 'usdc', symbol: '$', name: 'INR → USDC', detail: 'India · USD Coin', volume: '$ 68.2M', time: '42s' },
    { flag: 'eur', symbol: '€', name: 'INR → EURC', detail: 'India · Euro Coin', volume: '$ 31.5M', time: '51s' },
    { flag: 'ae', symbol: '', name: 'INR → AED', detail: 'India · United Arab Emirates', volume: '$ 35.8M', time: '49s' },
    { flag: 'sg', symbol: '●', name: 'INR → SGD', detail: 'India · Singapore', volume: '$ 20.5M', time: '52s' }
  ];
  const monthly = [22.4, 28.1, 32.6, 42.2, 35.8, 47.3, 40.0];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'];
  let activeView = 'overview';
  let activeChart = 'inr';
  let selectedMonth = 3;
  let tourStep = 0;
  let tourAmount = 1250000;
  let tourCurrency = 'USDT';
  let toastTimer;

  function toast(message) {
    clearTimeout(toastTimer);
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3300);
  }
  function download(content, name, mime = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copyText(text, success = 'Copied to clipboard.') {
    try {
      await navigator.clipboard.writeText(text);
      toast(success);
    } catch {
      toast('Clipboard unavailable. You can select the text or download your brief.');
    }
  }
  function openDialog(dialog) {
    if (!$('.modal-logo', dialog)) {
      const brand = document.createElement('img');
      brand.className = 'modal-logo';
      brand.src = '/assets/brand-wordmark.svg';
      brand.width = 934;
      brand.height = 95;
      brand.alt = 'INRSettle';
      dialog.insertBefore(brand, $('.modal-close', dialog).nextSibling);
    }
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('modal-open');
  }
  function closeDialog(dialog) {
    dialog.close();
    document.body.classList.remove('modal-open');
  }
  $$('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => document.body.classList.remove('modal-open'));
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
    });
  });

  const roleDescriptions = {
    psps: 'Bring funding, settlement instructions and reconciliation into one connected cross-border payment workflow.',
    merchants: 'Connect collections to settlement across currencies and markets, with a clear view of amounts, requirements and results.',
    otc: 'Coordinate fiat and stablecoin liquidity, counterparties and settlement evidence across your trading operations.',
    operators: 'Manage every settlement from preflight to reconciliation, with a clear view of what needs attention.',
    banks: 'Connect institutional workflows with digital liquidity and consistent settlement controls.'
  };
  function setRole(button, focus = false) {
    $$('.role-tab').forEach(tab => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $('#role-panel').setAttribute('aria-labelledby', button.id);
    $('#role-description').textContent = roleDescriptions[button.dataset.role];
    document.dispatchEvent(new CustomEvent('inrsettle:role-change', { detail: { role: button.dataset.role } }));
    if (focus) button.focus();
  }
  $('.role-tabs').addEventListener('keydown', event => {
    const tabs = $$('.role-tab');
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      setRole(tabs[next], true);
    }
  });

  const flowDetails = {
    inr: 'A single starting point for local INR liquidity.',
    engine: 'Preflight, routing and reconciliation in one coordinated workflow.',
    stable: 'Connect approved stablecoin funding to your settlement workflow.',
    global: 'Track the destination, delivery and evidence behind every settlement.'
  };
  function setFlow(button) {
    $$('.flow-node').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    $('#flow-detail-text').textContent = flowDetails[button.dataset.flow];
  }

  const details = {
    overview: {
      icon: 'globe', eyebrow: 'One connected settlement layer', title: 'One settlement layer.<br><span class="teal-text">Connected operations.</span>',
      description: 'Bring funding, settlement controls and operational visibility into a single workflow for your business.',
      items: ['Bring the amount, destination and business purpose into one instruction.', 'Review requirements and agreed terms before committing to execution.', 'Connect funding, routing and delivery to a clear reconciliation record.']
    },
    treasury: {
      icon: 'bank', eyebrow: 'Treasury movement', title: 'Put liquidity <span class="teal-text">in motion.</span>',
      description: 'A coordinated view of the funds available across your settlement operations.',
      items: ['View liquidity by currency and settlement corridor.', 'Plan funding around upcoming settlement obligations.', 'Keep a consistent record of the movement between funding and delivery.']
    },
    timing: {
      icon: 'clock', eyebrow: 'Liquidity timing', title: 'Ready when <span class="teal-text">you are.</span>',
      description: 'Understand funding requirements before a settlement is initiated, so your operations can plan ahead.',
      items: ['Check available liquidity before committing to a settlement.', 'Surface funding gaps and pending requirements early.', 'Follow the timing of each stage in the settlement lifecycle.']
    },
    routing: {
      icon: 'route', eyebrow: 'Settlement routing', title: 'A clearer route <span class="teal-text">to settlement.</span>',
      description: 'Connect your settlement requirements to a suitable route, with the destination, execution constraints and evidence kept in one workflow.',
      items: ['Keep beneficiary, purpose and destination requirements together.', 'Review route availability and settlement constraints.', 'Trace provider updates back to the original settlement.']
    },
    reconciliation: {
      icon: 'file', eyebrow: 'Reconciliation', title: 'Every settlement.<br><span class="teal-text">Accounted for.</span>',
      description: 'Bring provider references, settlement evidence and status changes into one place.',
      items: ['Keep a clear link between settlement intent and delivery evidence.', 'Identify mismatches that require an operator’s attention.', 'Export a consistent record for operational review.']
    },
    visibility: {
      icon: 'chart', eyebrow: 'Corridor visibility', title: 'See the whole <span class="teal-text">picture.</span>',
      description: 'One operating view across your settlement corridors, balances and counterparties.',
      items: ['Review settlement volume and delivery timing by corridor.', 'Find outstanding settlements and operational exceptions.', 'Keep teams working from the same settlement information.']
    }
  };
  function showFeature(name) {
    const detail = details[name] || details.overview;
    $('#detail-content').innerHTML = `<span class="round-icon detail-icon">${icon(detail.icon)}</span><p class="eyebrow">${detail.eyebrow}</p><h2 id="detail-title">${detail.title}</h2><p class="detail-description">${detail.description}</p><ul class="detail-list">${detail.items.map(item => `<li>${icon('check')}<span>${item}</span></li>`).join('')}</ul><button class="button primary" data-detail-tour>Explore the Product ${icon('arrow')}</button>`;
    $('#detail-dialog').setAttribute('aria-labelledby', 'detail-title');
    openDialog($('#detail-dialog'));
  }

  const codeExample = `POST /v1/settlements\nAuthorization: Bearer YOUR_API_KEY\nIdempotency-Key: unique-request-id\nContent-Type: application/json\n\n{\n  "beneficiary_id": "ben_7Ld2ZxKp0Wq4",\n  "recipient_amount": {\n    "currency": "INR",\n    "minor_units": "125000000"\n  },\n  "funding_currency": "USDT",\n  "purpose_code": "SOFTWARE_SERVICES",\n  "quote_id": "qt_9Xm4Bv7NsLt2",\n  "external_reference": "INVOICE-2026-0142"\n}`;
  function showDevelopers() {
    $('#detail-content').innerHTML = `<span class="round-icon detail-icon">${icon('code')}</span><p class="eyebrow">Built for your stack</p><h2 id="detail-title">One integration.<br><span class="teal-text">Connected operations.</span></h2><p class="detail-description">Express your settlement intent, check readiness and follow status changes through a consistent API workflow.</p><pre class="code-block"><code>${escapeHtml(codeExample)}</code></pre><p class="code-caption">Example INR settlement request. Credentials, valid quotes and endpoint availability are confirmed during technical onboarding.</p><div class="actions"><button class="button primary" data-copy-api>${icon('copy')}Copy Example</button><a class="button secondary" href="https://github.com/Gatsby01k/INRSettling/blob/main/reference/api/README.md" target="_blank" rel="noopener">API Reference</a><button class="text-button" data-detail-contact>Discuss Integration</button></div>`;
    $('#detail-dialog').setAttribute('aria-labelledby', 'detail-title');
    openDialog($('#detail-dialog'));
  }
  function showCorridors() {
    $('#detail-content').innerHTML = `<p class="eyebrow">India and the global economy</p><h2 id="detail-title">A more connected<br><span class="teal-text">world.</span></h2><p class="detail-description">Explore sample corridor workflows across fiat and digital currencies. Discuss supported routes, funding, limits and delivery requirements for your business with our team.</p><div class="corridor-modal-list">${corridors.map(c => `<div class="corridor-option"><span class="round-icon"><span class="currency-flag flag-${c.flag}">${c.symbol}</span></span><div><strong>${c.name}</strong><p>${c.detail}</p></div><span>Preview route</span></div>`).join('')}</div><button class="button primary" data-detail-contact>Discuss Your Corridor ${icon('arrow')}</button>`;
    $('#detail-dialog').setAttribute('aria-labelledby', 'detail-title');
    openDialog($('#detail-dialog'));
  }

  function appTitle(title) {
    return `<div class="app-title-row"><h3>${title}</h3><span class="preview-badge">Preview data</span></div>`;
  }
  function kpi(label, number, note = '') {
    return `<div class="app-kpi"><span>${label}</span><div><strong>${number}</strong>${note ? `<small>${note}</small>` : ''}</div></div>`;
  }
  function renderOverview() {
    const multiplier = activeChart === 'inr' ? 1 : .67;
    return `${appTitle('Global Settlement Overview')}<div class="dashboard-kpis">${kpi('Sample INR volume', '₹ 69.85L')}${kpi('Sample settlements', '5')}${kpi('Final records', '4')}${kpi('Sample corridors', '5')}</div><div class="app-overview-bottom"><div class="chart-panel"><div class="panel-heading"><h4>Settlement Volume</h4><div class="chart-switch" role="group" aria-label="Chart funding currency"><button class="${activeChart === 'inr' ? 'active' : ''}" data-chart="inr" aria-pressed="${activeChart === 'inr'}">INR</button><button class="${activeChart === 'stablecoins' ? 'active' : ''}" data-chart="stablecoins" aria-pressed="${activeChart === 'stablecoins'}">Stablecoins</button></div></div><div class="chart" aria-label="Illustrative monthly settlement volume in millions of US dollars"><div class="chart-scale" aria-hidden="true"><span>50</span><span>25</span><span>0</span></div>${monthly.map((value, i) => `<div class="bar-wrap" style="--bar-height:${(value * multiplier / 55 * 100).toFixed(1)}%"><button class="chart-bar ${i === selectedMonth ? 'selected' : ''}" data-month="${i}" style="--delay:${i * .04}s" aria-label="${months[i]}: $${(value * multiplier).toFixed(1)} million" aria-pressed="${i === selectedMonth}"></button><span class="bar-label">${months[i]}</span>${i === selectedMonth ? `<span class="bar-tooltip">$${(value * multiplier).toFixed(1)}M</span>` : ''}</div>`).join('')}</div></div><div class="corridor-panel"><div class="panel-heading"><h4>Corridors</h4></div>${corridors.map(c => `<div class="corridor-row"><span class="currency-flag flag-${c.flag}">${c.symbol}</span><span>${c.name}</span><span class="status">Example</span></div>`).join('')}</div></div>`;
  }
  function renderSettlements() {
    const query = $('#app-search').value.trim().toLowerCase();
    const rows = settlements.filter(row => `${row.id} ${row.name} ${row.amount} ${row.corridor} ${row.status}`.toLowerCase().includes(query));
    return `${appTitle('Settlements')}<div class="dashboard-kpis">${kpi('Completed', '4')}${kpi('In progress', '1')}${kpi('INR delivered', '₹ 45.85L')}${kpi('Currencies', '2')}</div><div class="app-table-wrap"><table class="app-table"><thead><tr><th>Settlement</th><th>Recipient</th><th>INR amount</th><th>Status</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.id}</td><td>${row.name}</td><td class="amount">${row.amount}</td><td><span class="status-pill ${row.status === 'In progress' ? 'pending' : ''}">${row.status}</span></td></tr>`).join('')}</tbody></table>${!rows.length ? '<p class="app-empty">No matching sample settlements.</p>' : ''}</div>`;
  }
  function renderLiquidity() {
    return `${appTitle('Liquidity Overview')}<div class="liquidity-grid"><div class="balance-card"><span class="round-icon orange-text">₹</span><span>INR · Available</span><strong>₹ 4.82 Cr</strong><div class="balance-line" style="--balance:78%"><i></i></div><small>78% available · 22% allocated</small></div><div class="balance-card"><span class="round-icon">₮</span><span>USDT · Available</span><strong>$ 842.5K</strong><div class="balance-line" style="--balance:86%"><i></i></div><small>86% available · 14% allocated</small></div><div class="balance-card"><span class="round-icon">$</span><span>USDC · Available</span><strong>$ 624.8K</strong><div class="balance-line" style="--balance:69%"><i></i></div><small>69% available · 31% allocated</small></div></div><p class="app-footnote">A consolidated view of sample currency balances and allocations.</p>`;
  }
  function renderCounterparties() {
    const names = [...new Set(settlements.map(row => row.name))];
    return `${appTitle('Counterparties')}<div class="app-table-wrap"><table class="app-table"><thead><tr><th>Business</th><th>Market</th><th>Currency</th><th>Verification</th></tr></thead><tbody>${names.map(name => `<tr><td>${name}</td><td>India</td><td>INR</td><td><span class="status-pill">Verified</span></td></tr>`).join('')}</tbody></table></div><p class="app-footnote">Illustrative counterparties for the product preview.</p>`;
  }
  function renderCorridorView() {
    return `${appTitle('Global Corridors')}<div class="app-table-wrap"><table class="app-table"><thead><tr><th>Corridor</th><th>Volume</th><th>Avg. time</th><th>Status</th></tr></thead><tbody>${corridors.map(c => `<tr><td><span class="currency-flag flag-${c.flag}" style="display:inline-flex;vertical-align:middle;margin-right:6px">${c.symbol}</span>${c.name}</td><td class="amount">${c.volume}</td><td>${c.time}</td><td><span class="status-pill">Example</span></td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderReports() {
    return `${appTitle('Reports & Reconciliation')}<div class="report-row">${icon('file')}<div><strong>Settlement register</strong><span>5 sample records · CSV</span></div><button data-report="settlements">Export ${icon('download')}</button></div><div class="report-row">${icon('chart')}<div><strong>Monthly settlement volume</strong><span>January – July · CSV</span></div><button data-report="volume">Export ${icon('download')}</button></div><div class="report-row">${icon('globe')}<div><strong>Corridor overview</strong><span>5 sample corridors · CSV</span></div><button data-report="corridors">Export ${icon('download')}</button></div><p class="app-footnote">Exports contain the illustrative data shown in this preview.</p>`;
  }
  const viewRenderers = { overview: renderOverview, settlements: renderSettlements, liquidity: renderLiquidity, counterparties: renderCounterparties, corridors: renderCorridorView, reports: renderReports };
  function renderApp() {
    $('#app-view').innerHTML = (viewRenderers[activeView] || renderOverview)();
    $$('.app-nav[data-view]').forEach(button => {
      const active = button.dataset.view === activeView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  $$('.app-nav').forEach(button => button.setAttribute('aria-label', button.textContent.trim()));
  let searchTimer;
  $('#app-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      activeView = 'settlements';
      renderApp();
    }, 120);
  });

  const csvCell = value => `"${String(value).replace(/"/g, '""')}"`;
  function exportReport(type) {
    let rows;
    if (type === 'settlements') rows = [['ID', 'Recipient', 'Amount INR', 'Corridor', 'Status', 'Date'], ...settlements.map(r => [r.id, r.name, r.value, r.corridor, r.status, r.date])];
    else if (type === 'volume') rows = [['Month', 'Volume USD million', 'Data type'], ...monthly.map((v, i) => [months[i], v, 'Illustrative'])];
    else rows = [['Corridor', 'Volume USD', 'Average time', 'Data type'], ...corridors.map(c => [c.name, c.volume, c.time, 'Illustrative'])];
    download('\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), `INRSettle-${type}-preview.csv`, 'text/csv;charset=utf-8');
    toast('Sample report downloaded.');
  }

  function renderTour() {
    $$('.tour-steps li').forEach((item, i) => {
      item.classList.toggle('active', i === tourStep);
      item.classList.toggle('done', i < tourStep);
      if (i === tourStep) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
    $('#tour-back').disabled = tourStep === 0;
    $('#tour-progress').textContent = `Step ${tourStep + 1} of 3`;
    const formatted = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(tourAmount);
    const nextLabels = ['Run Preflight', 'View Settlement', 'Explore Overview'];
    $('#tour-next').innerHTML = nextLabels[tourStep] + icon('arrow');
    if (tourStep === 0) {
      $('#tour-content').innerHTML = `<div class="tour-body"><h3>Start with the destination.</h3><p>Set the exact amount your verified Indian beneficiary should receive.</p><label class="tour-amount">Recipient gets · INR<input id="tour-amount" type="number" min="1" max="1000000000" step="0.01" value="${tourAmount}" inputmode="decimal" required aria-label="Sample recipient amount in INR"></label><div class="sample-beneficiary"><span class="round-icon">MC</span><div><strong>Meridian Commerce</strong><p>Sample beneficiary · India</p></div>${icon('check')}</div><fieldset class="choice-field tour-currencies" id="tour-currency"><legend>Funding currency</legend><div class="choice-card-grid">${['USDT', 'USDC'].map(code => `<label class="choice-option"><input class="choice-radio" type="radio" name="tour-currency" value="${code}"${tourCurrency === code ? ' checked' : ''}><span class="choice-card"><img class="choice-currency-icon" src="/assets/currencies/${code.toLowerCase()}.svg" width="32" height="32" alt=""><span class="choice-card-copy"><strong>${code}</strong><small>${code === 'USDT' ? 'Tether USD' : 'USD Coin'}</small></span><svg class="icon choice-card-check" aria-hidden="true"><use href="#i-check"/></svg></span></label>`).join('')}</div></fieldset></div>`;
    } else if (tourStep === 1) {
      $('#tour-content').innerHTML = `<div class="tour-body"><h3>Clarity before money moves.</h3><p>Preflight checks the requirements for a ₹ ${formatted} settlement funded in ${tourCurrency}.</p><div class="preflight-list"><div class="preflight-item" style="--delay:0s">${icon('check')}Beneficiary verification<span>Ready</span></div><div class="preflight-item" style="--delay:.1s">${icon('check')}Payment purpose<span>Ready</span></div><div class="preflight-item" style="--delay:.2s">${icon('check')}Funding & route availability<span>Ready</span></div><div class="preflight-item" style="--delay:.3s">${icon('shield')}Settlement preflight<span>READY</span></div></div></div>`;
    } else {
      $('#tour-content').innerHTML = `<div class="tour-body"><h3>A clear record of the result.</h3><p>Follow delivery, provider references and reconciliation in the same settlement view.</p><div class="tour-result"><span class="round-icon">${icon('check')}</span><strong>₹ ${formatted}</strong><p>Example result · Delivered to Meridian Commerce</p><div class="tour-receipt"><span>Settlement <b>STL-10482</b></span><span>Record <b>Matched</b></span></div></div></div>`;
    }
  }
  function startTour() {
    tourStep = 0;
    renderTour();
    openDialog($('#tour-dialog'));
  }
  $('#tour-next').addEventListener('click', () => {
    if (tourStep === 0) {
      const input = $('#tour-amount');
      if (!input.reportValidity()) return;
      const amount = Number(input.value);
      if (!Number.isFinite(amount) || amount < 1 || amount > 1000000000) return;
      tourAmount = amount;
      tourCurrency = $('input[name="tour-currency"]:checked').value;
    }
    if (tourStep < 2) {
      tourStep += 1;
      renderTour();
      $('#tour-content').setAttribute('tabindex', '-1');
      $('#tour-content').focus({ preventScroll: true });
    } else {
      closeDialog($('#tour-dialog'));
      clearTimeout(searchTimer);
      activeView = 'overview';
      $('#app-search').value = '';
      renderApp();
      $('#product').scrollIntoView({ behavior: prefersReducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
      $('.app-nav[data-view="overview"]').focus({ preventScroll: true });
    }
  });
  $('#tour-back').addEventListener('click', () => {
    if (tourStep > 0) { tourStep -= 1; renderTour(); }
  });

  const contactForm = $('#contact-form');
  const contactSubmit = $('#contact-submit');
  const contactStatus = $('#contact-status');
  let deliveryChannel = null;
  let requestId = crypto.randomUUID();
  let inquirySending = false;
  document.addEventListener('inrsettle:inquiry', event => {
    if (inquirySending) return openDialog($('#contact-dialog'));
    if (contactForm.hidden) {
      contactForm.hidden = false;
      $('#contact-result').hidden = true;
      contactStatus.hidden = true;
    }
    const { interest, volume, context, contextLabel } = event.detail || {};
    if (['settlements', 'integration', 'partnership', 'investor'].includes(interest)) contactForm.elements.interest.value = interest;
    if (['evaluating', 'under-100k', '100k-1m', 'over-1m'].includes(volume)) contactForm.elements.volume.value = volume;
    if (context) {
      contactForm.elements.context.value = String(context).slice(0, 2000);
      $('#contact-context-summary').textContent = String(contextLabel || 'Your selected workflow');
      $('#contact-context').hidden = false;
      requestId = crypto.randomUUID();
    }
    if ($('#detail-dialog').open) closeDialog($('#detail-dialog'));
    void checkInquiryDelivery();
    openDialog($('#contact-dialog'));
  });
  $('#contact-context-remove').addEventListener('click', () => {
    contactForm.elements.context.value = '';
    $('#contact-context').hidden = true;
    requestId = crypto.randomUUID();
  });
  contactForm.addEventListener('input', () => { requestId = crypto.randomUUID(); });
  async function checkInquiryDelivery() {
    let available = false;
    try {
      const response = await fetch('/api/contact', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      const availability = await response.json();
      available = response.ok && availability.available === true;
      if (available) deliveryChannel = availability.channel === 'telegram' ? 'telegram' : 'email';
    } catch { /* Submission still retries the server; never switch to a mail draft. */ }
    if (!inquirySending) {
      contactSubmit.innerHTML = 'Send Inquiry ' + icon('arrow');
      $('#contact-mode').textContent = available
        ? 'Your inquiry is sent directly to the INRSettle team.'
        : 'Online submission is temporarily unavailable. You can retry without losing your details.';
    }
  }
  function reportInquiry(message, error = false) {
    contactStatus.textContent = message;
    contactStatus.hidden = false;
    contactStatus.classList.toggle('error', error);
    contactStatus.focus({ preventScroll: true });
  }
  contactForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (inquirySending || !contactForm.reportValidity()) return;
    const data = Object.fromEntries(new FormData(contactForm));
    if (data.website) return;
    inquirySending = true;
    contactSubmit.disabled = true;
    contactSubmit.textContent = 'Sending…';
    contactStatus.hidden = true;
    try {
      const response = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify(data), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok || result.accepted !== true) throw new Error('delivery_failed');
      contactForm.hidden = true;
      $('#contact-result').hidden = false;
      $('#edit-inquiry').focus();
      contactForm.reset();
      $('#contact-context').hidden = true;
      requestId = crypto.randomUUID();
    } catch {
      reportInquiry('We couldn’t confirm submission. Your details are still here. Try again, or email info@inrsettle.com directly.', true);
    } finally {
      inquirySending = false;
      contactSubmit.disabled = false;
      contactSubmit.innerHTML = 'Send Inquiry ' + icon('arrow');
    }
  });
  $('#edit-inquiry').addEventListener('click', () => {
    $('#contact-result').hidden = true;
    contactForm.hidden = false;
    contactStatus.hidden = true;
    $('input', contactForm).focus();
  });
  function showInquiryPrivacy() {
    if ($('#contact-dialog').open) closeDialog($('#contact-dialog'));
    $('#detail-content').innerHTML = `<p class="eyebrow">Business inquiries</p><h2 id="detail-title">Start a conversation.<br><span class="teal-text">Keep it clear.</span></h2><p class="detail-description">Share business contact details and a short description of your settlement needs. Please don’t include bank details, identity documents, credentials or customer information.</p><ul class="detail-list"><li>${icon('check')}<span>Your inquiry is submitted through the website to the INRSettle team${deliveryChannel === 'telegram' ? ' through Telegram' : deliveryChannel === 'email' ? ' through our email delivery service' : ''}. Your work email is used for the reply.</span></li><li>${icon('check')}<span>Submission is confirmed only after the delivery service accepts your inquiry. If confirmation fails, your details stay in the form so you can retry.</span></li><li>${icon('check')}<span>Inquiries are handled as business correspondence. For questions, corrections or a deletion request, contact info@inrsettle.com.</span></li></ul><a class="contact-email-link" href="mailto:info@inrsettle.com">info@inrsettle.com ${icon('arrow')}</a><div class="actions"><button class="button secondary" data-detail-contact>Back to Inquiry</button></div>`;
    $('#detail-dialog').setAttribute('aria-labelledby', 'detail-title');
    openDialog($('#detail-dialog'));
  }

  const menuToggle = $('.menu-toggle');
  const mobileNav = $('#mobile-nav');
  function closeMenu() {
    mobileNav.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
    $('use', menuToggle).setAttribute('href', '#i-menu');
  }
  menuToggle.addEventListener('click', () => {
    const opening = mobileNav.hidden;
    mobileNav.hidden = !opening;
    menuToggle.setAttribute('aria-expanded', String(opening));
    menuToggle.setAttribute('aria-label', opening ? 'Close navigation' : 'Open navigation');
    $('use', menuToggle).setAttribute('href', opening ? '#i-close' : '#i-menu');
  });
  window.matchMedia('(min-width: 1101px)').addEventListener('change', event => {
    if (event.matches) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !mobileNav.hidden) { closeMenu(); menuToggle.focus(); }
  });
  document.addEventListener('click', event => {
    const target = event.target.closest('button, a');
    if (!mobileNav.hidden && !event.target.closest('#topbar')) closeMenu();
    if (!target) return;
    if (target.closest('.mobile-nav')) closeMenu();
    if (target.hasAttribute('data-close')) return closeDialog(target.closest('dialog'));
    if (target.hasAttribute('data-tour')) return startTour();
    if (target.hasAttribute('data-detail-tour')) { closeDialog($('#detail-dialog')); return startTour(); }
    if (target.hasAttribute('data-detail-contact')) { closeDialog($('#detail-dialog')); void checkInquiryDelivery(); return openDialog($('#contact-dialog')); }
    if (target.dataset.open === 'contact') { event.preventDefault(); void checkInquiryDelivery(); return openDialog($('#contact-dialog')); }
    if (target.dataset.open === 'privacy') return showInquiryPrivacy();
    if (target.dataset.open === 'developers') return showDevelopers();
    if (target.dataset.open === 'corridors') return showCorridors();
    if (target.dataset.role) return setRole(target);
    if (target.dataset.flow) return setFlow(target);
    if (target.dataset.feature) return showFeature(target.dataset.feature);
    if (target.hasAttribute('data-copy-api')) return copyText(codeExample, 'Integration example copied.');
    if (target.dataset.view) {
      clearTimeout(searchTimer);
      activeView = target.dataset.view;
      $('#app-search').value = '';
      return renderApp();
    }
    if (target.dataset.chart) {
      activeChart = target.dataset.chart;
      renderApp();
      $(`[data-chart="${activeChart}"]`).focus({ preventScroll: true });
      return;
    }
    if (target.dataset.month !== undefined) {
      selectedMonth = Number(target.dataset.month);
      $$('.chart-bar').forEach(bar => {
        const selected = Number(bar.dataset.month) === selectedMonth;
        bar.classList.toggle('selected', selected);
        bar.setAttribute('aria-pressed', String(selected));
      });
      $$('.bar-tooltip').forEach(tooltip => tooltip.remove());
      const tooltip = document.createElement('span');
      tooltip.className = 'bar-tooltip';
      tooltip.textContent = `$${(monthly[selectedMonth] * (activeChart === 'inr' ? 1 : .67)).toFixed(1)}M`;
      target.parentElement.append(tooltip);
      return;
    }
    if (target.dataset.report) exportReport(target.dataset.report);
  });

  // Ribbon visibility and reduced motion are handled by hero-flow.js.

  // Reveal transitions have a reduced-motion path.
  if ('IntersectionObserver' in window && !prefersReducedMotion.matches) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: .08, rootMargin: '0px 0px 25px 0px' });
    $$('.reveal').forEach(element => observer.observe(element));
    document.documentElement.classList.add('js-motion');
  }
  let scrollPending = false;
  let activeSection = null;
  const sectionAnchors = $$('.desktop-nav a[href^="#"], .site-footer-column a[href^="#"]');
  const sectionElements = ['solutions', 'corridors', 'product', 'company'].map(id => document.getElementById(id));
  function updateScroll() {
    $('#topbar').classList.toggle('is-scrolled', window.scrollY > 100);
    let nextSection = null;
    sectionElements.forEach(section => {
      if (section.getBoundingClientRect().top <= window.innerHeight * .4) nextSection = section.id;
    });
    if (nextSection !== activeSection) {
      activeSection = nextSection;
      sectionAnchors.forEach(anchor => {
        if (anchor.hash === `#${activeSection}`) anchor.setAttribute('aria-current', 'location');
        else anchor.removeAttribute('aria-current');
      });
    }
    scrollPending = false;
  }
  window.addEventListener('scroll', () => {
    if (!scrollPending) { scrollPending = true; requestAnimationFrame(updateScroll); }
  }, { passive: true });
  let glassFrame = 0;
  let glassTarget = null;
  let glassPointerX = 0;
  let glassPointerY = 0;
  $('.feature-grid').addEventListener('pointermove', event => {
    if (prefersReducedMotion.matches || !hoverPointer.matches) return;
    const card = event.target.closest('.feature-card');
    if (!card) return;
    glassTarget = card;
    glassPointerX = event.clientX;
    glassPointerY = event.clientY;
    if (glassFrame) return;
    glassFrame = requestAnimationFrame(() => {
      const rect = glassTarget.getBoundingClientRect();
      glassTarget.style.setProperty('--glass-x', `${glassPointerX - rect.left}px`);
      glassTarget.style.setProperty('--glass-y', `${glassPointerY - rect.top}px`);
      glassFrame = 0;
    });
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    const state = document.hidden ? 'paused' : 'running';
    document.documentElement.classList.toggle('page-inactive', document.hidden);
    $$('.flow-track span').forEach(element => element.style.animationPlayState = state);
  });
  renderApp();
  updateScroll();
  // Public resource pages link directly to the inquiry dialog.
  function openLinkedInquiry() {
    if (window.location.hash === '#contact-dialog') {
      document.dispatchEvent(new CustomEvent('inrsettle:inquiry'));
    }
  }
  window.addEventListener('hashchange', openLinkedInquiry);
  openLinkedInquiry();
})();

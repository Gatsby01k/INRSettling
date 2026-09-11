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
  let inquiryText = '';
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
    psps: 'A complete infrastructure layer to move value with speed, certainty and control.',
    merchants: 'Collect locally. Settle globally. Bring your cross-border payments into one clear workflow.',
    otc: 'Coordinate liquidity, counterparties and settlement evidence across your trading operations.',
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
      icon: 'globe', eyebrow: 'One connected settlement layer', title: 'Everything moves <span class="teal-text">together.</span>',
      description: 'Bring funding, settlement controls and operational visibility into a single workflow for your business.',
      items: ['Specify the INR amount and verified beneficiary before funding.', 'See the requirements that must be resolved before a settlement can proceed.', 'Follow the settlement through routing, reconciliation and final evidence.']
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
      icon: 'route', eyebrow: 'Settlement routing', title: 'A clearer route <span class="teal-text">to India.</span>',
      description: 'Connect settlement intent to a suitable provider through a consistent operational workflow.',
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

  const codeExample = `POST /v1/settlements\nAuthorization: Bearer YOUR_API_KEY\nIdempotency-Key: unique-request-id\n\n{\n  "beneficiary_id": "your_verified_beneficiary",\n  "destination_currency": "INR",\n  "destination_amount": "1250000.00",\n  "source_currency": "USDT",\n  "purpose": "commercial_payment"\n}`;
  function showDevelopers() {
    $('#detail-content').innerHTML = `<span class="round-icon detail-icon">${icon('code')}</span><p class="eyebrow">Built for your stack</p><h2 id="detail-title">One integration.<br><span class="teal-text">Connected operations.</span></h2><p class="detail-description">Express your settlement intent, check readiness and follow status changes through a consistent API workflow.</p><pre class="code-block"><code>${escapeHtml(codeExample)}</code></pre><p class="code-caption">Illustrative request. Confirm the final API contract and credentials with your INRSettle contact.</p><div class="actions"><button class="button primary" data-copy-api>${icon('copy')}Copy Example</button><button class="button secondary" data-detail-contact>Talk to Our Team</button></div>`;
    $('#detail-dialog').setAttribute('aria-labelledby', 'detail-title');
    openDialog($('#detail-dialog'));
  }
  function showCorridors() {
    $('#detail-content').innerHTML = `<p class="eyebrow">From India to opportunity</p><h2 id="detail-title">A more connected<br><span class="teal-text">world.</span></h2><p class="detail-description">Explore the corridors in the product preview. Available routes depend on your provider and business requirements.</p><div class="corridor-modal-list">${corridors.map(c => `<div class="corridor-option"><span class="round-icon"><span class="currency-flag flag-${c.flag}">${c.symbol}</span></span><div><strong>${c.name}</strong><p>${c.detail}</p></div><span>Preview route</span></div>`).join('')}</div><button class="button primary" data-detail-contact>Discuss Your Corridor ${icon('arrow')}</button>`;
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
    return `${appTitle('Global Settlement Overview')}<div class="dashboard-kpis">${kpi('Total Volume (YTD)', '<b>$</b> 248.4M', '+12%')}${kpi('Successful Settlements', '12,428', '99.9%')}${kpi('Average Settlement Time', '48s', '−32%')}${kpi('Active Corridors', '52', '+6 new')}</div><div class="app-overview-bottom"><div class="chart-panel"><div class="panel-heading"><h4>Settlement Volume</h4><div class="chart-switch" role="group" aria-label="Chart funding currency"><button class="${activeChart === 'inr' ? 'active' : ''}" data-chart="inr" aria-pressed="${activeChart === 'inr'}">INR</button><button class="${activeChart === 'stablecoins' ? 'active' : ''}" data-chart="stablecoins" aria-pressed="${activeChart === 'stablecoins'}">Stablecoins</button></div></div><div class="chart" aria-label="Illustrative monthly settlement volume in millions of US dollars"><div class="chart-scale" aria-hidden="true"><span>50</span><span>25</span><span>0</span></div>${monthly.map((value, i) => `<div class="bar-wrap" style="--bar-height:${(value * multiplier / 55 * 100).toFixed(1)}%"><button class="chart-bar ${i === selectedMonth ? 'selected' : ''}" data-month="${i}" style="--delay:${i * .04}s" aria-label="${months[i]}: $${(value * multiplier).toFixed(1)} million" aria-pressed="${i === selectedMonth}"></button><span class="bar-label">${months[i]}</span>${i === selectedMonth ? `<span class="bar-tooltip">$${(value * multiplier).toFixed(1)}M</span>` : ''}</div>`).join('')}</div></div><div class="corridor-panel"><div class="panel-heading"><h4>Corridors</h4></div>${corridors.map(c => `<div class="corridor-row"><span class="currency-flag flag-${c.flag}">${c.symbol}</span><span>${c.name}</span><span class="status">Live</span></div>`).join('')}</div></div>`;
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
    return `${appTitle('Global Corridors')}<div class="app-table-wrap"><table class="app-table"><thead><tr><th>Corridor</th><th>Volume</th><th>Avg. time</th><th>Status</th></tr></thead><tbody>${corridors.map(c => `<tr><td><span class="currency-flag flag-${c.flag}" style="display:inline-flex;vertical-align:middle;margin-right:6px">${c.symbol}</span>${c.name}</td><td class="amount">${c.volume}</td><td>${c.time}</td><td><span class="status-pill">Active</span></td></tr>`).join('')}</tbody></table></div>`;
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
      $('#tour-content').innerHTML = `<div class="tour-body"><h3>Start with the destination.</h3><p>Set the exact amount your verified Indian beneficiary should receive.</p><label class="tour-amount">Recipient gets · INR<input id="tour-amount" type="number" min="1" max="1000000000" step="0.01" value="${tourAmount}" inputmode="decimal" required aria-label="Sample recipient amount in INR"></label><div class="sample-beneficiary"><span class="round-icon">MC</span><div><strong>Meridian Commerce</strong><p>Sample beneficiary · India</p></div>${icon('check')}</div><label style="margin-top:14px">Funding currency<select id="tour-currency"><option${tourCurrency === 'USDT' ? ' selected' : ''}>USDT</option><option${tourCurrency === 'USDC' ? ' selected' : ''}>USDC</option></select></label></div>`;
    } else if (tourStep === 1) {
      $('#tour-content').innerHTML = `<div class="tour-body"><h3>Clarity before money moves.</h3><p>Preflight checks the requirements for a ₹ ${formatted} settlement funded in ${tourCurrency}.</p><div class="preflight-list"><div class="preflight-item" style="--delay:0s">${icon('check')}Beneficiary verification<span>Ready</span></div><div class="preflight-item" style="--delay:.1s">${icon('check')}Payment purpose<span>Ready</span></div><div class="preflight-item" style="--delay:.2s">${icon('check')}Funding & route availability<span>Ready</span></div><div class="preflight-item" style="--delay:.3s">${icon('shield')}Settlement preflight<span>READY</span></div></div></div>`;
    } else {
      $('#tour-content').innerHTML = `<div class="tour-body"><h3>A clear record of the result.</h3><p>Follow delivery, provider references and reconciliation in the same settlement view.</p><div class="tour-result"><span class="round-icon">${icon('check')}</span><strong>₹ ${formatted}</strong><p>Example result · Delivered to Meridian Commerce</p><div class="tour-receipt"><span>Settlement <b>STL-10482</b></span><span>Reconciled <b>48s</b></span></div></div></div>`;
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
      tourCurrency = $('#tour-currency').value;
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

  $('#contact-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const data = new FormData(event.currentTarget);
    inquiryText = `INRSETTLE — PARTNERSHIP INQUIRY\n\nName: ${String(data.get('name')).trim()}\nWork email: ${String(data.get('email')).trim()}\nCompany: ${String(data.get('company')).trim()}\nBusiness: ${data.get('role')}\n\nSettlement needs\n${String(data.get('message')).trim()}\n\nPrepared locally. This inquiry has not been sent.`;
    $('#inquiry-preview').textContent = inquiryText;
    $('#contact-form').hidden = true;
    $('#contact-result').hidden = false;
    $('#download-inquiry').focus();
  });
  $('#download-inquiry').addEventListener('click', () => download(inquiryText, 'INRSettle-inquiry.txt'));
  $('#copy-inquiry').addEventListener('click', () => copyText(inquiryText, 'Your inquiry was copied.'));
  $('#edit-inquiry').addEventListener('click', () => {
    $('#contact-result').hidden = true;
    $('#contact-form').hidden = false;
    $('#contact-form input').focus();
  });

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
  window.matchMedia('(min-width: 821px)').addEventListener('change', event => {
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
    if (target.hasAttribute('data-detail-contact')) { closeDialog($('#detail-dialog')); return openDialog($('#contact-dialog')); }
    if (target.dataset.open === 'contact') return openDialog($('#contact-dialog'));
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

  // Animation work is restricted to transform/opacity, with a reduced-motion path.
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
  const sectionAnchors = $$('.desktop-nav a[href^="#"], .footer nav a[href^="#"]');
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
  const heroArt = $('.hero-art');
  $('.hero-shell').addEventListener('pointermove', event => {
    if (prefersReducedMotion.matches || !hoverPointer.matches || window.innerWidth < 820) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    heroArt.style.setProperty('--art-x', `${x * 9}px`);
    heroArt.style.setProperty('--art-y', `${y * 5}px`);
    heroArt.style.setProperty('--emblem-x', `${x * 3}px`);
    heroArt.style.setProperty('--emblem-y', `${y * 2}px`);
  }, { passive: true });
  $('.hero-shell').addEventListener('pointerleave', () => {
    heroArt.style.setProperty('--art-x', '0px');
    heroArt.style.setProperty('--art-y', '0px');
    heroArt.style.setProperty('--emblem-x', '0px');
    heroArt.style.setProperty('--emblem-y', '0px');
  });
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
    $$('.hero-light, .flow-track span').forEach(element => element.style.animationPlayState = state);
  });
  renderApp();
  updateScroll();
})();

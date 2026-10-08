/** Pure entry-page renderer. Authentication and request handling stay on the server. */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-5-5 5 5-5 5"/></svg>';
const eye = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const lock = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>';

function localAction(value) {
  const candidate = String(value ?? '/app/sign-in');
  return candidate.startsWith('/') && !candidate.startsWith('//')
    && !/[\s\\\u0000-\u001f]/.test(candidate) ? candidate : '/app/sign-in';
}

/**
 * state: preview (default), unavailable, or signin (explicit future email flow).
 * messageKind: error (default) or status, for expiry and sign-out notices.
 * Only an explicitly configured server should select the signin state.
 */
export function renderAccessPage({
  state = 'preview', action = '/app/sign-in', message = '', messageKind = 'error',
  csrfToken = '', email = '', view = '', copyrightYear = 2026,
} = {}) {
  const unavailable = state === 'unavailable';
  const signin = state === 'signin';
  const notice = String(message ?? '').trim();
  const isError = notice !== '' && messageKind !== 'status' && !unavailable;
  const heading = unavailable ? 'Workspace access is unavailable.'
    : signin ? 'Sign in to your workspace.' : 'Open your workspace.';
  const description = unavailable ? 'Contact our team to arrange access. We’ll help you take the next step.'
    : signin ? 'Use your work email to continue.' : 'Enter the access code shared by INRSettle.';
  const buttonLabel = unavailable ? 'Access unavailable' : signin ? 'Continue with email' : 'Open workspace';
  const pendingLabel = signin ? 'Continuing…' : 'Opening workspace…';
  const noticeHtml = notice ? `<p class="access-notice${isError ? ' access-notice-error' : ''}" id="access-notice" role="${isError ? 'alert' : 'status'}">${escapeHtml(notice)}</p>` : '';
  const field = unavailable ? '' : signin
    ? `<div class="access-field"><label for="access-email">Work email</label><div class="access-input-shell"><input id="access-email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="you@company.com" value="${escapeHtml(email)}" required${isError ? ' aria-invalid="true"' : ''}${notice ? ' aria-describedby="access-notice"' : ''}></div></div>`
    : `<div class="access-field"><label for="access-code">Access code</label><div class="access-input-shell access-secret-shell"><input id="access-code" name="code" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="256" required aria-describedby="access-code-hint${notice ? ' access-notice' : ''}"${isError ? ' aria-invalid="true"' : ''}><button class="access-reveal" type="button" aria-label="Show access code" aria-controls="access-code" aria-pressed="false" data-access-reveal>${eye}<span>Show</span></button></div><p class="access-field-hint" id="access-code-hint">Use the code provided for your private walkthrough.</p></div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f1f7fb">
  <meta name="robots" content="noindex, nofollow, nosnippet">
  <title>${escapeHtml(signin ? 'Sign in' : unavailable ? 'Workspace access' : 'Private preview')} · INRSettle</title>
  <link rel="icon" type="image/svg+xml" href="/assets/brand-favicon.svg">
  <link rel="preload" as="font" type="font/woff2" href="/assets/fonts/sora-latin-variable.woff2" crossorigin>
  <link rel="preload" as="font" type="font/woff2" href="/assets/fonts/instrument-sans-latin-variable.woff2" crossorigin>
  <link rel="stylesheet" href="/typography.css?v=20261003">
  <link rel="stylesheet" href="/access.css?v=20261008">
  <script src="/access.js?v=20261008" defer></script>
</head>
<body class="access-page">
  <a class="access-skip" href="#access-main">Skip to workspace access</a>
  <header class="access-header">
    <a class="access-brand" href="/" aria-label="INRSettle website"><img src="/assets/brand-lockup.svg" width="934" height="152" alt="INRSettle"></a>
    <a class="access-back" href="/">${arrow}<span>Back to website</span></a>
  </header>
  <main class="access-main" id="access-main" tabindex="-1" aria-labelledby="access-heading">
    <div class="access-layout">
      <section class="access-panel" aria-labelledby="access-heading">
        <p class="access-overline">${lock}<span>${signin ? 'Workspace access' : 'Private preview'}</span></p>
        <h1 id="access-heading">${heading}</h1>
        <p class="access-description">${description}</p>
        ${noticeHtml}
        <form class="access-form" method="POST" action="${escapeHtml(localAction(action))}" data-access-form data-pending-label="${pendingLabel}"${unavailable ? ' aria-disabled="true"' : ''}>
          ${csrfToken ? `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">` : ''}
          ${view ? `<input type="hidden" name="view" value="${escapeHtml(view)}">` : ''}
          ${field}
          <button class="access-submit" type="submit"${unavailable ? ' disabled' : ''}><span class="access-submit-label">${buttonLabel}</span><span class="access-spinner" aria-hidden="true" hidden></span>${arrow}</button>
          <p class="access-pending" role="status" aria-live="polite" data-access-pending hidden></p>
        </form>
        <p class="access-help">${unavailable ? 'Let’s discuss your workspace.' : signin ? 'Need workspace access?' : 'Need an access code?'} <a href="/#contact-dialog">Contact our team ${arrow}</a></p>
        ${signin ? '' : '<p class="access-preview-note">Sample data only. Payments are not connected.</p>'}
      </section>
      <aside class="access-scene" aria-hidden="true">
        <div class="access-art-frame"><div class="access-illustration"><img class="access-artwork" src="/assets/hero-plate.webp" width="1659" height="948" alt=""><img class="access-emblem" src="/assets/brand-symbol.svg" width="833" height="676" alt=""></div></div>
        <div class="access-scene-copy"><p>India. Connected.</p><h2>A clearer path to<br>every settlement.</h2><div class="access-corridor"><span>INR</span><span class="access-corridor-line"></span>${arrow}<span>Global corridors</span></div></div>
      </aside>
    </div>
  </main>
  <footer class="access-footer"><p>© ${escapeHtml(copyrightYear)} INRSettle</p><nav aria-label="Workspace access footer"><a href="/privacy">Privacy</a><a href="/security">Security</a></nav></footer>
</body>
</html>`;
}

export default renderAccessPage;

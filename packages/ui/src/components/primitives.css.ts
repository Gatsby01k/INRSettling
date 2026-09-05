import { tokensToCss } from '../tokens/to-css.js'
import { screensCss } from './screens.css.js'

/**
 * Component styles, emitted alongside the token custom properties.
 *
 * Plain CSS against the token variables: no CSS-in-JS runtime, no utility
 * framework. A financial UI changes slowly and is read often, and this keeps
 * what renders one grep away from what was specified.
 */
export const primitivesCss = `${tokensToCss()}
*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--color-bg-base);
  color: var(--color-ink);
  font-family: var(--font-ui);
  font-size: var(--type-body-size);
  line-height: var(--type-body-line);
}

/* Focus is as visible as hover, everywhere, and is never removed. */
:where(button, a, input, textarea, select, [tabindex]):focus-visible {
  outline: 2px solid var(--color-accent-teal-deep);
  outline-offset: 2px;
}

.is-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-1);
  min-height: 36px; padding: 0 var(--space-4);
  border: 1px solid transparent; border-radius: var(--radius-md);
  font: inherit; font-weight: 550; cursor: pointer;
  transition: background-color var(--motion-micro-duration) var(--motion-micro-easing),
              border-color var(--motion-micro-duration) var(--motion-micro-easing),
              color var(--motion-micro-duration) var(--motion-micro-easing);
}
.is-btn[disabled] { cursor: not-allowed; opacity: 1; }
.is-btn--primary { background: var(--color-ink); color: var(--color-ink-inverse); }
.is-btn--primary:hover:not([disabled]) { background: var(--color-ink-secondary); }
.is-btn--primary[disabled] { background: var(--color-bg-sunken); color: var(--color-ink-disabled); }
.is-btn--secondary { background: var(--color-bg-surface); color: var(--color-ink); border-color: var(--color-border-strong); }
.is-btn--secondary:hover:not([disabled]) { background: var(--color-bg-hover); }
.is-btn--secondary[disabled] { color: var(--color-ink-disabled); border-color: var(--color-border); }
.is-btn--ghost { background: transparent; color: var(--color-ink-secondary); }
.is-btn--ghost:hover:not([disabled]) { background: var(--color-bg-hover); }
.is-btn--destructive { background: var(--status-action-required-fg); color: var(--color-ink-inverse); }
.is-btn--destructive[disabled] { background: var(--color-bg-sunken); color: var(--color-ink-disabled); }
.is-btn--icon { min-width: 36px; padding: 0; }

.is-field { display: flex; flex-direction: column; gap: var(--space-1); }
.is-field__label {
  font-size: var(--type-label-size); line-height: var(--type-label-line);
  font-weight: var(--type-label-weight); letter-spacing: var(--type-label-tracking);
  text-transform: uppercase; color: var(--color-ink-secondary);
}
.is-field__control {
  min-height: 36px; padding: 0 var(--space-3);
  background: var(--color-bg-surface); color: var(--color-ink);
  border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm);
  font: inherit;
}
.is-field__control:disabled { background: var(--color-bg-sunken); color: var(--color-ink-disabled); cursor: not-allowed; }
.is-field__control[aria-invalid='true'] { border-color: var(--status-action-required-fg); }
.is-field__help { font-size: var(--type-caption-size); color: var(--color-ink-muted); }
.is-field__error { font-size: var(--type-caption-size); color: var(--status-action-required-fg); }
textarea.is-field__control { min-height: 84px; padding: var(--space-2) var(--space-3); resize: vertical; }

.is-check { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; }
.is-check input:disabled + span { color: var(--color-ink-disabled); cursor: not-allowed; }

.is-switch { position: relative; width: 36px; height: 20px; flex: none; }
.is-switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.is-switch__track {
  display: block; width: 100%; height: 100%; border-radius: var(--radius-pill);
  background: var(--color-border-strong);
  transition: background-color var(--motion-micro-duration) var(--motion-micro-easing);
}
.is-switch input:checked + .is-switch__track { background: var(--color-accent-teal-deep); }
.is-switch input:disabled + .is-switch__track { background: var(--color-border); }
.is-switch__thumb {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--color-bg-surface); box-shadow: var(--shadow-sm);
  transition: transform var(--motion-micro-duration) var(--motion-micro-easing);
}
.is-switch input:checked ~ .is-switch__thumb { transform: translateX(16px); }

.is-divider { border: 0; border-top: 1px solid var(--color-border); margin: var(--space-5) 0; }

/* Skeletons match the final dimensions so nothing shifts when content lands. */
.is-skeleton {
  display: block; border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--color-bg-sunken) 25%, var(--color-bg-hover) 37%, var(--color-bg-sunken) 63%);
  background-size: 400% 100%;
  animation: is-shimmer 1.4s ease-in-out infinite;
}
@keyframes is-shimmer { from { background-position: 100% 50%; } to { background-position: 0 50%; } }

.is-spinner {
  display: inline-block; width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--color-border-strong); border-top-color: var(--color-ink-secondary);
  animation: is-spin 700ms linear infinite;
}
@keyframes is-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .is-skeleton, .is-spinner { animation: none; }
  .is-skeleton { background: var(--color-bg-sunken); }
}

.is-empty {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3);
  padding: var(--space-8); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); background: var(--color-bg-surface);
}
.is-empty__title { font-size: var(--type-h3-size); font-weight: var(--type-h3-weight); margin: 0; }
.is-empty__body { color: var(--color-ink-muted); margin: 0; max-width: 52ch; }

.is-tooltip { position: relative; display: inline-flex; }
.is-tooltip__bubble {
  position: absolute; bottom: calc(100% + var(--space-2)); left: 50%; transform: translateX(-50%);
  padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm);
  background: var(--color-ink); color: var(--color-ink-inverse);
  font-size: var(--type-caption-size); white-space: nowrap; box-shadow: var(--shadow-md);
}

.is-modal__scrim { position: fixed; inset: 0; background: rgba(10, 26, 47, 0.32); display: grid; place-items: center; }
.is-modal {
  background: var(--color-bg-surface); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg); padding: var(--space-7);
  width: min(480px, calc(100vw - var(--space-8)));
}
.is-modal__title { margin: 0 0 var(--space-3); font-size: var(--type-h2-size); font-weight: var(--type-h2-weight); }
.is-modal__actions { display: flex; gap: var(--space-3); justify-content: flex-end; margin-top: var(--space-6); }

/*
 * Amount input -- tabular, no spinners, symbol inside the field.
 *
 * Block name is is-amount-field, not is-amount. Both this and AmountDisplay
 * used to claim the is-amount block with incompatible rules, and the display's
 * block is declared later in this file, so it won: the input's wrapper lost
 * position: relative and became an inline-flex column. Its currency symbol is
 * absolutely positioned, so it left the field and anchored to whatever ancestor
 * happened to be positioned, and the field stopped filling its width -- on
 * "Recipient gets", the first figure typed on the screen PRODUCT.md 12.2 calls
 * the most important in the product. check-styles.mjs now rejects the shape.
 */
.is-amount-field { position: relative; display: flex; align-items: center; }
.is-amount-field__symbol {
  position: absolute; left: var(--space-3); color: var(--color-ink-secondary);
  pointer-events: none; font-variant-numeric: tabular-nums;
}
.is-amount-field__control {
  width: 100%; min-height: 40px; padding: 0 var(--space-3) 0 var(--space-7);
  font-size: var(--type-h2-size); font-weight: var(--type-h2-weight);
  font-variant-numeric: tabular-nums; letter-spacing: var(--type-h2-tracking);
  background: var(--color-bg-surface); color: var(--color-ink);
  border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm);
}
.is-amount-field__control::-webkit-outer-spin-button,
.is-amount-field__control::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.is-amount-field__control[aria-invalid='true'] { border-color: var(--status-action-required-fg); }
.is-amount-field__control:disabled { background: var(--color-bg-sunken); color: var(--color-ink-disabled); }

/* ---- radio group ---- */
.is-radios { display: flex; flex-direction: column; gap: var(--space-2); }

/* ---- combobox ---- */
.is-combo { position: relative; }
.is-combo__list {
  position: absolute; z-index: 20; top: calc(100% + var(--space-1)); left: 0; right: 0;
  margin: 0; padding: var(--space-1); list-style: none; max-height: 240px; overflow-y: auto;
  background: var(--color-bg-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-md); box-shadow: var(--shadow-md);
}
.is-combo__option { padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); cursor: pointer; }
.is-combo__option[aria-selected='true'] { background: var(--color-bg-hover); }
.is-combo__empty { padding: var(--space-3); color: var(--color-ink-muted); }

/* ---- file drop ---- */
.is-filedrop {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2);
  padding: var(--space-6); border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-lg); background: var(--color-bg-surface); cursor: pointer;
}
.is-filedrop[data-dragging='true'] { border-color: var(--color-accent-teal-deep); background: var(--color-bg-hover); }
.is-filedrop[aria-disabled='true'] { cursor: not-allowed; background: var(--color-bg-sunken); }
.is-filedrop__list { margin: 0; padding-left: var(--space-5); color: var(--color-ink-secondary); }

/* ---- popover / drawer / toast ---- */
.is-popover { position: relative; display: inline-flex; }
.is-popover__panel {
  position: absolute; z-index: 30; top: calc(100% + var(--space-2)); left: 0; min-width: 220px;
  padding: var(--space-4); background: var(--color-bg-surface);
  border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-md);
}

.is-drawer__scrim { position: fixed; inset: 0; background: rgba(10, 26, 47, 0.32); }
.is-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100vw);
  padding: var(--space-7); background: var(--color-bg-surface);
  box-shadow: var(--shadow-lg); overflow-y: auto;
}
.is-drawer__title { margin: 0 0 var(--space-4); font-size: var(--type-h2-size); font-weight: var(--type-h2-weight); }

.is-toast {
  display: flex; align-items: flex-start; gap: var(--space-3);
  padding: var(--space-3) var(--space-4); border-radius: var(--radius-md);
  border: 1px solid var(--color-border); background: var(--color-bg-surface);
  box-shadow: var(--shadow-md); max-width: 420px;
}
.is-toast--success { border-color: var(--status-settled-fg); }
.is-toast--error   { border-color: var(--status-action-required-fg); }
.is-toast__body { flex: 1; }

/* ---- tabs / breadcrumb ---- */
.is-tabs { display: block; }
.is-tabs__list { display: flex; gap: var(--space-5); border-bottom: 1px solid var(--color-border); }
.is-tabs__tab {
  appearance: none; background: none; border: 0; padding: var(--space-3) 0;
  font: inherit; color: var(--color-ink-muted); cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.is-tabs__tab[aria-selected='true'] { color: var(--color-ink); border-bottom-color: var(--color-ink); }
.is-tabs__tab:disabled { color: var(--color-ink-disabled); cursor: not-allowed; }
.is-tabs__panel { padding-top: var(--space-4); }

.is-crumbs { font-size: var(--type-body-sm-size); }
.is-crumbs__list { display: flex; flex-wrap: wrap; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
.is-crumbs__sep { color: var(--color-ink-muted); }
.is-crumbs__current { color: var(--color-ink); font-weight: 550; }

/* ---- Stage 2 domain components ---- */

.is-status { display: inline-flex; align-items: baseline; gap: var(--space-2); font-size: var(--type-body-sm-size); }
.is-status__dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
.is-status__label { font-weight: 550; }
.is-status__detail { color: var(--color-ink-muted); }
.is-status--ready           .is-status__dot { background: var(--status-ready-fg); }
.is-status--ready           .is-status__label { color: var(--status-ready-fg); }
.is-status--settling        .is-status__dot { background: var(--status-settling-fg); }
.is-status--settling        .is-status__label { color: var(--status-settling-fg); }
.is-status--settled         .is-status__dot { background: var(--status-settled-fg); }
.is-status--settled         .is-status__label { color: var(--status-settled-fg); }
.is-status--action_required .is-status__dot { background: var(--status-action-required-fg); }
.is-status--action_required .is-status__label { color: var(--status-action-required-fg); }
.is-status--cancelled       .is-status__dot { background: var(--status-cancelled-fg); }
.is-status--cancelled       .is-status__label { color: var(--status-cancelled-fg); }

.is-requirement {
  display: flex; align-items: flex-start; gap: var(--space-4);
  padding: var(--space-4); border-radius: var(--radius-md);
  border: 1px solid var(--color-border); background: var(--color-bg-surface);
}
.is-requirement--blocking { border-left: 3px solid var(--status-action-required-fg); }
.is-requirement--advisory { border-left: 3px solid var(--status-ready-fg); }
.is-requirement__body { flex: 1; min-width: 0; }
.is-requirement__title {
  margin: 0 0 var(--space-2); font-size: var(--type-body-size); font-weight: 600; color: var(--color-ink);
}
.is-requirement__detail { margin: 0; color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }
.is-requirement__action { flex: none; }

.is-picker { position: relative; }
.is-picker__list {
  position: absolute; z-index: 20; left: 0; right: 0; margin: var(--space-1) 0 0; padding: var(--space-1);
  list-style: none; max-height: 320px; overflow-y: auto;
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: var(--color-bg-surface); box-shadow: var(--shadow-md);
}
.is-picker__option {
  display: grid; grid-template-columns: 1fr auto; gap: var(--space-1) var(--space-3);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); cursor: pointer;
}
.is-picker__option--active { background: var(--color-bg-hover); }
.is-picker__name { font-weight: 550; }
.is-picker__summary {
  grid-column: 1; color: var(--color-ink-muted);
  font-family: var(--font-mono); font-size: var(--type-body-sm-size);
}
.is-picker__option .is-status { grid-column: 2; grid-row: 1 / span 2; align-self: center; }
.is-picker__status { padding: var(--space-3); color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }

/* ---- Stage 3 domain components ---- */

/* Available to every surface: state must never be carried by colour alone
   (§ 7), so the visual affordance is paired with text only assistive
   technology reads. */
.is-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.is-amount { display: inline-flex; flex-direction: column; gap: var(--space-1); }
.is-amount__label { color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }
/* Tabular figures so a column of amounts aligns on the decimal point. */
.is-amount__value { font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.is-amount--hero    .is-amount__value { font-size: 40px; font-weight: 600; line-height: 1.1; }
.is-amount--primary .is-amount__value { font-size: 24px; font-weight: 600; }
.is-amount--body    .is-amount__value { font-size: var(--type-body-size); }
.is-amount--compact .is-amount__value { font-size: var(--type-body-sm-size); }
.is-amount--superseded .is-amount__value { text-decoration: line-through; color: var(--color-ink-muted); }
/*
 * § 6, the amount morph: 320ms, and the figure never blanks. The new value is
 * already in the DOM when this class lands — the animation decorates a change
 * that has happened, it does not stage one.
 */
.is-amount__value--morphing {
  animation: is-amount-morph var(--motion-amount-duration) var(--motion-amount-easing);
}
@keyframes is-amount-morph {
  from { opacity: 0.55; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  /* "The amount morph becomes an instant swap. Nothing is left in motion." */
  .is-amount__value--morphing { animation: none; }
}

/*
 * 6, the second permitted animation: the rail fills from saffron to teal as
 * the settlement advances. 320ms, once, on state change -- the class is added
 * by the component only when the current step actually moved.
 */
.is-progress--advancing .is-progress__step--current {
  animation: is-progress-advance var(--motion-amount-duration) var(--motion-amount-easing);
}
@keyframes is-progress-advance {
  from { opacity: 0.4; }
  to { opacity: 1; }
}

/*
 * 6, the third: a single restrained confirmation on the Available to settle
 * figure when it decreases. The only feedback the customer gets for a mechanic
 * they never see, so it is one fade and nothing else.
 */
.is-metric__value--reserved {
  animation: is-availability-change var(--motion-standard-duration) var(--motion-standard-easing);
}
@keyframes is-availability-change {
  from { opacity: 0.5; }
  to { opacity: 1; }
}

/*
 * 6, the seventh: "the status indicator transitions to teal, once, 240ms.
 * That is the entire celebration."
 */
.is-status--confirming .is-status__dot,
.is-status--confirming .is-status__label {
  animation: is-settled-confirm var(--motion-enter-duration) var(--motion-enter-easing);
}
@keyframes is-settled-confirm {
  from { opacity: 0.45; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  /* Nothing is left in motion. */
  .is-progress--advancing .is-progress__step--current,
  .is-metric__value--reserved,
  .is-status--confirming .is-status__dot,
  .is-status--confirming .is-status__label { animation: none; }
}

.is-progress__steps {
  display: flex; gap: var(--space-2); list-style: none; margin: 0; padding: 0;
}
.is-progress__step { flex: 1; padding-top: var(--space-2); border-top: 3px solid var(--color-border); }
.is-progress__step--done    { border-image: var(--accent-gradient) 1; }
.is-progress__step--current { border-top-color: var(--status-settling-fg); }
.is-progress__step--done    .is-progress__label { color: var(--color-ink); }
.is-progress__step--current .is-progress__label { color: var(--status-settling-fg); font-weight: 600; }
.is-progress__step--todo    .is-progress__label { color: var(--color-ink-muted); }
.is-progress__label { font-size: var(--type-body-sm-size); }
.is-progress__detail { margin: var(--space-2) 0 0; color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }
.is-progress--delayed .is-progress__step--current { border-top-color: var(--status-action-required-fg); }

.is-quote {
  position: sticky; top: var(--space-5); align-self: start;
  padding: var(--space-5); border-radius: var(--radius-md);
  border: 1px solid var(--color-border); background: var(--color-bg-surface);
}
.is-quote__provisional {
  margin: 0 0 var(--space-4); padding: var(--space-3);
  border-radius: var(--radius-sm); background: var(--status-settling-bg);
  color: var(--status-settling-fg); font-size: var(--type-body-sm-size);
}
.is-quote__lines { margin: var(--space-4) 0 0; display: grid; gap: var(--space-2); }
.is-quote__lines > div { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-4); }
.is-quote__lines dt { color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }
.is-quote__lines dd { margin: 0; }
.is-quote__rate { font-family: var(--font-mono); font-size: var(--type-body-sm-size); }
.is-quote__expiry { margin: var(--space-4) 0 0; color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }
.is-quote--error { border-color: var(--status-action-required-fg); }

.is-ref { display: inline-flex; align-items: center; gap: var(--space-2); }
.is-ref__label { color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }
.is-ref__value { font-family: var(--font-mono); font-size: var(--type-body-sm-size); }
/* Hidden until hover *or* focus — a keyboard user must be able to copy it. */
.is-ref__copy {
  appearance: none; background: none; border: 0; padding: 0 var(--space-1);
  font: inherit; font-size: var(--type-body-sm-size); color: var(--color-ink-muted);
  cursor: pointer; opacity: 0;
}
.is-ref:hover .is-ref__copy,
.is-ref__copy:focus-visible { opacity: 1; }
@media (hover: none) { .is-ref__copy { opacity: 1; } }

/* --------------------------------------------------------------- tables -- */
/*
 * The \`is-table\` classes have been used by the app surfaces since Stage 8 and
 * were never defined here, so every table in the product has been rendering as
 * unstyled browser default. Stage 10 is the pass that notices.
 */
.is-table {
  width: 100%; border-collapse: collapse;
  font-size: var(--type-body-size);
}
.is-table th {
  text-align: left; padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border-strong);
  color: var(--color-ink-muted);
  font-size: var(--type-label-size); font-weight: var(--type-label-weight);
  letter-spacing: var(--type-label-tracking); text-transform: uppercase;
  white-space: nowrap;
}
.is-table td {
  padding: var(--space-3); border-bottom: 1px solid var(--color-border);
  vertical-align: baseline;
}
.is-table__row:hover td { background: var(--color-bg-hover); }
.is-table__mono { font-family: var(--font-mono); font-size: var(--type-mono-sm-size); }
.is-table__num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; }
.is-table__link {
  appearance: none; background: none; border: 0; padding: 0;
  font: inherit; color: var(--color-accent-teal-deep);
  text-align: left; cursor: pointer; text-decoration: underline;
  text-underline-offset: 2px;
}

/* ----------------------------------------------------------- MetricTile -- */
.is-metric {
  display: flex; flex-direction: column; gap: var(--space-1);
  padding: var(--space-5); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); background: var(--color-bg-surface);
}
.is-metric__label {
  margin: 0; color: var(--color-ink-muted);
  font-size: var(--type-label-size); font-weight: var(--type-label-weight);
  letter-spacing: var(--type-label-tracking); text-transform: uppercase;
}
.is-metric__value { margin: var(--space-1) 0 0; font-size: var(--type-display-m-size); }
/* An absent figure reads as muted, so it is never mistaken for a number. */
.is-metric__value--absent {
  color: var(--color-ink-disabled);
  font-size: var(--type-display-m-size); line-height: var(--type-display-m-line);
}
.is-metric__error { margin: var(--space-1) 0 0; color: var(--status-action-required-fg); font-size: var(--type-body-sm-size); }
.is-metric__context { margin: 0; color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }
.is-metric__action {
  appearance: none; background: none; border: 0; padding: 0;
  margin-top: var(--space-2); align-self: flex-start;
  font: inherit; font-weight: 550; color: var(--color-accent-teal-deep);
  cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}

/* ------------------------------------------------------------- EventRow -- */
/*
 * § 6, the one animation permitted here: "new rows slide 4px and fade in over
 * 180ms. No bounce." Not 5px, not with a scale, and not on every row — only on
 * a row the caller marked as having arrived after first paint.
 */
.is-event--entering {
  animation: is-event-enter var(--motion-standard-duration) var(--motion-standard-easing);
}
@keyframes is-event-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  /* Opacity only. The row still announces itself; it just does not move. */
  @keyframes is-event-enter { from { opacity: 0; } to { opacity: 1; } }
}
${screensCss}`

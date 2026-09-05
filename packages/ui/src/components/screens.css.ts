/**
 * Layout for the composed screens.
 *
 * `primitives.css.ts` styles the catalogue in `DESIGN_SYSTEM.md § 5`. Nothing
 * styled the screens those primitives are arranged into: `is-page__header`,
 * `is-form`, `is-facts`, `is-settlement`, `is-endpoint`, `is-destination` and
 * two dozen more were written into `apps/app` and `apps/ops` from Stage 2
 * onward and never had a rule anywhere. An unknown class is not an error in
 * CSS — it simply does nothing — so every screen in the product has been
 * rendering as a stack of styled controls in an unstyled page, and nothing
 * failed.
 *
 * This is the sense in which Stage 10's first exit criterion is a real gate
 * rather than a formality. *"WCAG 2.2 AA verified on composed screens, not only
 * tokens"* — a token pair can pass contrast in isolation on a page that has no
 * layout at all, which is precisely what was happening.
 *
 * `undefinedClassNames` in `to-css.ts` is the assertion that keeps it closed.
 *
 * Breakpoints are `DESIGN_SYSTEM.md § 8`, desktop-first because this is an
 * operations tool.
 */
export const screensCss = `
/* ------------------------------------------------------------- page ----- */
.is-page__header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: var(--space-5); margin-bottom: var(--space-7);
}
.is-page__header h1 {
  margin: 0;
  font-size: var(--type-h1-size); line-height: var(--type-h1-line);
  font-weight: var(--type-h1-weight); letter-spacing: var(--type-h1-tracking);
}
.is-page__subheader {
  display: flex; align-items: baseline; gap: var(--space-4);
  margin-bottom: var(--space-5); color: var(--color-ink-muted);
}
.is-section__title {
  margin: var(--space-8) 0 var(--space-4);
  font-size: var(--type-h2-size); line-height: var(--type-h2-line);
  font-weight: var(--type-h2-weight); letter-spacing: var(--type-h2-tracking);
}
.is-muted { color: var(--color-ink-muted); }

/* --------------------------------------------------------- overview ----- */
.is-overview { display: block; }
.is-overview__metrics {
  display: grid; gap: var(--space-5);
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

/* ---------------------------------------------------------- forms ------- */
.is-form { display: grid; gap: var(--space-5); max-width: 56ch; }
.is-fieldset {
  display: grid; gap: var(--space-4); margin: 0; padding: 0; border: 0;
}
.is-form__actions {
  display: flex; align-items: center; gap: var(--space-4);
  margin-top: var(--space-4);
}

/* Definition lists carrying the facts on a detail screen. */
.is-facts {
  display: grid; gap: var(--space-4) var(--space-6);
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: var(--space-6) 0;
}
.is-facts > div { display: grid; gap: var(--space-1); }
.is-facts dt {
  color: var(--color-ink-muted);
  font-size: var(--type-label-size); font-weight: var(--type-label-weight);
  letter-spacing: var(--type-label-tracking); text-transform: uppercase;
}
.is-facts dd { margin: 0; }

/* A short aside. Never red unless something is actually wrong. */
.is-callout {
  padding: var(--space-4); border-radius: var(--radius-md);
  background: var(--color-bg-sunken); color: var(--color-ink-secondary);
  font-size: var(--type-body-sm-size);
}

/* ------------------------------------------------------ settlement ------ */
.is-settlement { display: block; }
.is-new-settlement {
  display: grid; gap: var(--space-8);
  /* The quote summary is the second column and stays visible (§ 12.2). */
  grid-template-columns: minmax(0, 1fr) 340px;
  align-items: start;
}
/*
 * § 12.3: Cancel sits above the fold while the settlement is cancellable and is
 * "never collapsed into the technical detail". So it is a sibling of the facts,
 * not a child of the disclosure.
 */
.is-settlement__cancel {
  display: grid; gap: var(--space-3); justify-items: start;
  padding: var(--space-5); margin: var(--space-6) 0;
  border: 1px solid var(--color-border); border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
}
.is-settlement__technical { margin-top: var(--space-8); }
/*
 * The return notice. First on the page and impossible to miss (§ 12.3), while
 * the settlement's own badge beside it still reads SETTLED -- both facts are
 * true, and STATE_MACHINES.md 8.5 takes that tension knowingly.
 */
.is-return {
  display: grid; gap: var(--space-2);
  padding: var(--space-5); margin-bottom: var(--space-6);
  border-radius: var(--radius-lg);
  border-left: 4px solid var(--status-action-required-fg);
  background: var(--status-action-required-bg);
}
.is-return--resolved {
  border-left-color: var(--color-ink-secondary);
  background: var(--color-bg-sunken);
}
.is-return__header {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-4);
}
.is-return__label {
  margin: 0;
  font-size: var(--type-h3-size); line-height: var(--type-h3-line);
  font-weight: var(--type-h3-weight);
}
.is-return__detail { margin: 0; max-width: 60ch; }

/*
 * The plain-language timeline. Label, time, and at most one extra fact --
 * a UTR, or the two reconciliation figures. Aligned in three columns so the
 * times line up down the page and the eye can scan them.
 */
.is-timeline { list-style: none; margin: var(--space-4) 0; padding: 0; display: grid; gap: var(--space-2); }
.is-timeline__row {
  display: grid; align-items: baseline; gap: var(--space-4);
  grid-template-columns: minmax(180px, max-content) max-content 1fr;
}
.is-timeline__label { color: var(--color-ink); }
.is-timeline__at {
  font-family: var(--font-mono); font-size: var(--type-mono-sm-size);
  font-variant-numeric: tabular-nums; color: var(--color-ink-secondary);
}
.is-timeline__detail { color: var(--color-ink-muted); font-size: var(--type-body-sm-size); }
.is-facts__note { margin-top: var(--space-1); font-size: var(--type-body-sm-size); max-width: 52ch; }
.is-settlement__technical > summary {
  cursor: pointer; color: var(--color-ink-secondary);
  font-size: var(--type-body-sm-size);
}

/* ----------------------------------------------------- beneficiaries ---- */
.is-destination {
  padding: var(--space-5); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); background: var(--color-bg-surface);
}
.is-destination__header {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-4);
}
.is-destination__summary { font-family: var(--font-mono); font-size: var(--type-mono-size); }
.is-destination__actions { display: flex; gap: var(--space-3); margin-top: var(--space-4); }
.is-destination__history { margin-top: var(--space-5); }
.is-preflight__advisory {
  margin-top: var(--space-4); padding: var(--space-4);
  border-left: 3px solid var(--color-accent-saffron); border-radius: var(--radius-sm);
  background: var(--status-settling-bg); color: var(--status-settling-fg);
  font-size: var(--type-body-sm-size);
}

/* -------------------------------------------------------- developers ---- */
.is-developers__environment {
  display: inline-flex; align-items: center; gap: var(--space-2);
  padding: var(--space-1) var(--space-3); border-radius: var(--radius-pill);
  background: var(--status-settling-bg); color: var(--status-settling-fg);
  font-size: var(--type-label-size); font-weight: var(--type-label-weight);
  letter-spacing: var(--type-label-tracking); text-transform: uppercase;
}
.is-endpoint, .is-delivery {
  padding: var(--space-5); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); background: var(--color-bg-surface);
  margin-bottom: var(--space-4);
}
.is-endpoint__header, .is-delivery__header {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-4);
}
.is-endpoint__actions { display: flex; gap: var(--space-3); margin-top: var(--space-4); }
.is-delivery__attempts { margin-top: var(--space-4); }
.is-checklist { display: grid; gap: var(--space-3); margin: var(--space-4) 0; padding-left: var(--space-5); }
.is-example {
  padding: var(--space-4); border-radius: var(--radius-md);
  background: var(--color-ink); color: var(--color-ink-inverse);
  font-family: var(--font-mono); font-size: var(--type-mono-sm-size);
  overflow-x: auto;
}

/* --------------------------------------------------------------- ops ---- */
.is-facility {
  padding: var(--space-5); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); background: var(--color-bg-surface);
  margin-bottom: var(--space-4);
}
.is-facility__header {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-4);
}
.is-ops__actions { display: flex; gap: var(--space-3); margin-top: var(--space-4); }

/*
 * The 8 monitoring experience. Not an error and not an apology: a statement
 * about this device, sized like ordinary content.
 */
.is-desktop-task {
  display: grid; gap: var(--space-3);
  padding: var(--space-7); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); background: var(--color-bg-surface);
}
.is-desktop-task__title {
  margin: 0;
  font-size: var(--type-h2-size); line-height: var(--type-h2-line);
  font-weight: var(--type-h2-weight);
}
.is-desktop-task__detail { margin: 0; max-width: 56ch; color: var(--color-ink-secondary); }

/* ------------------------------------------------------- responsive ----- */
/* § 8. Desktop-first: the rules below narrow, they never build up. */

@media (max-width: 1279px) {
  /* Tables drop low-priority columns; the metric grid halves rather than
     squeezing four figures into a width that would wrap each of them. */
  .is-overview__metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .is-new-settlement { grid-template-columns: minmax(0, 1fr) 300px; }
}

@media (max-width: 1023px) {
  /* The timeline stacks rather than compressing three columns into nothing. */
  .is-timeline__row { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }

  /* Single column. The quote summary stops being a column and becomes a
     sticky footer — it must stay visible (§ 12.2), not scroll away. */
  .is-new-settlement { grid-template-columns: minmax(0, 1fr); }
  .is-facts { grid-template-columns: minmax(0, 1fr); }
  .is-page__header { flex-direction: column; align-items: stretch; }
}

@media (max-width: 767px) {
  /* The monitoring experience (§ 8). One column, and a table becomes stacked
     rows keyed by amount and beneficiary rather than a horizontally scrolling
     grid nobody can read on a phone. */
  .is-overview__metrics { grid-template-columns: minmax(0, 1fr); }
  .is-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .is-table, .is-table tbody, .is-table__row, .is-table td { display: block; width: 100%; }
  .is-table__row {
    padding: var(--space-4) 0; border-bottom: 1px solid var(--color-border);
  }
  .is-table td { border: 0; padding: var(--space-1) 0; }
  .is-table__num { text-align: left; }
}
`

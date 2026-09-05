/**
 * WCAG 2.2 AA on **composed screens** — the first Stage 10 exit criterion.
 *
 * The words in `IMPLEMENTATION_PLAN.md` are *"verified on composed screens, not
 * only tokens"*, and the distinction turned out to be the whole point. The token
 * suite has passed since Stage 1 while asserting contrast between hex pairs —
 * and every one of those pairs was correct. What was broken was everything
 * between the pair and the pixel: `--status-action-required-fg` was read by ten
 * rules and emitted under a different name, `--accent-gradient` was never
 * emitted at all, and no stylesheet defined a single one of the layout classes
 * the screens are built from. A contrast test on a colour constant cannot see
 * any of that. A screen can.
 *
 * So this file renders the real screens with the real stylesheet attached and
 * runs axe over the result. Not every axe rule maps to WCAG 2.2 AA, so the run
 * is scoped to the tags that do.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import axe from 'axe-core'
import { primitivesCss } from '@inrsettle/ui'

import { Overview } from '../overview/surfaces.js'
import { BUSY_VIEW, ONBOARDING_VIEW } from '../overview/fixtures.js'
import { NewSettlement, SettlementDetail } from '../settlements/surfaces.js'
import {
  ACTION_REQUIRED, BENEFICIARIES, DETAIL_BASE, FUNDING_CURRENCIES, PURPOSES, QUOTE,
  RETURN_CONFIRMED, SANDBOX_PRICING_NOTICE, SETTLED_DESIGN_ONLY, SETTLING, TIMELINE,
} from '../settlements/fixtures.js'
import { DevelopersPage } from '../developers/surfaces.js'
import {
  API_KEYS, ENDPOINTS, EVENTS, EVENT_TYPES, EXAMPLES, REFERENCE_ENDPOINTS, REQUESTS,
} from '../developers/fixtures.js'
import { BeneficiaryList } from '../beneficiaries/surfaces.js'
import { ROWS as BENEFICIARY_ROWS } from '../beneficiaries/fixtures.js'

afterEach(cleanup)

const noop = (): void => {}

/**
 * WCAG 2.2 AA, and only that.
 *
 * `best-practice` rules are opinions worth having but are not the criterion,
 * and mixing them in would make a failure ambiguous about whether the product
 * is non-conformant or merely unfashionable.
 */
const AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/**
 * Render a screen with the product's own stylesheet attached, then run axe.
 *
 * The stylesheet is the part that matters. axe computes contrast from resolved
 * styles, so a screen rendered without CSS reports the browser defaults —
 * black on white, which passes everything and proves nothing.
 */
async function auditScreen(ui: React.ReactElement): Promise<axe.Result[]> {
  const style = document.createElement('style')
  style.textContent = primitivesCss
  document.head.append(style)

  const { container } = render(ui)
  // jsdom implements enough CSSOM for structure, name and role rules; it does
  // not lay out or paint, so axe's own colour-contrast rule cannot run here and
  // reports "incomplete" rather than a pass. That check is the token suite's
  // job (`tokens.test.ts` asserts every status pair at 4.5:1) plus the
  // Storybook a11y addon, which runs in a real browser. What this run covers is
  // the half a real browser is worst at catching by eye: names, roles,
  // relationships, heading order, labels and focusability across a whole screen.
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: AA_TAGS },
    resultTypes: ['violations'],
  })

  style.remove()
  return results.violations
}

function report(violations: axe.Result[]): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.html).join('\n    ')}`)
    .join('\n  ')
}

const developersProps = (): React.ComponentProps<typeof DevelopersPage> => ({
  environment: 'sandbox',
  onEnvironmentChange: noop,
  createdSecret: null,
  onDismissSecret: noop,
  keys: { rows: API_KEYS, onCreate: noop, onRevoke: noop },
  endpoints: {
    cards: ENDPOINTS,
    eventTypes: EVENT_TYPES,
    onCreate: noop,
    onSendTest: noop,
    onRotateSecret: noop,
    onReenable: noop,
    onRemove: noop,
  },
  requests: { rows: REQUESTS, filter: 'all', onFilterChange: noop },
  events: { rows: EVENTS, deliveries: [], expandedEventId: null, onExpand: noop, onReplay: noop },
  reference: {
    endpoints: REFERENCE_ENDPOINTS,
    examples: EXAMPLES,
    baseUrl: 'https://api.inrsettle.com',
    apiVersion: '2026-08-31',
  },
})

const SCREENS: readonly [string, () => React.ReactElement][] = [
  [
    'Overview — a working day',
    () => (
      <Overview
        presentation={BUSY_VIEW}
        onOpenSettlement={noop}
        onNewSettlement={noop}
        onNavigate={noop}
      />
    ),
  ],
  [
    'Overview — day one, nothing set up yet',
    () => (
      <Overview presentation={ONBOARDING_VIEW} onOpenSettlement={noop} onNewSettlement={noop} />
    ),
  ],
  [
    'Overview — loading',
    () => (
      <Overview presentation={BUSY_VIEW} onOpenSettlement={noop} onNewSettlement={noop} loading />
    ),
  ],
  [
    'New settlement — priced',
    () => (
      <NewSettlement
        values={{
          beneficiaryId: 'ben_aarti',
          recipientMinorUnits: 500_000_000n,
          purposeCode: 'SOFTWARE_SERVICES',
          fundingCurrency: 'USDT',
          reference: '',
          documents: [],
        }}
        onChange={noop}
        beneficiaries={BENEFICIARIES}
        beneficiaryQuery=""
        onBeneficiaryQueryChange={noop}
        purposes={PURPOSES}
        fundingCurrencies={FUNDING_CURRENCIES}
        quote={QUOTE}
        provisionalNotice={SANDBOX_PRICING_NOTICE}
        documentsRequired
        onSubmit={noop}
      />
    ),
  ],
  [
    'New settlement — re-pricing',
    () => (
      <NewSettlement
        values={{
          beneficiaryId: 'ben_aarti',
          recipientMinorUnits: 500_000_000n,
          purposeCode: 'SOFTWARE_SERVICES',
          fundingCurrency: 'USDT',
          reference: 'INV-2026-114',
          documents: [],
        }}
        onChange={noop}
        beneficiaries={BENEFICIARIES}
        beneficiaryQuery=""
        onBeneficiaryQueryChange={noop}
        purposes={PURPOSES}
        fundingCurrencies={FUNDING_CURRENCIES}
        quote={QUOTE}
        quoteRepricing
        onSubmit={noop}
      />
    ),
  ],
  [
    'Settlement detail — settled, with timeline',
    () => (
      <SettlementDetail
        {...DETAIL_BASE}
        presentation={SETTLED_DESIGN_ONLY}
        internalStatus="SETTLED"
        authorizedAt={new Date('2026-09-02T08:32:00Z')}
        timeline={TIMELINE}
      />
    ),
  ],
  [
    'Settlement detail — settled, then returned',
    () => (
      <SettlementDetail
        {...DETAIL_BASE}
        presentation={SETTLED_DESIGN_ONLY}
        internalStatus="SETTLED"
        authorizedAt={new Date('2026-09-02T08:32:00Z')}
        timeline={TIMELINE}
        returnNotice={RETURN_CONFIRMED}
      />
    ),
  ],
  [
    'Settlement detail — action required',
    () => (
      <SettlementDetail
        {...DETAIL_BASE}
        presentation={ACTION_REQUIRED}
        internalStatus="EXCEPTION"
        onRequirementAction={noop}
      />
    ),
  ],
  [
    'Settlement detail — settling, cancellable',
    () => (
      <SettlementDetail
        {...DETAIL_BASE}
        presentation={SETTLING}
        internalStatus="LIQUIDITY_RESERVED"
        onCancel={noop}
      />
    ),
  ],
  [
    'Settlement detail — loading',
    () => (
      <SettlementDetail
        {...DETAIL_BASE}
        presentation={SETTLED_DESIGN_ONLY}
        internalStatus="SETTLED"
        loading
      />
    ),
  ],
]

/**
 * The Stage 2 and Stage 8 screens, audited by the same run.
 *
 * Stage 10 is the pass that verifies the *product*, not only the screens Stage
 * 10 built. Every one of these predates the fixes above — the loading skeletons
 * across all of them carried `aria-label` on a bare `div`, which is a WCAG
 * 4.1.2 failure that no stage caught because no stage looked at a whole screen.
 */
const EARLIER_SCREENS: readonly [string, () => React.ReactElement][] = [
  [
    'Developers — API keys',
    () => <DevelopersPage {...developersProps()} />,
  ],
  [
    'Developers — on a phone, where keys are a desktop task',
    () => <DevelopersPage {...developersProps()} viewportWidth={390} />,
  ],
  [
    'Beneficiaries — list',
    () => (
      <BeneficiaryList
        rows={BENEFICIARY_ROWS}
        onOpen={noop}
        onCreate={noop}
        query=""
        onQueryChange={noop}
      />
    ),
  ],
]

describe('WCAG 2.2 AA — composed screens', () => {
  it.each(SCREENS)('%s has no violations', async (_name, screen) => {
    const violations = await auditScreen(screen())
    expect(violations, `\n  ${report(violations)}`).toEqual([])
  })
})

describe('WCAG 2.2 AA — the screens earlier stages built', () => {
  it.each(EARLIER_SCREENS)('%s has no violations', async (_name, screen) => {
    const violations = await auditScreen(screen())
    expect(violations, `\n  ${report(violations)}`).toEqual([])
  })
})

describe('the audit itself', () => {
  it('would fail a screen that is genuinely inaccessible', async () => {
    // A gate that has never rejected anything is indistinguishable from one
    // that cannot. An image with no alternative text and an input with no
    // label are both plain AA failures.
    const violations = await auditScreen(
      <div>
        <img src="chart.png" />
        <input type="text" />
      </div>,
    )
    const ids = violations.map((v) => v.id)
    expect(ids).toContain('image-alt')
    expect(ids.length).toBeGreaterThan(0)
  })

  it('runs against the product stylesheet, not bare markup', async () => {
    // The screens above are audited with `primitivesCss` attached. Without it
    // the run would be measuring browser defaults, which is how a suite passes
    // while the real product renders unstyled.
    expect(primitivesCss).toContain('.is-page__header')
    expect(primitivesCss).toContain('--status-action-required-fg')
  })
})

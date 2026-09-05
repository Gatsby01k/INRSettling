/**
 * Stage 1 exit criterion: Storybook publishes every primitive with all five
 * states from DESIGN_SYSTEM.md § 10.
 *
 * The weak version of this test would read the source and count `export const`
 * lines. This reads the **built Storybook index**, so it can only pass if the
 * stories actually compiled and were published. If the build is stale or
 * missing, the test says so rather than quietly passing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCUMENTED_EXTRAS, PRIMITIVES } from './registry.js'
import { UI_STATES } from './state-coverage.js'

const INDEX = join(process.cwd(), 'storybook-static', 'index.json')
const DESIGN_SYSTEM = join(process.cwd(), 'docs', 'DESIGN_SYSTEM.md')

/**
 * The catalogue is read out of the frozen document, not copied into this file.
 *
 * A hand-copied list is a list that drifts: ten primitives were missing from the
 * registry while this suite reported full coverage, because the registry defined
 * the universe it checked. Parsing § 5 makes the document the authority.
 */
function frozenCatalogue(): string[] {
  const doc = readFileSync(DESIGN_SYSTEM, 'utf8')
  const marker = '**Primitives.**'
  const start = doc.indexOf(marker)
  if (start === -1) throw new Error('DESIGN_SYSTEM.md § 5 has no **Primitives.** sentence')
  const paragraph = doc.slice(start + marker.length).split('\n\n')[0]!
  return paragraph
    .replace(/\([^)]*\)/g, '')   // drop "(primary, secondary, …)"
    .split('·')
    .map((s) => s.replace(/\s+/g, ' ').trim().replace(/\.$/, ''))
    .filter((s) => /^[A-Z][A-Za-z]+$/.test(s))
}

interface StoryIndex {
  entries: Record<string, { title: string; name: string; type: string }>
}

function builtIndex(): StoryIndex {
  expect(
    existsSync(INDEX),
    'storybook-static/index.json is missing — run `pnpm build-storybook` (it is part of `pnpm ci`)',
  ).toBe(true)
  return JSON.parse(readFileSync(INDEX, 'utf8')) as StoryIndex
}

describe('DESIGN_SYSTEM.md § 10 — five states, every primitive', () => {
  const names = Object.keys(PRIMITIVES)

  it('reads the catalogue out of the frozen document', () => {
    const catalogue = frozenCatalogue()
    expect(catalogue.length).toBeGreaterThanOrEqual(20)
    expect(catalogue).toContain('Button')
    expect(catalogue).toContain('Divider')
  })

  it('implements every primitive the frozen catalogue names', () => {
    const missing = frozenCatalogue().filter((name) => !(name in PRIMITIVES))
    expect(
      missing,
      `DESIGN_SYSTEM.md § 5 names primitives that are not implemented:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('justifies anything implemented beyond the catalogue', () => {
    const catalogue = new Set(frozenCatalogue())
    const extras = names.filter((n) => !catalogue.has(n))
    for (const extra of extras) {
      expect(
        DOCUMENTED_EXTRAS[extra],
        `${extra} is implemented but not in § 5 and has no recorded reason`,
      ).toBeTruthy()
    }
  })

  it('declares all five states for every primitive', () => {
    for (const [name, coverage] of Object.entries(PRIMITIVES)) {
      expect(Object.keys(coverage).sort(), name).toEqual([...UI_STATES].sort())
    }
  })

  it('gives a real reason wherever a state is declared not applicable', () => {
    for (const [name, coverage] of Object.entries(PRIMITIVES)) {
      for (const [state, value] of Object.entries(coverage)) {
        if (value === true) continue
        expect(typeof value, `${name}.${state}`).toBe('string')
        // A reason, not a shrug.
        expect((value as string).length, `${name}.${state} reason too short`).toBeGreaterThan(24)
        expect(value as string, `${name}.${state}`).not.toMatch(/^(n\/a|na|none|todo)\.?$/i)
      }
    }
  })

  it('publishes a story for every primitive × state in the built Storybook', () => {
    const { entries } = builtIndex()
    const published = new Set(
      Object.values(entries)
        .filter((e) => e.type === 'story')
        .map((e) => `${e.title}::${e.name}`),
    )

    const missing: string[] = []
    for (const name of names) {
      for (const state of UI_STATES) {
        const storyName = state[0]!.toUpperCase() + state.slice(1)
        const key = `Primitives/${name}::${storyName}`
        if (!published.has(key)) missing.push(key)
      }
    }
    expect(missing, `missing published stories:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('publishes at least one story per registered primitive and no orphan titles', () => {
    const { entries } = builtIndex()
    const titles = new Set(
      Object.values(entries).filter((e) => e.type === 'story').map((e) => e.title),
    )
    for (const name of names) {
      expect(titles.has(`Primitives/${name}`), `no stories published for ${name}`).toBe(true)
    }
    const orphans = [...titles].filter(
      (t) => t.startsWith('Primitives/') && !names.includes(t.slice('Primitives/'.length)),
    )
    expect(orphans, 'stories exist for components missing from the PRIMITIVES registry').toEqual([])
  })
})

describe('Stage scope — no Stage 2+ domain components', () => {
  /**
   * The domain components DESIGN_SYSTEM.md lists separately from the primitives.
   * Each belongs to the stage that introduces the aggregate it describes;
   * building one now to fill a Storybook would be implementing a later stage
   * early. `AmountInput` is deliberately absent from this list — the frozen § 5
   * catalogue names it as a primitive, and it knows about currencies, not
   * settlements.
   */
  /**
   * Domain components still deferred to a later stage.
   *
   * Narrowed for Stage 2: `StatusIndicator`, `RequirementCard` and
   * `BeneficiaryPicker` are now in scope and implemented. Everything left here
   * renders a concept — a quote, a settlement's progress, a receipt, an event
   * log, an overview metric — that Stage 2 does not have, and building one to
   * populate a Storybook would be implementing a later stage early.
   */
  /**
   * Narrowed again for Stage 3. What is left renders something Stage 3 does not
   * have: a developer event log, a receipt (Stage 6 finality), and an overview
   * metric. Building one now to fill a Storybook would be implementing a later
   * stage early.
   */
  /**
   * Narrowed a final time for Stage 10, which is the pass `DESIGN_SYSTEM.md
   * § 12` describes: a component that exists in an app but not in `packages/ui`
   * is *"a bug to be closed, not a shortcut to be kept"*. `EventRow` was that
   * bug — the Developers log has been building its own rows in `apps/app` since
   * Stage 8 — and `MetricTile` is what Overview is made of.
   *
   * `ReceiptDocument` stays deferred, and the reason is not scheduling: `INV-29`
   * requires one template to serve both the screen and the PDF, so the component
   * cannot be written correctly until the PDF renderer it must share exists.
   * Writing the screen half now would produce a second template to reconcile
   * later, which is the failure `INV-29` exists to prevent.
   */
  const STAGE_11_PLUS = ['ReceiptDocument']

  it('registers none of the deferred domain components', () => {
    const built = STAGE_11_PLUS.filter((n) => n in PRIMITIVES)
    expect(built, 'later-stage domain components implemented early').toEqual([])
  })

  it('the domain components it does register are the ones in scope so far', () => {
    for (const name of [
      'StatusIndicator', 'RequirementCard', 'BeneficiaryPicker',
      'AmountDisplay', 'SettlementProgress', 'QuoteSummary', 'Reference',
      'EventRow', 'MetricTile',
    ]) {
      expect(name in PRIMITIVES, `${name} is in scope and must be implemented`).toBe(true)
      expect(DOCUMENTED_EXTRAS[name], `${name} needs a recorded reason`).toBeTruthy()
    }
  })

  it('flags a domain-shaped name that the frozen catalogue does not sanction', () => {
    const catalogue = new Set(frozenCatalogue())
    const domainWords = /settlement|quote|beneficiary|liquidity|payout|receipt|batch/i
    const suspicious = Object.keys(PRIMITIVES)
      .filter((n) => !catalogue.has(n))
      // A domain-shaped name is fine only if it is in the frozen § 5 component
      // table and carries a recorded reason.
      .filter((n) => !(n in DOCUMENTED_EXTRAS))
      .filter((n) => domainWords.test(n))
    expect(suspicious, 'domain-shaped components outside the frozen catalogue').toEqual([])
  })

  it('keeps the primitives free of imports from the domain or app layers', () => {
    const dir = join(process.cwd(), 'packages/ui/src/components')
    for (const file of [
      'index.tsx', 'inputs.tsx', 'overlays.tsx', 'beneficiary.tsx', 'settlement.tsx',
      'overview.tsx',
    ]) {
      const src = readFileSync(join(dir, file), 'utf8')
      expect(src, `${file} imports a non-presentational package`)
        .not.toMatch(/from\s+['"]@inrsettle\/(domain|app-services|db)['"]/)
    }
  })
})

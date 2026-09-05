/**
 * *"Loading, empty, error and disabled states exist everywhere and are
 * reviewed"* — Stage 10's fourth exit criterion.
 *
 * The weak version reads `screens.ts` and confirms it has five keys, which
 * proves that somebody typed five keys. This reads the **built Storybook index**
 * and requires the named story to have actually compiled and published, the same
 * way `packages/ui/src/components/primitives.test.ts` does for the catalogue.
 * If the build is stale the test says so rather than passing quietly.
 *
 * "And are reviewed" is the second half, and a test cannot do it — a person has
 * to look. What a test can do is make sure there is something to look at, and
 * that every declared exemption is an argument rather than a shrug.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCREENS, SCREEN_STATES } from '../screens.js'

const INDEX = join(process.cwd(), 'storybook-static', 'index.json')

interface StoryIndex {
  entries: Record<string, { title: string; name: string; type: string }>
}

function builtIndex(): StoryIndex {
  expect(
    existsSync(INDEX),
    'storybook-static/index.json is missing — run `pnpm build-storybook` (it is part of `pnpm verify`)',
  ).toBe(true)
  return JSON.parse(readFileSync(INDEX, 'utf8')) as StoryIndex
}

describe('every composed screen declares all five states', () => {
  it('covers the screens the product actually has', () => {
    // Not a number to bump when someone adds a screen: the assertion below —
    // that every published `Surfaces/` title is declared here — is what makes
    // this list complete. This one just refuses to pass on an empty registry.
    expect(Object.keys(SCREENS).length).toBeGreaterThanOrEqual(5)
  })

  it('declares exactly the five, for every screen', () => {
    for (const [title, coverage] of Object.entries(SCREENS)) {
      expect(Object.keys(coverage).sort(), title).toEqual([...SCREEN_STATES].sort())
    }
  })

  it('gives a real argument wherever a state is declared not applicable', () => {
    for (const [title, coverage] of Object.entries(SCREENS)) {
      for (const [state, value] of Object.entries(coverage)) {
        if (typeof value !== 'string') continue
        expect(value.length, `${title}.${state} — a reason, not a shrug`).toBeGreaterThan(40)
        expect(value, `${title}.${state}`).not.toMatch(/^(n\/a|na|none|todo|later)\.?$/i)
      }
    }
  })
})

describe('every state that claims a story has one, published', () => {
  it('finds each named story in the built Storybook', () => {
    const { entries } = builtIndex()
    const published = new Set(
      Object.values(entries)
        .filter((e) => e.type === 'story')
        .map((e) => `${e.title}::${e.name}`),
    )

    const missing: string[] = []
    for (const [title, coverage] of Object.entries(SCREENS)) {
      for (const [state, value] of Object.entries(coverage)) {
        if (typeof value === 'string') continue
        const key = `${title}::${value.story}`
        if (!published.has(key)) missing.push(`${state} → ${key}`)
      }
    }
    expect(missing, `declared stories that were never published:\n  ${missing.join('\n  ')}`)
      .toEqual([])
  })

  it('leaves no published screen undeclared', () => {
    // The half that keeps the registry honest as the product grows. A new
    // screen with its own Storybook title has to decide its five states before
    // it can ship, which is exactly what the criterion asks for.
    const { entries } = builtIndex()
    const titles = new Set(
      Object.values(entries).filter((e) => e.type === 'story').map((e) => e.title),
    )
    const undeclared = [...titles]
      .filter((t) => t.startsWith('Surfaces/'))
      .filter((t) => !(t in SCREENS))
    expect(
      undeclared,
      `screens published with no state declaration in screens.ts:\n  ${undeclared.join('\n  ')}`,
    ).toEqual([])
  })

  it('declares no screen that has no stories at all', () => {
    const { entries } = builtIndex()
    const titles = new Set(
      Object.values(entries).filter((e) => e.type === 'story').map((e) => e.title),
    )
    const phantom = Object.keys(SCREENS).filter((t) => !titles.has(t))
    expect(phantom, `declared but never published:\n  ${phantom.join('\n  ')}`).toEqual([])
  })
})

describe('the screen-level states are not the component-level ones', () => {
  it('gives Settlement detail its own Storybook title', () => {
    // Until Stage 10 the detail stories lived in the New Settlement file and
    // published under that screen's name. Two screens under one title makes
    // "reviewed" impossible: there is no way to look at one screen's five
    // states without the other's mixed in.
    const { entries } = builtIndex()
    const detail = Object.values(entries).filter(
      (e) => e.type === 'story' && e.title === 'Surfaces/Settlement detail',
    )
    expect(detail.length).toBeGreaterThan(4)

    const newSettlement = Object.values(entries).filter(
      (e) => e.type === 'story' && e.title === 'Surfaces/New settlement',
    )
    expect(newSettlement.some((e) => e.name.startsWith('Detail'))).toBe(false)
  })
})

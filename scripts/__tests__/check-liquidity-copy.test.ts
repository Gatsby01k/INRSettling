/**
 * The vocabulary gate, proved to actually fail.
 *
 * A build gate that has never rejected anything is indistinguishable from a
 * gate that cannot. These tests give it real violations and real near-misses,
 * because the near-misses are what decide whether anyone leaves it switched on:
 * a check that flags `balanced` in ledger code, or an identifier in a switch,
 * gets disabled within a week and then the real leak ships.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'check-liquidity-copy.mjs')

function runOn(source: string): { ok: boolean; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'liqcopy-'))
  const dir = join(root, 'apps', 'app', 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'surface.tsx'), source)
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('what the gate must reject', () => {
  it('rejects a balance', () => {
    const { ok, out } = runOn(`export const label = 'Your balance'\n`)
    expect(ok).toBe(false)
    expect(out).toMatch(/says "balance"/)
  })

  it('rejects credit and loan, which are claims about a regulated activity', () => {
    for (const word of ['credit', 'loan', 'wallet']) {
      const { ok, out } = runOn(`export const label = 'Your ${word} is ready'\n`)
      expect(ok, word).toBe(false)
      expect(out).toMatch(new RegExp(`says "${word}"`))
    }
  })

  it('rejects "limit remaining", across the space', () => {
    const { ok, out } = runOn(`export const label = 'Limit remaining today'\n`)
    expect(ok).toBe(false)
    expect(out).toMatch(/limit remaining/)
  })

  it('rejects the internal vocabulary the customer never sees', () => {
    for (const word of ['facility', 'drawdown', 'prefunding', 'stablecoin']) {
      const { ok } = runOn(`export const label = 'We used your ${word} today'\n`)
      expect(ok, word).toBe(false)
    }
  })

  it('rejects it in JSX text as well as in a string', () => {
    const { ok, out } = runOn(`export const C = () => <p>Your wallet is empty</p>\n`)
    expect(ok).toBe(false)
    expect(out).toMatch(/says "wallet"/)
  })
})

describe('what the gate must not reject, or it will be switched off', () => {
  it('passes clean copy', () => {
    const { ok, out } = runOn(`export const label = 'Available to settle'\n`)
    expect(ok).toBe(true)
    expect(out).toMatch(/clean/)
  })

  it('does not flag an identifier that happens to contain a banned word', () => {
    // `set_up_liquidity_facility` is an action type on the wire, not a sentence.
    const { ok } = runOn(`export const t = 'set_up_liquidity_facility'\n`)
    expect(ok).toBe(true)
  })

  it('does not flag a comment explaining the rule', () => {
    // The clearest documentation of a ban contains the banned word.
    const { ok } = runOn(`// Not "Set up facility" — a facility is ours, not theirs.\nexport const l = 'Talk to us'\n`)
    expect(ok).toBe(true)
  })

  it('does not flag a JSDoc block that names the words it forbids', () => {
    const { ok } = runOn(
      `/**\n * Never say balance, wallet or credit here.\n */\nexport const l = 'Available to settle'\n`,
    )
    expect(ok).toBe(true)
  })

  it('does not flag words that merely contain a banned word', () => {
    // "balanced" is what the ledger is; "creditor" is a different word. A gate
    // that cannot tell them apart is a gate that annoys people into removing it.
    const { ok } = runOn(`export const l = 'The entries are balanced and the creditor agrees'\n`)
    expect(ok).toBe(true)
  })

  it('honours an explicit same-line opt-out', () => {
    const { ok } = runOn(
      `export const banned = ['facility', 'drawdown'] // liquidity-copy:allow — the prohibition itself\n`,
    )
    expect(ok).toBe(true)
  })

  it('does not look outside the customer-facing tree', () => {
    // The domain and the database say "facility" and "drawdown" constantly,
    // and must: those are the real names of the real things.
    const root = mkdtempSync(join(tmpdir(), 'liqcopy-'))
    const dir = join(root, 'packages', 'domain', 'src')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'facility.ts'), `export const m = 'the facility drawdown balance'\n`)
    const out = execFileSync('node', [SCRIPT, root], { encoding: 'utf8' })
    expect(out).toMatch(/clean/)
  })
})

describe('test and story titles', () => {
  it('does not flag a spec title that describes the behaviour', () => {
    const { ok } = runOn(`it('shows nothing before a facility exists', () => {})\n`)
    expect(ok).toBe(true)
  })

  it('still flags a fixture on the same line as a spec title', () => {
    // Only the title is skipped, not the rest of the line — otherwise a bad
    // fixture could hide behind an `it(` on the same line.
    const { ok, out } = runOn(`it('renders', () => render({ label: 'Your wallet' }))\n`)
    expect(ok).toBe(false)
    expect(out).toMatch(/says "wallet"/)
  })
})

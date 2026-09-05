/**
 * Stage 1 exit criterion: the dependency-boundary lint rule fails a PR that
 * imports React into packages/domain — extended to the whole boundary the
 * frozen architecture sets.
 *
 * `ARCHITECTURE.md § 2` allows the domain database *types* only. This package
 * takes the stricter line and depends on no persistence at all: what it needs
 * from the outside is stated as ports, and implemented in `@inrsettle/app-services`.
 * Both halves are proven here — the lint rule bites, and the shipped source is
 * actually clean.
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const DOMAIN = join(ROOT, 'packages/domain/src')
const PROBE = join(DOMAIN, '__boundary_probe__.ts')

async function lint(source: string): Promise<{ ok: boolean; messages: string }> {
  writeFileSync(PROBE, source)
  const results = await new ESLint({ cwd: ROOT }).lintFiles([PROBE])
  const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2))
  return { ok: errors.length === 0, messages: errors.map((m) => m.message).join('\n') }
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

afterEach(() => rmSync(PROBE, { force: true }))

describe('INV-10 — the lint rule bites', () => {
  const cases: [string, string, RegExp][] = [
    ['React', `import { useState } from 'react'\nexport const x = useState\n`, /must not import React/],
    ['Next.js', `import { cookies } from 'next/headers'\nexport const x = cookies\n`, /must not import Next\.js/],
    ['a provider adapter', `import x from '@inrsettle/providers/mock'\nexport default x\n`, /must not import an adapter/],
    ['the UI package', `import x from '@inrsettle/ui'\nexport default x\n`, /must not import the UI package/],
    ['an ORM', `import { eq } from 'drizzle-orm'\nexport const x = eq\n`, /must not import an ORM/],
    ['the database package', `import { schema } from '@inrsettle/db'\nexport const x = schema\n`, /must not depend on the database package/],
    ['the application layer', `import x from '@inrsettle/app-services'\nexport default x\n`, /must not import the application layer/],
  ]

  for (const [what, source, expected] of cases) {
    it(`rejects importing ${what}`, async () => {
      const { ok, messages } = await lint(source)
      expect(ok, `ESLint accepted ${what} in the domain`).toBe(false)
      expect(messages).toMatch(expected)
    })
  }

  it('accepts an ordinary domain import', async () => {
    const { ok, messages } = await lint(`import { money } from '@inrsettle/money'\nexport const x = money\n`)
    expect(ok, messages).toBe(true)
  })
})

describe('INV-10 — the shipped domain is actually clean', () => {
  const files = sourceFiles(DOMAIN)

  it('has source to check', () => {
    expect(files.length).toBeGreaterThan(4)
  })

  it('imports no ORM, no database package and no framework', () => {
    const banned = /from\s+['"](drizzle-orm|@inrsettle\/db|@inrsettle\/app-services|@inrsettle\/ui|react|next)(\/[^'"]*)?['"]/
    const offenders = files
      .map((f) => [f, readFileSync(f, 'utf8')] as const)
      .filter(([, src]) => banned.test(src))
      .map(([f]) => f.slice(ROOT.length + 1))
    expect(offenders, 'domain source imports something it must not').toEqual([])
  })

  it('declares no forbidden runtime dependency in its manifest', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/domain/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const deps = Object.keys(pkg.dependencies ?? {})
    expect(deps).not.toContain('drizzle-orm')
    expect(deps).not.toContain('@inrsettle/db')
    // What it may depend on: pure packages only.
    expect(deps.sort()).toEqual(['@inrsettle/contracts', '@inrsettle/money'])
  })

  it('states its needs as ports', () => {
    const ports = readFileSync(join(DOMAIN, 'ports/index.ts'), 'utf8')
    for (const port of ['SecurityPolicyStore', 'MembershipStore', 'MfaStore', 'EventSink']) {
      expect(ports).toContain(`interface ${port}`)
    }
  })
})

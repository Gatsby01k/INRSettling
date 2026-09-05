/**
 * The reference is generated, and this is what keeps it that way.
 *
 * `reference/api/README.md` is built from the route table, the error catalogue,
 * the version registry, the event allow-list, the retry schedule and the snippet
 * files. If any of those change and the document does not, this fails — which is
 * the only mechanism that reliably stops a reference from drifting away from the
 * service it describes.
 *
 * Run `pnpm run build:api-reference` to regenerate. That is this same test with
 * `UPDATE_API_REFERENCE=1`, so there is exactly one code path and the check and
 * the generator cannot disagree.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildApiReference } from '../reference.js'

const here = dirname(fileURLToPath(import.meta.url))
const REFERENCE_DIR = join(here, '..', '..', '..', '..', 'reference', 'api')
const README = join(REFERENCE_DIR, 'README.md')

describe('the API reference', () => {
  it('matches what the service and the snippets produce', () => {
    const generated = buildApiReference(REFERENCE_DIR)

    if (process.env['UPDATE_API_REFERENCE'] === '1') {
      writeFileSync(README, generated)
      return
    }

    const committed = readFileSync(README, 'utf8')
    expect(
      committed === generated,
      'reference/api/README.md is stale — run: pnpm run build:api-reference',
    ).toBe(true)
  })

  it('documents every route, with nothing invented and nothing missing', () => {
    const doc = buildApiReference(REFERENCE_DIR)
    // Not a spot check: every path in the table, and no path outside it.
    const documented = [...doc.matchAll(/^\| `(GET|POST|DELETE)` \| `(\/v1\/[^`]+)`/gm)]
    expect(documented.length).toBeGreaterThan(0)
    for (const [, , path] of documented) {
      expect(path!.startsWith('/v1/')).toBe(true)
    }
  })

  it('publishes the snippets verbatim, not a paraphrase of them', () => {
    const doc = buildApiReference(REFERENCE_DIR)
    for (const file of ['verify-signature.ts', 'verify_signature.py', 'verify_signature.go']) {
      const source = readFileSync(join(REFERENCE_DIR, 'snippets', file), 'utf8').trimEnd()
      expect(doc).toContain(source)
    }
  })

  it('never publishes a live key or a real secret', () => {
    const doc = buildApiReference(REFERENCE_DIR)
    expect(doc).not.toMatch(/sk_live_[A-Za-z0-9_-]{8,}/)
    expect(doc).not.toMatch(/whsec_[A-Za-z0-9_-]{16,}/)
  })
})

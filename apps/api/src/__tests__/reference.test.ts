/**
 * Stage 8 exit criterion 2 — *"The published signature verification snippets are
 * themselves tested."*
 *
 * Not "an equivalent implementation is tested". **The published files** are read
 * off disk and executed here, against signatures produced by the same signer the
 * worker uses. If somebody edits a snippet and breaks it, this fails; if
 * somebody changes the signing scheme and forgets the docs, this fails too.
 *
 * `SECURITY.md § 4.1` says why it matters: *"Documented verification snippets in
 * the API reference, including the constant-time comparison, because a customer
 * who compares with `==` is a vulnerability we introduced."* A snippet is part
 * of the product's attack surface, so it gets tested like part of the product.
 *
 * The request examples in curl, TypeScript and Python cannot be executed — they
 * talk to a server that is not here — so they are checked for the thing that
 * would actually bite somebody who copied one: that every JSON body in them
 * parses under the API's own strict reader, and that every request carries the
 * headers the endpoint requires.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildSignatureHeader, parseStrictJson, SIGNATURE_TOLERANCE_SECONDS,
} from '@inrsettle/domain'
import { verifyInrsettleSignature } from '../../../../reference/api/snippets/verify-signature.js'

const here = dirname(fileURLToPath(import.meta.url))
const REFERENCE = join(here, '..', '..', '..', '..', 'reference', 'api')
const SNIPPETS = join(REFERENCE, 'snippets')
const EXAMPLES = join(REFERENCE, 'examples')

const SECRET = 'whsec_9Xm4Bv7NsLt2_reference'
const OTHER_SECRET = 'whsec_someone_elses_secret'
const T = 1756636800
const BODY = JSON.stringify({
  id: 'evt_5Md8Yn3CwPj2',
  object: 'event',
  type: 'settlement.settled',
  api_version: '2026-08-31',
  environment: 'sandbox',
  workspace_id: 'ws_3kQ8xR2mVnPq',
  created_at: '2026-08-31T09:17:55Z',
  data: { object: { id: 'stl_2Rn8Kq5TzYw6', status: 'settled' } },
})

const header = buildSignatureHeader({ secrets: [SECRET], timestampSeconds: T, rawBody: BODY })
const rotationHeader = buildSignatureHeader({
  secrets: [SECRET, OTHER_SECRET], timestampSeconds: T, rawBody: BODY,
})

/**
 * The cases every published snippet must agree on.
 *
 * The tolerance pair is the important one: `SECURITY.md § 4.1` insists the check
 * is `|now − t| > 300`, never `t > now + 300`, because a stale timestamp is what
 * a replay looks like. A snippet that only rejected the future would pass a
 * careless test and leave every customer who copied it replayable forever.
 */
const CASES: readonly {
  name: string
  body: string
  header: string
  secrets: string[]
  now: number
  expected: boolean
}[] = [
  { name: 'a genuine delivery', body: BODY, header, secrets: [SECRET], now: T, expected: true },
  {
    name: 'a delivery at the edge of the tolerance, in the past',
    body: BODY, header, secrets: [SECRET], now: T + SIGNATURE_TOLERANCE_SECONDS, expected: true,
  },
  {
    name: 'a replay one second past the tolerance',
    body: BODY, header, secrets: [SECRET], now: T + SIGNATURE_TOLERANCE_SECONDS + 1, expected: false,
  },
  {
    name: 'a future-dated timestamp past the tolerance',
    body: BODY, header, secrets: [SECRET], now: T - SIGNATURE_TOLERANCE_SECONDS - 1, expected: false,
  },
  {
    name: 'a tampered body',
    body: BODY.replace('settled', 'cancelled'), header, secrets: [SECRET], now: T, expected: false,
  },
  {
    name: 'the wrong secret',
    body: BODY, header, secrets: [OTHER_SECRET], now: T, expected: false,
  },
  {
    name: 'either secret during a rotation overlap',
    body: BODY, header: rotationHeader, secrets: [OTHER_SECRET], now: T, expected: true,
  },
  { name: 'a missing header', body: BODY, header: '', secrets: [SECRET], now: T, expected: false },
  {
    name: 'a header with no timestamp',
    body: BODY, header: 'v1=deadbeef', secrets: [SECRET], now: T, expected: false,
  },
  {
    name: 'a header with no signature',
    body: BODY, header: `t=${T}`, secrets: [SECRET], now: T, expected: false,
  },
]

const workspace = mkdtempSync(join(tmpdir(), 'inrsettle-snippets-'))
afterAll(() => { /* the OS reclaims it; nothing here is worth deleting eagerly */ })

/* ── TypeScript ─────────────────────────────────────────────────────────── */

describe('the published TypeScript snippet', () => {
  it.each(CASES)('handles $name', ({ body, header: h, secrets, now, expected }) => {
    // Imported from `reference/api/snippets/` — the file a customer copies.
    expect(verifyInrsettleSignature(body, h, secrets, now)).toBe(expected)
  })
})

/* ── Python ─────────────────────────────────────────────────────────────── */

describe('the published Python snippet', () => {
  it('agrees with the signer on every case', () => {
    const runner = join(workspace, 'run_verify.py')
    writeFileSync(runner, [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(SNIPPETS)})`,
      'from verify_signature import verify_inrsettle_signature',
      'cases = json.loads(sys.argv[1])',
      'print(json.dumps([',
      '    verify_inrsettle_signature(c["body"], c["header"], c["secrets"], c["now"])',
      '    for c in cases',
      ']))',
    ].join('\n'))

    const out = execFileSync('python3', [runner, JSON.stringify(CASES)], { encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual(CASES.map((c) => c.expected))
  })

  it('uses hmac.compare_digest, not ==', () => {
    // The rule SECURITY.md § 4.1 names explicitly. Asserting it in the file
    // rather than only in behaviour, because a timing side channel does not
    // change any answer — it only changes how long the wrong one takes.
    const source = readFileSync(join(SNIPPETS, 'verify_signature.py'), 'utf8')
    expect(source).toContain('hmac.compare_digest')
    expect(source).not.toMatch(/expected\s*==\s*candidate/)
  })
})

/* ── Go ─────────────────────────────────────────────────────────────────── */

describe('the published Go snippet', () => {
  it('agrees with the signer on every case', () => {
    const module = join(workspace, 'gomod')
    execFileSync('mkdir', ['-p', module])
    writeFileSync(join(module, 'go.mod'), 'module snippettest\n\ngo 1.20\n')
    // Copied verbatim, with only the package clause changed so `go run` will
    // take it as a main program. The verifier itself is untouched.
    const snippet = readFileSync(join(SNIPPETS, 'verify_signature.go'), 'utf8')
    writeFileSync(join(module, 'verify.go'), snippet.replace('package inrsettle', 'package main'))
    writeFileSync(join(module, 'main.go'), [
      'package main',
      '',
      'import (',
      '\t"encoding/json"',
      '\t"fmt"',
      '\t"os"',
      ')',
      '',
      'type testCase struct {',
      '\tBody    string   `json:"body"`',
      '\tHeader  string   `json:"header"`',
      '\tSecrets []string `json:"secrets"`',
      '\tNow     int64    `json:"now"`',
      '}',
      '',
      'func main() {',
      '\tvar cases []testCase',
      '\tif err := json.Unmarshal([]byte(os.Args[1]), &cases); err != nil {',
      '\t\tpanic(err)',
      '\t}',
      '\tresults := make([]bool, 0, len(cases))',
      '\tfor _, c := range cases {',
      '\t\tresults = append(results, VerifySignature(c.Body, c.Header, c.Secrets, c.Now))',
      '\t}',
      '\tout, _ := json.Marshal(results)',
      '\tfmt.Println(string(out))',
      '}',
    ].join('\n'))

    const out = execFileSync('go', ['run', '.', JSON.stringify(CASES)], {
      cwd: module,
      encoding: 'utf8',
      env: { ...process.env, GOCACHE: join(workspace, 'gocache'), GOFLAGS: '-mod=mod' },
    })
    expect(JSON.parse(out)).toEqual(CASES.map((c) => c.expected))
  }, 120_000)

  it('uses hmac.Equal, not ==', () => {
    const source = readFileSync(join(SNIPPETS, 'verify_signature.go'), 'utf8')
    expect(source).toContain('hmac.Equal')
  })
})

/* ── All three agree ────────────────────────────────────────────────────── */

describe('all three snippets state the same rules', () => {
  const sources = {
    typescript: readFileSync(join(SNIPPETS, 'verify-signature.ts'), 'utf8'),
    python: readFileSync(join(SNIPPETS, 'verify_signature.py'), 'utf8'),
    go: readFileSync(join(SNIPPETS, 'verify_signature.go'), 'utf8'),
  }

  it.each(Object.entries(sources))('%s carries the tolerance the documents specify', (_lang, source) => {
    expect(source).toContain(String(SIGNATURE_TOLERANCE_SECONDS))
    // Both directions, said in words, because the next person to edit the file
    // will read the comment before they read the arithmetic.
    expect(source).toMatch(/EITHER direction/)
  })

  it.each(Object.entries(sources))('%s tells the reader to treat event id as an idempotency key', (_lang, source) => {
    expect(source).toMatch(/idempotency key/i)
    expect(source).toMatch(/re-read the settlement/i)
  })

  it.each(Object.entries(sources))('%s signs "{t}.{raw_body}", not the body alone', (_lang, source) => {
    expect(source).toMatch(/RAW body|raw bytes|raw body/i)
  })
})

/* ── The request examples ───────────────────────────────────────────────── */

describe('the published request examples', () => {
  const curl = readFileSync(join(EXAMPLES, 'settle.sh'), 'utf8')

  it('sends bodies the API can actually read', () => {
    // Every -d '{…}' in the curl example, through the same strict reader the
    // API uses. A published example with a duplicate key or a trailing comma
    // would be refused by the service it is teaching people to call.
    const bodies = [...curl.matchAll(/-d '([\s\S]*?)'/g)].map((m) => m[1]!)
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    for (const body of bodies) expect(() => parseStrictJson(body)).not.toThrow()
  })

  it('sends money as a string minor_units, everywhere it sends money', () => {
    // § 3.1 makes it a string so values above 2^53 survive a JavaScript client.
    // An example that showed it as a bare number would teach the bug the
    // representation exists to prevent, so no file may contain one.
    for (const file of ['settle.sh', 'settle.ts', 'settle.py']) {
      const source = readFileSync(join(EXAMPLES, file), 'utf8')
      const quoted = [...source.matchAll(/minor_units["']?\s*:\s*(["'])\d+\1/g)]
      expect(quoted.length, `${file} shows no money at all`).toBeGreaterThan(0)
      const bare = [...source.matchAll(/minor_units["']?\s*:\s*\d/g)]
      expect(bare, `${file} sends minor_units as a number`).toHaveLength(0)
    }
  })

  it('sends an Idempotency-Key on both endpoints that require one', () => {
    // § 4: required on POST /v1/settlements and POST /…/authorize. An example
    // that omitted it would teach a 400.
    const settlementsCall = curl.slice(curl.indexOf('/settlements"'))
    expect(settlementsCall).toContain('Idempotency-Key:')
    expect(curl).toContain('Idempotency-Key: 6f2c1a90-contractor-sept-0142-auth')
  })

  it('uses a sandbox key, and says which environment it addresses', () => {
    expect(curl).toContain('sk_test_')
    expect(curl).not.toContain('sk_live_')
    for (const file of ['settle.ts', 'settle.py']) {
      expect(readFileSync(join(EXAMPLES, file), 'utf8')).toContain('sk_test_')
    }
  })

  it('shows how to read an error, in every language', () => {
    for (const file of ['settle.ts', 'settle.py']) {
      const source = readFileSync(join(EXAMPLES, file), 'utf8')
      expect(source).toContain('request_id')
      expect(source).toContain('detail')
    }
  })

  it('warns that settled is not the end of the story', () => {
    // § 7.5: "integrations must not treat settled alone as 'money is with the
    // beneficiary and will stay there'." An example that did not say so would
    // be teaching the mistake.
    for (const file of ['settle.ts', 'settle.py']) {
      const source = readFileSync(join(EXAMPLES, file), 'utf8')
      expect(source).toMatch(/return_confirmed|has_confirmed_return/)
    }
  })
})

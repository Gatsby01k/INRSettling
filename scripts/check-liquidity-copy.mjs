#!/usr/bin/env node
/**
 * Stage 4 exit criterion: *"the word 'credit', 'loan' and 'balance' appear
 * nowhere in customer-facing copy for this feature."*
 *
 * Why this is a build gate rather than a review habit. Every one of these words
 * is the *obvious* word. Someone writing an empty state at the end of a long
 * day will type "your balance" because that is what the sentence wants, and it
 * will read fine to three reviewers who are thinking about the layout. The
 * vocabulary rule in `PRODUCT.md § 12` is not a style preference — each banned
 * word names a product INRSettle is not, and "credit" and "loan" in particular
 * describe a regulated activity it does not carry out (`D-02` is open on
 * exactly what it *is*). A wrong word here is a compliance statement.
 *
 * Scope is deliberately narrow: customer-facing surfaces only. The domain, the
 * database and the internal services say "facility", "drawdown" and "reserved"
 * constantly, and must, because those are the real names of the real things.
 * This gate is about what reaches a customer's eyes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
const problems = []

/**
 * The customer-facing tree. `apps/app` is the customer application and
 * `packages/ui` is the primitive library it renders with; nothing else in the
 * repository produces a string a customer reads.
 */
const CUSTOMER_DIRS = ['apps/app/src', 'packages/ui/src']

/**
 * `PRODUCT.md § 12`, the *Available to settle* row, plus the never-show list.
 *
 * Each is matched on a word boundary, so "creditor" is not "credit" and
 * "balanced" — which the ledger code says legitimately — is not "balance".
 */
const BANNED = [
  // The four alternatives the vocabulary table forbids for Available to settle.
  { word: 'balance', why: 'implies the customer holds funds with us' },
  { word: 'balances', why: 'implies the customer holds funds with us' },
  { word: 'wallet', why: 'implies a stored-value product' },
  { word: 'credit', why: 'implies lending — D-02 is open on what INRSettle legally is' },
  { word: 'credits', why: 'implies lending' },
  { word: 'loan', why: 'implies lending' },
  { word: 'loans', why: 'implies lending' },
  { word: 'limit remaining', why: 'implies a credit limit' },
  // "Never show the customer" — the internal vocabulary of this stage.
  { word: 'facility', why: 'an internal arrangement the customer does not operate' },
  { word: 'drawdown', why: 'an internal mechanism' },
  { word: 'drawdowns', why: 'an internal mechanism' },
  { word: 'prefunding', why: 'an internal mechanism' },
  { word: 'stablecoin', why: 'an internal funding detail' },
]

const SCAN_EXTENSIONS = /\.(ts|tsx|js|jsx)$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'storybook-static', 'coverage'])

/**
 * A line may opt out with an explicit marker, for the one legitimate case: code
 * that names a banned word in order to reject it, including this gate's own
 * tests. Same-line only, so it is visible in review and cannot cover a block.
 */
const ALLOW_MARKER = 'liquidity-copy:allow'

/**
 * Only *strings* are checked, not identifiers.
 *
 * `presentAvailability` reads a variable called `availableToSettle` and a type
 * called `FacilityRow`; neither is copy. Checking identifiers too would make
 * the gate unusable and it would be switched off, which is worse than a
 * narrower gate that stays on. What a customer sees is a string literal or JSX
 * text, and that is what this reads.
 */
/**
 * A `snake_case` string literal is an identifier, not a sentence.
 *
 * `'set_up_liquidity_facility'` is an action *type* travelling over the wire
 * and through a switch; `'Set up facility'` is what a customer reads. Treating
 * the first as copy produced a false positive on the very first run, and a gate
 * that cries wolf is a gate someone switches off. Kept deliberately narrow — a
 * bare word like `'balance'` is still checked, because that really could be a
 * label.
 */
const IDENTIFIER = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/

/**
 * Strip comments before looking for copy.
 *
 * A comment explaining *why* a word is banned necessarily contains that word —
 * the note above `set_up_liquidity_facility` reading `// Not "Set up facility"`
 * is the clearest possible documentation of the rule, and the first version of
 * this gate flagged it. Comments ship to no customer.
 *
 * The scan tracks quote state so a `//` inside a string (a URL, say) is not
 * mistaken for the start of a comment.
 */
function withoutComments(line) {
  const trimmed = line.trimStart()
  // Whole-line comments, including JSDoc continuation lines.
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''

  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quote) {
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
    else if (c === '/' && line[i + 1] === '*') return line.slice(0, i)
  }
  return line
}

/**
 * A test or story *title* is prose about the code, not copy.
 *
 * `it('shows nothing before a facility exists')` describes behaviour; the
 * strings the test then asserts on are still checked, because those are where a
 * bad fixture would hide. Only the title is skipped, and only on a line that
 * opens one — which is narrow enough that a fixture called
 * `title: 'Your balance'` on the next line is still caught.
 */
const SPEC_TITLE = /^\s*(describe|it|test)(\.\w+)?\s*\(\s*(?<title>'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`)/

function stringsIn(rawLine) {
  let line = withoutComments(rawLine)
  const spec = SPEC_TITLE.exec(line)
  if (spec?.groups?.title) line = line.replace(spec.groups.title, '')
  const out = []
  // Quoted strings of all three kinds.
  for (const m of line.matchAll(/'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g)) {
    const inner = m[0].slice(1, -1)
    if (IDENTIFIER.test(inner)) continue
    out.push(inner)
  }
  // JSX text between tags, e.g. `<p>Your balance</p>`.
  for (const m of line.matchAll(/>([^<>{}]+)</g)) out.push(m[1])
  return out
}

function scan(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      scan(path)
      continue
    }
    if (!SCAN_EXTENSIONS.test(entry)) continue

    const rel = relative(ROOT, path)
    const lines = readFileSync(path, 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      if (line.includes(ALLOW_MARKER)) continue
      const haystack = stringsIn(line).join(' ').toLowerCase()
      if (haystack.length === 0) continue
      for (const { word, why } of BANNED) {
        const pattern = new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`)
        if (pattern.test(haystack)) {
          problems.push(`${rel}:${i + 1}: customer-facing copy says "${word}" — ${why}`)
        }
      }
    }
  }
}

for (const dir of CUSTOMER_DIRS) scan(join(ROOT, dir))

if (problems.length > 0) {
  console.error('Liquidity vocabulary check failed:\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '\nPRODUCT.md § 12: the customer sees "Available to settle", never a balance,\n' +
      'wallet, credit or limit. Liquidity is INRSettle\'s arrangement with a provider,\n' +
      'not money the customer holds and not money we have lent them.\n',
  )
  process.exit(1)
}

console.log(`liquidity vocabulary clean: ${CUSTOMER_DIRS.join(', ')}`)

#!/usr/bin/env node
/**
 * INV-02 — every persisted monetary value is (…_minor BIGINT, …_currency TEXT).
 *
 * Fails the build when a migration declares a money-shaped column as NUMERIC,
 * DECIMAL, REAL, DOUBLE PRECISION or MONEY, or declares a `*_minor` column on a
 * table that carries no currency anywhere.
 *
 * A grep, deliberately: it runs before anything is applied, needs no database,
 * and reads the same file a reviewer reads.
 *
 * **Two passes, because a column can arrive later than its table.** The first
 * pass collects every column of every table across every migration — from
 * `CREATE TABLE` bodies *and* from `ALTER TABLE … ADD COLUMN` — and only then
 * does the second pass judge them. Checking each file alone would have two
 * blind spots, and both are the normal shape of a schema that grows: a money
 * column added by a later migration would never be checked at all, and one
 * added beside a currency column declared in an earlier file would be reported
 * as unpaired when it is not. A gate that is silent in exactly the cases a real
 * schema produces is worse than no gate, because it is trusted.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const BANNED = /\b(numeric|decimal|real|double\s+precision|money)\b/i
const MONEY_ISH =
  /^(.*_)?(amount|balance|total|fee|price|limit|drawn|reserved|available|sum|value|delta|residual)(_.*)?$/i

function sqlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    // __tests__ holds deliberately-bad fixtures for this very check.
    if (['node_modules', '.git', 'dist', '__tests__', 'storybook-static'].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sqlFiles(full, acc)
    else if (entry.endsWith('.sql')) acc.push(full)
  }
  return acc
}

/** Every table this file creates, as a name and a raw column body. */
function tablesIn(sql) {
  const out = []
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(([\s\S]*?)\n\);/gi
  let m
  while ((m = re.exec(sql))) out.push({ name: m[1], body: m[2] })
  return out
}

function columnsInBody(body) {
  const columns = []
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/,$/, '')
    if (!line || line.startsWith('--')) continue
    const m = /^"?(\w+)"?\s+([A-Za-z][\w\s()]*)/.exec(line)
    if (!m) continue
    const [, col, type] = m
    if (/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK|FOREIGN|EXCLUDE)$/i.test(col)) continue
    columns.push({ col, type: type.trim() })
  }
  return columns
}

/**
 * Every column this file adds to an existing table.
 *
 * The declared type is taken as the leading token or two rather than the rest
 * of the line, because an `ADD COLUMN … CHECK (…)` carries arbitrary SQL after
 * the type and a word like `real` inside a constraint expression is not a type.
 */
function addedColumnsIn(sql) {
  const out = []
  const withoutComments = sql.replace(/--[^\n]*/g, '')
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?(\w+)"?([\s\S]*?);/gi
  let statement
  while ((statement = re.exec(withoutComments))) {
    const table = statement[1]
    const add = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+([A-Za-z]\w*(?:\s+precision)?(?:\s*\([^)]*\))?)/gi
    let m
    while ((m = add.exec(statement[2]))) out.push({ table, col: m[1], type: m[2].trim() })
  }
  return out
}

/* ── Pass 1: the whole schema, whichever file each piece arrived in ─────── */

/** table → Map(column → { type, file }) */
const schema = new Map()

function declare(table, col, type, file) {
  if (!schema.has(table)) schema.set(table, new Map())
  // First declaration wins. A later ALTER that only sets a default or a NOT
  // NULL is not a redeclaration of the type.
  if (!schema.get(table).has(col)) schema.get(table).set(col, { type, file })
}

for (const file of sqlFiles(ROOT)) {
  const sql = readFileSync(file, 'utf8')
  for (const { name, body } of tablesIn(sql)) {
    for (const { col, type } of columnsInBody(body)) declare(name, col, type, file)
  }
  for (const { table, col, type } of addedColumnsIn(sql)) declare(table, col, type, file)
}

/* ── Pass 2: judge ──────────────────────────────────────────────────────── */

const problems = []

for (const [table, columns] of schema) {
  const names = new Set(columns.keys())

  for (const [col, { type, file }] of columns) {
    const where = `${relative(ROOT, file)}: ${table}.${col}`

    if (MONEY_ISH.test(col) && BANNED.test(type)) {
      problems.push(
        `${where} is ${type.split(/\s/)[0].toUpperCase()} — ` +
          `money is BIGINT minor units plus a currency column (INV-02)`,
      )
    }
    if (!col.endsWith('_minor')) continue

    if (!/bigint/i.test(type)) {
      problems.push(`${where} must be BIGINT, got ${type} (INV-02)`)
    }
    // INV-02 requires an amount to carry a currency, and the currency to be
    // unambiguous. Two ways to satisfy that, and both are honest:
    //
    //   `amount_minor` beside its own `amount_currency` — the usual pairing,
    //   and the only one available to a table that holds amounts in more than
    //   one currency;
    //
    //   or any `*_minor` column on a table that declares exactly **one**
    //   currency column, whatever it is named. A facility's limit, drawn and
    //   reserved figures are necessarily the same currency — they are
    //   subtracted from each other — and a payout attempt's instructed and
    //   credited amounts are the same currency for the same reason: a rail
    //   credits in the currency it was instructed in. Demanding a currency
    //   column per amount there would create several places for one fact to
    //   live, and they would eventually disagree, which is a worse failure than
    //   the one INV-02 is guarding against.
    //
    // The moment a table declares a second currency, the table-level reading
    // stops being available and every amount must name its own — because at
    // that point "the table's currency" is no longer a thing that exists.
    //
    // What is still rejected is the thing that matters: an amount on a table
    // with no currency anywhere.
    const stem = col.slice(0, -'_minor'.length)
    const currencies = [...names].filter((n) => n === 'currency' || n.endsWith('_currency'))
    if (!names.has(`${stem}_currency`) && currencies.length !== 1) {
      problems.push(
        currencies.length === 0
          ? `${where} has no ${stem}_currency beside it, and ${table} declares no currency column at all (INV-02)`
          : `${where} has no ${stem}_currency beside it, and ${table} declares more than one currency ` +
            `(${currencies.join(', ')}), so which one applies is ambiguous (INV-02)`,
      )
    }
  }
}

if (problems.length) {
  console.error('Money-column check failed:\n')
  for (const p of problems.sort()) console.error('  ' + p)
  console.error(`\n${problems.length} problem(s). See DOMAIN.md § 3.`)
  process.exit(1)
}
console.log(
  `Money-column check passed: ${schema.size} tables, no floating-point or unpaired money columns.`,
)

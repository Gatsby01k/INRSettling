/**
 * Batch CSV import — `PRODUCT.md § 10`, `INV-30`.
 *
 * > *"Supported creation paths: CSV import with row-level validation, and API."*
 * > *"Invalid or incomplete rows must never block valid ones."*
 *
 * And the Stage 7 exit criterion that shapes every error message below:
 *
 * > *"CSV errors are per-row and name the column and the fix."*
 *
 * Which is a higher bar than it sounds. `"invalid amount on line 42"` names
 * neither: it does not say *which* column when a row has three amounts, and it
 * does not say what to do. Every `RowError` here carries the column, what was
 * found, and a `fix` written as an instruction — because the person reading it
 * has a spreadsheet open and needs to know which cell to change.
 *
 * ## Why this is pure
 *
 * Validation that needs the database — does this beneficiary exist, is it
 * verified — is **not** here. This file answers only what can be answered from
 * the file itself: is the header right, is this a number, is that a currency,
 * is the purpose code one of the ones we know. The rest happens per row, in the
 * service, in its own transaction. Keeping the split means a 500-row file can be
 * parsed and reported on without touching a connection, and it means every
 * message below can be tested without a fixture.
 */

/* ── The frozen-ish shape of a row ──────────────────────────────────────── */

/**
 * The columns a batch row carries.
 *
 * The baseline does not specify them — `PRODUCT.md § 10` names CSV import and
 * stops — so this is the minimum that maps onto `createSettlement` and nothing
 * more. In particular there is **no** beneficiary-creation column: a
 * beneficiary is *"a first-class, reusable domain object. Verify once, settle
 * many times"* (`§ 11`), and letting a CSV mint one would put beneficiary
 * creation and verification on a path with no verification step in it.
 */
export const BATCH_CSV_COLUMNS = [
  'beneficiary_id',
  'amount_inr',
  'purpose_code',
  'external_reference',
] as const
export type BatchCsvColumn = (typeof BATCH_CSV_COLUMNS)[number]

const REQUIRED_COLUMNS: readonly BatchCsvColumn[] = [
  'beneficiary_id',
  'amount_inr',
  'purpose_code',
]

export interface RowError {
  /** The column to look at. `null` only where the fault is the row itself. */
  readonly column: BatchCsvColumn | null
  readonly problem: string
  /** What to do about it, phrased as an instruction to the person with the file. */
  readonly fix: string
}

export interface ParsedRow {
  /** 1-based, counting the header as line 1 — what the spreadsheet shows. */
  readonly line: number
  readonly raw: Readonly<Record<string, string>>
  readonly beneficiaryId: string
  /** INR minor units. */
  readonly amountMinor: bigint
  readonly purposeCode: string
  readonly externalReference: string | null
}

export type RowResult =
  | { readonly ok: true; readonly row: ParsedRow }
  | { readonly ok: false; readonly line: number; readonly raw: Readonly<Record<string, string>>; readonly errors: readonly RowError[] }

export type ParseResult =
  | { readonly ok: true; readonly rows: readonly RowResult[] }
  /** The file itself is unusable — a header problem, or no rows at all. */
  | { readonly ok: false; readonly fileErrors: readonly RowError[] }

/* ── Reading the file ───────────────────────────────────────────────────── */

/**
 * RFC 4180 fields: quotes, doubled quotes inside quotes, embedded newlines.
 *
 * Hand-written rather than a dependency because the format is small and the
 * failure mode of getting it wrong is specific and bad: a quoted beneficiary
 * name containing a comma silently becomes two columns, every subsequent column
 * shifts by one, and a row that should have failed validation instead passes it
 * with the wrong values in the wrong fields.
 */
export function parseCsvGrid(text: string): string[][] {
  // A byte-order mark on the first header cell makes `beneficiary_id` not equal
  // `beneficiary_id`, which is a genuinely baffling failure for whoever exported
  // the file from Excel.
  const input = text.replace(/^﻿/, '')
  const grid: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  const endField = (): void => { row.push(field); field = '' }
  const endRow = (): void => { endField(); grid.push(row); row = [] }

  while (i < input.length) {
    const char = input[i]!
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i += 1; continue
      }
      field += char; i += 1; continue
    }
    if (char === '"' && field === '') { quoted = true; i += 1; continue }
    if (char === ',') { endField(); i += 1; continue }
    if (char === '\r' && input[i + 1] === '\n') { endRow(); i += 2; continue }
    if (char === '\n' || char === '\r') { endRow(); i += 1; continue }
    field += char; i += 1
  }
  // A file that does not end in a newline still has a last row.
  if (field !== '' || row.length > 0) endRow()

  // Excel writes a trailing blank line; so does every text editor.
  return grid.filter((r) => !(r.length === 1 && r[0]!.trim() === ''))
}

/* ── Validating a row ───────────────────────────────────────────────────── */

/**
 * A rupee amount as a person writes it in a spreadsheet.
 *
 * Accepts `12000`, `12,000`, `12000.50`, `₹12,000.50`. Rejects anything with
 * more than two decimal places rather than rounding it: a row saying `100.005`
 * means somebody's export is wrong, and quietly turning it into `100.00` or
 * `100.01` decides in their favour or against them without telling them.
 *
 * Returns minor units, so no float ever exists (`INV-02`, `INV-04`).
 */
export function parseRupees(input: string): { ok: true; minorUnits: bigint } | { ok: false; problem: string; fix: string } {
  const cleaned = input.trim().replace(/^₹/, '').replace(/,/g, '').trim()
  if (cleaned.length === 0) {
    return { ok: false, problem: 'the amount is empty', fix: 'enter the amount in rupees, for example 12000 or 12000.50' }
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    if (/^-/.test(cleaned)) {
      return {
        ok: false,
        problem: `"${input.trim()}" is negative`,
        fix: 'enter a positive amount; a batch pays money out, and a refund is a separate settlement',
      }
    }
    if (/^\d+\.\d{3,}$/.test(cleaned)) {
      return {
        ok: false,
        problem: `"${input.trim()}" has more than two decimal places`,
        fix: 'round the amount to paise yourself, to two decimal places — we will not round it for you',
      }
    }
    return {
      ok: false,
      problem: `"${input.trim()}" is not a rupee amount`,
      fix: 'use digits only, with an optional two decimal places, for example 12000 or 12000.50',
    }
  }
  const [whole, frac = ''] = cleaned.split('.')
  const minorUnits = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'))
  if (minorUnits === 0n) {
    return { ok: false, problem: 'the amount is zero', fix: 'enter an amount greater than zero, or delete the row' }
  }
  return { ok: true, minorUnits }
}

export interface CsvValidationOptions {
  /** The purpose codes the active preflight rule set knows. Supplied, never guessed. */
  readonly purposeCodes: readonly string[]
  /** Refused above this, so one file cannot become an unbounded job. */
  readonly maxRows?: number
}

const DEFAULT_MAX_ROWS = 10_000

/**
 * Parse and validate a whole file, giving every row its own answer.
 *
 * Note what this never does: stop early. `INV-30` says an invalid row must not
 * block a valid one, and a parser that threw on line 42 would block four hundred
 * and fifty-eight of them before anybody saw a single error message. Every row
 * is validated, and the caller receives a verdict for each.
 */
export function parseBatchCsv(text: string, options: CsvValidationOptions): ParseResult {
  const grid = parseCsvGrid(text)
  if (grid.length === 0) {
    return {
      ok: false,
      fileErrors: [{ column: null, problem: 'the file is empty', fix: 'export the file again with a header row and at least one settlement' }],
    }
  }

  const header = grid[0]!.map((h) => h.trim().toLowerCase())
  const fileErrors: RowError[] = []
  for (const required of REQUIRED_COLUMNS) {
    if (!header.includes(required)) {
      fileErrors.push({
        column: required,
        problem: `the file has no "${required}" column`,
        fix: `add a "${required}" column to the header row (the columns we read are: ${BATCH_CSV_COLUMNS.join(', ')})`,
      })
    }
  }
  const duplicates = header.filter((h, i) => h !== '' && header.indexOf(h) !== i)
  for (const duplicate of [...new Set(duplicates)]) {
    fileErrors.push({
      column: (BATCH_CSV_COLUMNS as readonly string[]).includes(duplicate)
        ? (duplicate as BatchCsvColumn)
        : null,
      problem: `the column "${duplicate}" appears more than once`,
      fix: 'remove the duplicate column, so it is unambiguous which one we should read',
    })
  }
  if (fileErrors.length > 0) return { ok: false, fileErrors }

  const body = grid.slice(1)
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  if (body.length === 0) {
    return {
      ok: false,
      fileErrors: [{ column: null, problem: 'the file has a header but no rows', fix: 'add at least one settlement row below the header' }],
    }
  }
  if (body.length > maxRows) {
    return {
      ok: false,
      fileErrors: [{
        column: null,
        problem: `the file has ${body.length} rows, and the limit is ${maxRows}`,
        fix: `split it into files of at most ${maxRows} rows`,
      }],
    }
  }

  const purposeCodes = new Set(options.purposeCodes)
  const rows: RowResult[] = body.map((cells, index) => {
    const line = index + 2 // the header is line 1
    const raw: Record<string, string> = {}
    header.forEach((name, i) => { if (name !== '') raw[name] = (cells[i] ?? '').trim() })

    const errors: RowError[] = []
    const beneficiaryId = raw['beneficiary_id'] ?? ''
    if (beneficiaryId.length === 0) {
      errors.push({
        column: 'beneficiary_id',
        problem: 'the beneficiary is missing',
        fix: 'paste the beneficiary id from the beneficiary page — it starts with ben_',
      })
    } else if (!/^ben_[A-Za-z0-9]+$/.test(beneficiaryId)) {
      errors.push({
        column: 'beneficiary_id',
        problem: `"${beneficiaryId}" is not a beneficiary id`,
        fix: 'use the id from the beneficiary page, which starts with ben_ — not the name',
      })
    }

    const amount = parseRupees(raw['amount_inr'] ?? '')
    if (!amount.ok) {
      errors.push({ column: 'amount_inr', problem: amount.problem, fix: amount.fix })
    }

    const purposeCode = raw['purpose_code'] ?? ''
    if (purposeCode.length === 0) {
      errors.push({
        column: 'purpose_code',
        problem: 'the purpose code is missing',
        fix: `choose one of: ${[...purposeCodes].join(', ')}`,
      })
    } else if (!purposeCodes.has(purposeCode)) {
      errors.push({
        column: 'purpose_code',
        problem: `"${purposeCode}" is not a purpose code we accept`,
        fix: `use one of: ${[...purposeCodes].join(', ')}`,
      })
    }

    if (errors.length > 0) return { ok: false, line, raw, errors }
    return {
      ok: true,
      row: {
        line,
        raw,
        beneficiaryId,
        amountMinor: amount.ok ? amount.minorUnits : 0n,
        purposeCode,
        externalReference: (raw['external_reference'] ?? '').length > 0
          ? raw['external_reference']!
          : null,
      },
    }
  })

  return { ok: true, rows }
}

/**
 * A row error, rendered for a person.
 *
 * One place, so the CSV report, the API response and the batch screen say the
 * same sentence. The line number leads, because that is what somebody scrolls
 * to.
 */
export function describeRowError(line: number, error: RowError): string {
  const where = error.column === null ? `Line ${line}` : `Line ${line}, column ${error.column}`
  return `${where}: ${error.problem}. ${error.fix}.`
}

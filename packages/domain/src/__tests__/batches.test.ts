/**
 * The batch container and its CSV import — the pure half.
 *
 * `INV-30` is a statement about isolation, which needs a database to
 * demonstrate; that is `batches.test.ts` in the app package. What is testable
 * here is everything the file itself decides: whether a row parses, whether its
 * error tells somebody what to change, and how the container summarises rows it
 * cannot move.
 */
import { describe, expect, it } from 'vitest'
import {
  BATCH_TRANSITIONS,
  aggregate,
  describeRowError,
  evaluateBatchTransition,
  isResolvedOutcome,
  isTerminalBatchStatus,
  needsAttention,
  parseBatchCsv,
  parseCsvGrid,
  parseRupees,
  rowOutcomeFromCustomerStatus,
  terminalOutcome,
  type BatchRowOutcome,
} from '../index.js'

const PURPOSES = ['SOFTWARE_SERVICES', 'PROFESSIONAL_FEES']
const HEADER = 'beneficiary_id,amount_inr,purpose_code,external_reference'
const opts = { purposeCodes: PURPOSES }

describe('the CSV grid', () => {
  it('reads quoted fields containing commas', () => {
    // The failure this prevents is specific and bad: an unquoted split shifts
    // every later column by one, and a row that should have failed validation
    // passes it with the wrong values in the wrong fields.
    expect(parseCsvGrid('a,"b,c",d')).toEqual([['a', 'b,c', 'd']])
  })

  it('reads doubled quotes inside a quoted field', () => {
    expect(parseCsvGrid('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']])
  })

  it('reads a newline inside a quoted field', () => {
    expect(parseCsvGrid('a,"one\ntwo",c')).toEqual([['a', 'one\ntwo', 'c']])
  })

  it('handles CRLF, a missing final newline, and a trailing blank line', () => {
    expect(parseCsvGrid('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseCsvGrid('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('strips a byte-order mark, so an Excel export’s header still matches', () => {
    // Without this, `beneficiary_id` does not equal `beneficiary_id`, which is a
    // genuinely baffling failure for whoever exported the file.
    expect(parseCsvGrid('﻿beneficiary_id,amount_inr')[0]![0]).toBe('beneficiary_id')
  })
})

describe('rupee amounts', () => {
  it('reads what people actually type', () => {
    expect(parseRupees('12000')).toEqual({ ok: true, minorUnits: 1_200_000n })
    expect(parseRupees('12,000.50')).toEqual({ ok: true, minorUnits: 1_200_050n })
    expect(parseRupees(' ₹12,000 ')).toEqual({ ok: true, minorUnits: 1_200_000n })
    expect(parseRupees('0.01')).toEqual({ ok: true, minorUnits: 1n })
  })

  it('refuses a third decimal place rather than rounding it', () => {
    // Rounding decides in the customer's favour or against them without telling
    // them, and a row saying 100.005 means their export is wrong.
    const result = parseRupees('100.005')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.problem).toMatch(/more than two decimal places/)
    expect(!result.ok && result.fix).toMatch(/round the amount to paise yourself/)
  })

  it('refuses zero, a negative, and a word — each with its own fix', () => {
    expect(!parseRupees('0').ok && parseRupees('0')).toMatchObject({
      problem: 'the amount is zero',
    })
    const negative = parseRupees('-5')
    expect(!negative.ok && negative.fix).toMatch(/positive/)
    const word = parseRupees('twelve thousand')
    expect(!word.ok && word.fix).toMatch(/digits only/)
  })

  it('creates no float on the way', () => {
    // INV-02 and INV-04. A big amount that went through a double would come out
    // wrong, and this one would.
    expect(parseRupees('90071992547409.91')).toEqual({ ok: true, minorUnits: 9007199254740991n })
  })
})

describe('the file as a whole', () => {
  it('names a missing column and the columns we read', () => {
    const result = parseBatchCsv('beneficiary_id,amount_inr\nben_1,100', opts)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.fileErrors[0]).toMatchObject({ column: 'purpose_code' })
    expect(!result.ok && result.fileErrors[0]!.fix).toContain('external_reference')
  })

  it('refuses a duplicated column rather than guessing which to read', () => {
    const result = parseBatchCsv(`${HEADER},amount_inr\nben_1,100,SOFTWARE_SERVICES,,200`, opts)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.fileErrors[0]!.problem).toMatch(/appears more than once/)
  })

  it('refuses an empty file and a header with no rows, differently', () => {
    expect(parseBatchCsv('', opts)).toMatchObject({ ok: false })
    const headerOnly = parseBatchCsv(HEADER, opts)
    expect(!headerOnly.ok && headerOnly.fileErrors[0]!.problem).toMatch(/no rows/)
  })

  it('refuses a file above the row limit, and says how to split it', () => {
    const rows = Array.from({ length: 5 }, () => 'ben_1,100,SOFTWARE_SERVICES,')
    const result = parseBatchCsv([HEADER, ...rows].join('\n'), { ...opts, maxRows: 3 })
    expect(!result.ok && result.fileErrors[0]!.fix).toMatch(/split it into files of at most 3/)
  })
})

describe('a row at a time — INV-30 in the parser', () => {
  it('validates every row rather than stopping at the first bad one', () => {
    // A parser that threw on line 3 would block lines 4 and 5 before anybody saw
    // a single message, which is the shape INV-30 forbids.
    const csv = [
      HEADER,
      'ben_aaa,1000,SOFTWARE_SERVICES,inv-1',
      'ben_bbb,nope,SOFTWARE_SERVICES,inv-2',
      'not-an-id,1000,SOFTWARE_SERVICES,inv-3',
      'ben_ccc,1000,MYSTERY_CODE,inv-4',
      'ben_ddd,2000,PROFESSIONAL_FEES,inv-5',
    ].join('\n')
    const result = parseBatchCsv(csv, opts)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.rows).toHaveLength(5)
    expect(result.rows.map((r) => r.ok)).toEqual([true, false, false, false, true])
    // Line numbers count the header as line 1 — what the spreadsheet shows.
    expect(result.rows.map((r) => (r.ok ? r.row.line : r.line))).toEqual([2, 3, 4, 5, 6])
  })

  it('every row error names the column and the fix', () => {
    // The exit criterion, asserted as a property of every error rather than of
    // one example.
    const csv = [
      HEADER,
      'ben_bbb,nope,SOFTWARE_SERVICES,',
      'not-an-id,1000,SOFTWARE_SERVICES,',
      'ben_ccc,1000,MYSTERY_CODE,',
      ',,,',
    ].join('\n')
    const result = parseBatchCsv(csv, opts)
    if (!result.ok) throw new Error('expected rows')

    const failures = result.rows.filter((r) => !r.ok)
    expect(failures.length).toBeGreaterThan(0)
    for (const failure of failures) {
      if (failure.ok) continue
      for (const error of failure.errors) {
        expect(error.column, JSON.stringify(error)).not.toBeNull()
        expect(error.problem.length).toBeGreaterThan(5)
        // A fix is an instruction, not a restatement of the problem.
        expect(error.fix.length, error.fix).toBeGreaterThan(15)
        expect(error.fix).not.toBe(error.problem)
      }
    }
  })

  it('reports every problem on a row, not just the first', () => {
    const result = parseBatchCsv(`${HEADER}\nnot-an-id,nope,MYSTERY,`, opts)
    if (!result.ok) throw new Error('expected rows')
    const row = result.rows[0]!
    expect(row.ok).toBe(false)
    expect(!row.ok && row.errors.map((e) => e.column).sort()).toEqual([
      'amount_inr', 'beneficiary_id', 'purpose_code',
    ])
  })

  it('names the accepted purpose codes when one is wrong', () => {
    const result = parseBatchCsv(`${HEADER}\nben_a,100,MYSTERY,`, opts)
    if (!result.ok) throw new Error('expected rows')
    const row = result.rows[0]!
    expect(!row.ok && row.errors[0]!.fix).toContain('SOFTWARE_SERVICES')
  })

  it('treats a missing external_reference as absent, not invalid', () => {
    const result = parseBatchCsv(`${HEADER}\nben_a,100,SOFTWARE_SERVICES,`, opts)
    if (!result.ok) throw new Error('expected rows')
    expect(result.rows[0]).toMatchObject({ ok: true })
    expect(result.rows[0]!.ok && result.rows[0]!.row.externalReference).toBeNull()
  })

  it('renders an error for a person, with the line first', () => {
    expect(
      describeRowError(42, { column: 'amount_inr', problem: 'the amount is zero', fix: 'enter an amount' }),
    ).toBe('Line 42, column amount_inr: the amount is zero. enter an amount.')
  })
})

describe('the container’s lifecycle', () => {
  it('follows the frozen state sequence', () => {
    // DOMAIN.md § 6.11: DRAFT → VALIDATING → READY → EXECUTING →
    // COMPLETED | PARTIALLY_COMPLETED.
    expect(evaluateBatchTransition(null, 'begin_validation')).toMatchObject({ ok: true, to: 'VALIDATING' })
    expect(evaluateBatchTransition('VALIDATING', 'validated')).toMatchObject({ ok: true, to: 'READY' })
    expect(evaluateBatchTransition('READY', 'begin_execution')).toMatchObject({ ok: true, to: 'EXECUTING' })
    expect(evaluateBatchTransition('EXECUTING', 'all_rows_resolved')).toMatchObject({ ok: true, to: 'COMPLETED' })
    expect(evaluateBatchTransition('EXECUTING', 'some_rows_unresolved'))
      .toMatchObject({ ok: true, to: 'PARTIALLY_COMPLETED' })
  })

  it('adds no edge for the all-invalid case — the existing path covers it', () => {
    // A file of five hundred invalid rows goes VALIDATING → READY → EXECUTING →
    // PARTIALLY_COMPLETED like any other: EXECUTING is the container's phase,
    // and it completes with zero executable rows. A READY → PARTIALLY_COMPLETED
    // shortcut would be a new transition on a frozen machine.
    expect(evaluateBatchTransition('READY', 'some_rows_unresolved')).toMatchObject({ ok: false })
    expect(BATCH_TRANSITIONS.map((t) => t.id)).toEqual(['B01', 'B02', 'B03', 'B04', 'B05'])
    // Every edge the table has is one the frozen state line draws.
    expect(BATCH_TRANSITIONS.map((t) => `${t.from.join('|') || '-'}→${t.to}`)).toEqual([
      '-→VALIDATING',
      'VALIDATING→READY',
      'READY→EXECUTING',
      'EXECUTING→COMPLETED',
      'EXECUTING→PARTIALLY_COMPLETED',
    ])
  })

  it('refuses a transition the sequence does not have', () => {
    expect(evaluateBatchTransition('DRAFT', 'all_rows_resolved')).toMatchObject({ ok: false })
    expect(evaluateBatchTransition('COMPLETED', 'begin_execution')).toMatchObject({ ok: false })
  })

  it('is terminal at COMPLETED and PARTIALLY_COMPLETED, and nowhere else', () => {
    expect(isTerminalBatchStatus('COMPLETED')).toBe(true)
    expect(isTerminalBatchStatus('PARTIALLY_COMPLETED')).toBe(true)
    for (const status of ['DRAFT', 'VALIDATING', 'READY', 'EXECUTING'] as const) {
      expect(isTerminalBatchStatus(status), status).toBe(false)
      expect(BATCH_TRANSITIONS.some((t) => t.from.includes(status)) || status === 'DRAFT').toBe(true)
    }
  })

  it('fires the three batch events the API contract lists', () => {
    expect([...new Set(BATCH_TRANSITIONS.map((t) => t.customerEvent).filter(Boolean))].sort())
      .toEqual(['batch.completed', 'batch.partially_completed', 'batch.validated'])
  })
})

describe('aggregates', () => {
  const row = (outcome: BatchRowOutcome, amountMinor: bigint | null = 100_000n) =>
    ({ outcome, amountMinor })

  it('counts what PRODUCT.md § 10 puts on the screen', () => {
    const counts = aggregate(
      [
        ...Array.from({ length: 139 }, () => row('ACCEPTED')),
        ...Array.from({ length: 4 }, () => row('ACTION_REQUIRED')),
      ],
      'INR',
    )
    expect(counts).toMatchObject({ rowCount: 143, validCount: 143, actionRequiredCount: 4 })
    expect(counts.total.minorUnits).toBe(143n * 100_000n)
  })

  it('leaves invalid rows out of both the valid count and the total', () => {
    // An invalid row has an amount in the file and no settlement in the system.
    // Adding it to the headline would claim money is moving that is not.
    const counts = aggregate([row('ACCEPTED'), row('INVALID', 500_000n)], 'INR')
    expect(counts).toMatchObject({ rowCount: 2, validCount: 1 })
    expect(counts.total.minorUnits).toBe(100_000n)
  })

  it('is COMPLETED only when everything resolved and nothing needs attention', () => {
    expect(terminalOutcome([row('SETTLED'), row('SETTLED')])).toBe('all_rows_resolved')
    // 460 settled and 40 invalid is *partially* completed — the honest answer,
    // and why the frozen state line has two terminal states.
    expect(terminalOutcome([row('SETTLED'), row('INVALID')])).toBe('some_rows_unresolved')
    expect(terminalOutcome([row('SETTLED'), row('ACCEPTED')])).toBeNull()
    expect(terminalOutcome([])).toBeNull()
  })

  it('maps a settlement’s customer state to a row outcome, once', () => {
    // INV-18 allows one projection. This reads it rather than repeating it.
    expect(rowOutcomeFromCustomerStatus('SETTLED', 'SETTLED')).toBe('SETTLED')
    expect(rowOutcomeFromCustomerStatus('ACTION_REQUIRED', 'ACTION_REQUIRED')).toBe('ACTION_REQUIRED')
    expect(rowOutcomeFromCustomerStatus('SETTLING', 'PAYOUT_SUBMITTED')).toBe('ACCEPTED')
    expect(rowOutcomeFromCustomerStatus('READY', 'READY')).toBe('ACCEPTED')
    expect(rowOutcomeFromCustomerStatus('CANCELLED', 'CANCELLED')).toBe('CANCELLED')
    // FAILED has no customer state of its own — it projects to CANCELLED — so
    // the internal status decides, and the batch can still report failures.
    expect(rowOutcomeFromCustomerStatus('CANCELLED', 'FAILED')).toBe('FAILED')
    // A DRAFT settlement has no customer status yet and is still accepted.
    expect(rowOutcomeFromCustomerStatus(null, 'DRAFT')).toBe('ACCEPTED')
    expect(rowOutcomeFromCustomerStatus(null, null)).toBe('INVALID')
  })

  it('knows which outcomes have stopped, and which need somebody', () => {
    expect(['SETTLED', 'FAILED', 'CANCELLED', 'INVALID'].every((o) => isResolvedOutcome(o as BatchRowOutcome))).toBe(true)
    expect(isResolvedOutcome('ACCEPTED')).toBe(false)
    expect(needsAttention('INVALID')).toBe(true)
    expect(needsAttention('ACTION_REQUIRED')).toBe(true)
    expect(needsAttention('SETTLED')).toBe(false)
  })
})

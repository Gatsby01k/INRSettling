/**
 * The batch surfaces — `PRODUCT.md § 10`.
 *
 * Two things are being defended here, and both are about not letting a
 * container's summary hide the rows inside it (`INV-30`).
 */
import { describe, expect, it } from 'vitest'
import {
  batchStatusLabel, presentBatch, presentBatchRow, workList,
  type BatchRowViewInput, type BatchViewInput,
} from './view-models.js'

const batch = (over: Partial<BatchViewInput> = {}): BatchViewInput => ({
  id: 'bat_1',
  name: 'India Contractor Payout — September',
  status: 'READY',
  rowCount: 143,
  validCount: 143,
  actionRequiredCount: 4,
  settledCount: 0,
  failedCount: 0,
  totalMinor: 1_284_000_000n,
  ...over,
})

describe('the summary PRODUCT.md § 10 describes', () => {
  it('renders the two lines from the document', () => {
    const view = presentBatch(batch())
    expect(view.headline).toBe('143 settlements')
    expect(view.totalMinor).toBe(1_284_000_000n)
    expect(view.counts).toEqual([
      { label: 'in progress', count: 139, tone: 'neutral' },
      { label: 'need your input', count: 4, tone: 'attention' },
    ])
  })

  it('counts settlements, not rows', () => {
    // A headline saying "500 settlements" over 460 of them would be wrong, and
    // an invalid row is not a settlement.
    const view = presentBatch(batch({ rowCount: 500, validCount: 460, actionRequiredCount: 0 }))
    expect(view.headline).toBe('460 settlements')
    expect(view.counts).toContainEqual({ label: 'could not be read', count: 40, tone: 'attention' })
  })

  it('says how many rows need a person, and says nothing when none do', () => {
    expect(presentBatch(batch({ rowCount: 500, validCount: 460 })).attention)
      .toBe('44 rows need your attention')
    expect(presentBatch(batch({ actionRequiredCount: 0 })).attention).toBeNull()
  })

  it('gets the singular right', () => {
    const view = presentBatch(batch({ rowCount: 1, validCount: 1, actionRequiredCount: 1 }))
    expect(view.headline).toBe('1 settlement')
    expect(view.attention).toBe('1 row needs your attention')
  })

  it('omits a count that is zero rather than showing a row of noughts', () => {
    const view = presentBatch(batch({ actionRequiredCount: 0, settledCount: 143 }))
    expect(view.counts.map((c) => c.label)).toEqual(['settled'])
  })

  it('never softens PARTIALLY_COMPLETED into "Completed"', () => {
    // 460 of 500 settled is finished *with rows left over*, and hiding the forty
    // is the exact failure INV-30 exists to make visible.
    expect(batchStatusLabel('PARTIALLY_COMPLETED')).toBe('Completed with rows to fix')
    expect(batchStatusLabel('PARTIALLY_COMPLETED')).not.toBe('Completed')
    expect(presentBatch(batch({ status: 'PARTIALLY_COMPLETED' })).finished).toBe(true)
  })

  it('labels every status the machine has', () => {
    for (const status of ['DRAFT', 'VALIDATING', 'READY', 'EXECUTING', 'COMPLETED', 'PARTIALLY_COMPLETED'] as const) {
      expect(batchStatusLabel(status).length, status).toBeGreaterThan(0)
    }
  })
})

describe('the work list', () => {
  const row = (over: Partial<BatchRowViewInput>): BatchRowViewInput => ({
    id: 'brw_1', lineNumber: 2, outcome: 'ACCEPTED', settlementId: 'stl_1',
    errors: [], raw: {}, ...over,
  })

  it('shows one message per problem, naming the column and the fix', () => {
    const view = presentBatchRow(row({
      lineNumber: 42,
      outcome: 'INVALID',
      settlementId: null,
      errors: [
        { column: 'amount_inr', problem: 'the amount is zero', fix: 'enter an amount greater than zero' },
        { column: 'purpose_code', problem: '"X" is not a purpose code we accept', fix: 'use one of: SOFTWARE_SERVICES' },
      ],
    }))
    expect(view.messages).toHaveLength(2)
    expect(view.messages[0]).toBe(
      'Line 42, column amount_inr: the amount is zero. enter an amount greater than zero.',
    )
    expect(view.needsAttention).toBe(true)
  })

  it('puts the rows with a fix the customer can apply now first', () => {
    // Invalid rows are an edit-and-re-upload; ACTION_REQUIRED is a longer
    // errand. Sorting the quick wins first is the difference between a list
    // somebody clears and one they abandon.
    const rows = [
      row({ id: 'a', lineNumber: 9, outcome: 'ACTION_REQUIRED' }),
      row({ id: 'b', lineNumber: 7, outcome: 'INVALID', settlementId: null, errors: [{ column: null, problem: 'p', fix: 'f' }] }),
      row({ id: 'c', lineNumber: 3, outcome: 'INVALID', settlementId: null, errors: [{ column: null, problem: 'p', fix: 'f' }] }),
      row({ id: 'd', lineNumber: 2, outcome: 'SETTLED' }),
    ]
    expect(workList(rows).map((r) => r.id)).toEqual(['c', 'b', 'a'])
  })

  it('leaves rows that are getting on with it out of the list', () => {
    const rows = [row({ id: 'x', outcome: 'ACCEPTED' }), row({ id: 'y', outcome: 'SETTLED' })]
    expect(workList(rows)).toEqual([])
  })
})

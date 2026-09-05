/**
 * View models for the batch surfaces — `PRODUCT.md § 10`.
 *
 * The section is short and the screen it describes is shorter:
 *
 * ```
 * India Contractor Payout — September
 *
 * 143 settlements        ₹12,840,000
 * 139 READY               4 ACTION_REQUIRED
 * ```
 *
 * Two lines, and the second is the one that matters: *"Invalid or incomplete
 * rows must never block valid ones. The batch shows an aggregate; the
 * settlements inside it keep their own independent lifecycles."*
 *
 * So this file presents a **summary and a work list**, and deliberately not a
 * progress bar. A bar implies a single thing advancing toward a single
 * completion, which is what a batch is not (`INV-30`) — and it would make the
 * forty rows that need a person look like a percentage rather than like forty
 * rows with forty fixes.
 */
import type { StatusTone } from '@inrsettle/ui'
import type { BatchRowOutcome, BatchStatus, RowError } from '@inrsettle/domain/browser'
import { describeRowError, needsAttention } from '@inrsettle/domain/browser'

export interface BatchViewInput {
  id: string
  name: string
  status: BatchStatus
  rowCount: number
  validCount: number
  actionRequiredCount: number
  settledCount: number
  failedCount: number
  totalMinor: bigint
}

export interface BatchPresentation {
  id: string
  name: string
  /** "143 settlements" — the valid ones, because those are what will move. */
  headline: string
  totalMinor: bigint
  /** The second line: what is where. Only non-zero counts appear. */
  counts: readonly { label: string; count: number; tone: BatchCountTone }[]
  /** Present only when rows need a person, and it says how many. */
  attention: string | null
  /** What the batch itself is doing, in the customer's words. */
  statusLabel: string
  finished: boolean
}

export type BatchCountTone = 'neutral' | 'attention' | 'good'

/**
 * The batch's own status, said plainly.
 *
 * `PARTIALLY_COMPLETED` is the interesting one and it must not be softened. A
 * batch where 460 of 500 settled is *finished with rows left over*, and calling
 * that "Completed" would hide the forty rows the customer still has to deal
 * with — which is the exact failure `INV-30` exists to make visible.
 */
export function batchStatusLabel(status: BatchStatus): string {
  switch (status) {
    case 'DRAFT': return 'Draft'
    case 'VALIDATING': return 'Checking rows'
    case 'READY': return 'Ready to authorize'
    case 'EXECUTING': return 'Settling'
    case 'COMPLETED': return 'Completed'
    case 'PARTIALLY_COMPLETED': return 'Completed with rows to fix'
  }
}

export function presentBatch(input: BatchViewInput): BatchPresentation {
  const counts: { label: string; count: number; tone: BatchCountTone }[] = []
  const running = input.validCount - input.settledCount - input.failedCount - input.actionRequiredCount
  const invalid = input.rowCount - input.validCount

  if (running > 0) counts.push({ label: 'in progress', count: running, tone: 'neutral' })
  if (input.settledCount > 0) counts.push({ label: 'settled', count: input.settledCount, tone: 'good' })
  if (input.actionRequiredCount > 0) {
    counts.push({ label: 'need your input', count: input.actionRequiredCount, tone: 'attention' })
  }
  if (invalid > 0) counts.push({ label: 'could not be read', count: invalid, tone: 'attention' })
  if (input.failedCount > 0) counts.push({ label: 'failed', count: input.failedCount, tone: 'attention' })

  const needing = input.actionRequiredCount + invalid

  return {
    id: input.id,
    name: input.name,
    // The valid count, not the row count: an invalid row is not a settlement,
    // and a headline saying "500 settlements" over 460 of them would be wrong.
    headline: `${input.validCount} ${input.validCount === 1 ? 'settlement' : 'settlements'}`,
    totalMinor: input.totalMinor,
    counts,
    attention:
      needing === 0
        ? null
        : `${needing} ${needing === 1 ? 'row needs' : 'rows need'} your attention`,
    statusLabel: batchStatusLabel(input.status),
    finished: input.status === 'COMPLETED' || input.status === 'PARTIALLY_COMPLETED',
  }
}

/* ── The work list ──────────────────────────────────────────────────────── */

export interface BatchRowViewInput {
  id: string
  lineNumber: number
  outcome: BatchRowOutcome
  settlementId: string | null
  errors: readonly RowError[]
  raw: Readonly<Record<string, string>>
}

export interface BatchRowPresentation {
  id: string
  lineNumber: number
  outcome: BatchRowOutcome
  settlementId: string | null
  tone: StatusTone | 'attention' | 'resolved'
  /** One line per problem, each naming the column and the fix. */
  messages: readonly string[]
  needsAttention: boolean
}

/**
 * A row, ready to render.
 *
 * The messages come from `describeRowError` in the domain, so the screen, the
 * API and a downloaded error report say the same sentence. A customer who reads
 * one message on screen and a different one in an export has to work out which
 * is true, and the answer is usually neither.
 */
export function presentBatchRow(input: BatchRowViewInput): BatchRowPresentation {
  return {
    id: input.id,
    lineNumber: input.lineNumber,
    outcome: input.outcome,
    settlementId: input.settlementId,
    tone: needsAttention(input.outcome) ? 'attention' : 'resolved',
    messages: input.errors.map((e) => describeRowError(input.lineNumber, e)),
    needsAttention: needsAttention(input.outcome),
  }
}

/**
 * The rows a person has to do something about, worst first.
 *
 * Invalid rows lead, because they have a fix the customer can apply right now —
 * edit the cell, re-upload. An `ACTION_REQUIRED` settlement needs a document or
 * a corrected beneficiary and is a longer errand. Sorting the quick wins first
 * is not cosmetic: it is the difference between a work list somebody clears and
 * one they abandon.
 */
export function workList(rows: readonly BatchRowViewInput[]): readonly BatchRowPresentation[] {
  return rows
    .filter((r) => needsAttention(r.outcome))
    .sort((a, b) => {
      if (a.outcome !== b.outcome) return a.outcome === 'INVALID' ? -1 : 1
      return a.lineNumber - b.lineNumber
    })
    .map(presentBatchRow)
}

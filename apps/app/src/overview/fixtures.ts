/**
 * Design fixtures for Overview.
 *
 * Two workspaces, because § 12.1 describes two genuinely different pages: one
 * with a facility and traffic, and one that *"can exist before a facility is
 * provisioned"* and simply has no **Available to settle** figure. The second is
 * what a customer sees on their first morning, and it is the one a design that
 * only ever renders the happy path gets wrong.
 */
import { money } from '@inrsettle/money'
import { presentSettlement } from '../settlements/view-models.js'
import type { SettlementRow } from '../settlements/view-models.js'
import { presentOverview, type OverviewInput, type OverviewPresentation } from './view-models.js'

function row(
  id: string,
  beneficiaryName: string,
  minor: bigint,
  input: Parameters<typeof presentSettlement>[0],
): SettlementRow {
  return {
    id,
    reference: id.replace('set_', 'REF-'),
    beneficiaryName,
    recipientAmountMinor: minor,
    createdAt: new Date('2026-03-11T09:30:00Z'),
    presentation: presentSettlement(input),
  }
}

export const ACTIVE_ROWS: SettlementRow[] = [
  row('set_aarti', 'Aarti Sharma', 500000000n, {
    status: 'PAYOUT_SUBMITTED',
    pointOfNoReturnAt: new Date('2026-03-11T09:31:00Z'),
    cancellationRequestedAt: null,
  }),
  row('set_vertex', 'Vertex Software Pvt Ltd', 128000000n, {
    status: 'LIQUIDITY_RESERVED',
    pointOfNoReturnAt: null,
    cancellationRequestedAt: null,
  }),
  row('set_meridian', 'Meridian Exports', 74500000n, {
    status: 'READY',
    pointOfNoReturnAt: null,
    cancellationRequestedAt: null,
  }),
]

export const EXCEPTION_ROWS: SettlementRow[] = [
  row('set_stalled', 'Kavya Industries', 250000000n, {
    status: 'EXCEPTION',
    // Customer-actionable: a destination the bank rejected is something only
    // the customer can fix, so it belongs in "needs your attention".
    openExceptionCode: 'PAYOUT_REJECTED_DESTINATION',
    pointOfNoReturnAt: null,
    cancellationRequestedAt: null,
    beneficiaryId: 'ben_kavya',
  }),
]

/** A workspace with a facility, traffic, and one thing to do. */
export const BUSY: OverviewInput = {
  availableToSettle: money('USDT', 4500000000n),
  inFlightCount: 2,
  settledToday: money('INR', 1250000000n),
  settledTodayCount: 4,
  needsAttentionCount: 1,
  activeSettlements: ACTIVE_ROWS,
  openExceptions: EXCEPTION_ROWS,
}

/**
 * Day one: no facility, nothing sent.
 *
 * `availableToSettle: null` is the case the metric type exists to carry — a
 * workspace that has not been set up for settlement yet, which is not the same
 * as one that has run out of capacity.
 */
export const ONBOARDING: OverviewInput = {
  availableToSettle: null,
  inFlightCount: 0,
  settledToday: money('INR', 0n),
  settledTodayCount: 0,
  needsAttentionCount: 0,
  activeSettlements: [],
  openExceptions: [],
}

/** A facility exists, but nothing is moving today. */
export const QUIET: OverviewInput = {
  availableToSettle: money('USDT', 4500000000n),
  inFlightCount: 0,
  settledToday: money('INR', 0n),
  settledTodayCount: 0,
  needsAttentionCount: 0,
  activeSettlements: [],
  openExceptions: [],
}

export const BUSY_VIEW: OverviewPresentation = presentOverview(BUSY)
export const ONBOARDING_VIEW: OverviewPresentation = presentOverview(ONBOARDING)
export const QUIET_VIEW: OverviewPresentation = presentOverview(QUIET)

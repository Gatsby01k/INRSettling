/**
 * Fixtures for the Stage 3 settlement surfaces.
 *
 * These are **design fixtures**, not claims. Stage 3 has no payout execution
 * and no finality, so a `SETTLED` fixture exists purely so the finished state
 * can be designed and tested; nothing in the running product can reach it. The
 * provisional notice below travels with every quote fixture for the same
 * reason — `D-08` and `D-09` are open, and sandbox pricing must never read as a
 * commercial commitment.
 */
import { money } from '@inrsettle/money'
import type { BeneficiaryOption } from '@inrsettle/ui'
import type { Requirement } from '@inrsettle/domain/browser'
import {
  presentSettlement,
  returnNotice,
  settlementTimeline,
  type ReturnNoticeView,
  type SettlementPresentation,
  type TimelineEventInput,
  type TimelineRow,
} from './view-models.js'
import type { QuoteView } from './surfaces.js'

export const SANDBOX_PRICING_NOTICE =
  'Sandbox pricing. These rates and fees are deterministic test values, not a commercial quote.'

export const BENEFICIARIES: BeneficiaryOption[] = [
  {
    id: 'ben_aarti',
    displayName: 'Aarti Sharma',
    destinationSummary: 'HDFC •••• 6789',
    verification: { tone: 'settled', label: 'Verified' },
  },
  {
    id: 'ben_vertex',
    displayName: 'Vertex Software Pvt Ltd',
    destinationSummary: 'ICIC •••• 0099',
    verification: { tone: 'ready', label: 'Not verified yet' },
  },
]

export const PURPOSES = [
  { code: 'SOFTWARE_SERVICES', label: 'Software services' },
  { code: 'PROFESSIONAL_FEES', label: 'Professional or consultancy fees' },
  { code: 'GOODS_EXPORT', label: 'Export of goods' },
]

export const FUNDING_CURRENCIES = ['USDT', 'USD', 'EUR'] as const

/** ₹50,00,000 recipient-first at the sandbox USDT rate. */
export const QUOTE: QuoteView = {
  recipientAmount: money('INR', 500_000_000n),
  fundingAmount: money('USDT', 60_240_964n),
  fxRate: '83.0000000000',
  fxPair: 'USDT/INR',
  fees: [{ code: 'platform_fee', label: 'Platform fee', amount: money('USDT', 301_205n) }],
  estimatedDelivery: 'under 30 minutes',
  expiresInSeconds: 143,
}

export const INVOICE_REQUIREMENT: Requirement = {
  code: 'invoice_required',
  severity: 'blocking',
  title: 'Invoice is required for this settlement',
  detail:
    'Settlements of ₹50,00,000.00 for Software services need a commercial invoice before we can send them.',
  action: { type: 'upload_document', documentType: 'commercial_invoice' },
}

/**
 * Presentations built by running the *real* projection, so a fixture can never
 * drift from what the domain would produce for the same internal state.
 */
export const READY: SettlementPresentation = presentSettlement({
  status: 'QUOTED',
  pointOfNoReturnAt: null,
  cancellationRequestedAt: null,
})

export const SETTLING: SettlementPresentation = presentSettlement({
  status: 'AUTHORIZED',
  pointOfNoReturnAt: null,
  cancellationRequestedAt: null,
})

export const SETTLING_PAST_PONR: SettlementPresentation = presentSettlement({
  status: 'PAYOUT_SUBMITTED',
  pointOfNoReturnAt: new Date('2026-09-02T10:00:00Z'),
  cancellationRequestedAt: null,
})

export const CANCELLATION_REQUESTED: SettlementPresentation = presentSettlement({
  status: 'DRAWDOWN_CONFIRMED',
  pointOfNoReturnAt: null,
  cancellationRequestedAt: new Date('2026-09-02T09:59:00Z'),
})

export const DELAYED: SettlementPresentation = presentSettlement({
  status: 'EXCEPTION',
  openExceptionCode: 'PAYOUT_STATUS_UNKNOWN',
  pointOfNoReturnAt: new Date('2026-09-02T10:00:00Z'),
  cancellationRequestedAt: null,
})

export const ACTION_REQUIRED: SettlementPresentation = presentSettlement({
  status: 'EXCEPTION',
  openExceptionCode: 'PAYOUT_REJECTED_DESTINATION',
  pointOfNoReturnAt: new Date('2026-09-02T10:00:00Z'),
  cancellationRequestedAt: null,
  beneficiaryId: 'ben_aarti',
})

export const CANCELLED: SettlementPresentation = presentSettlement({
  status: 'CANCELLED',
  pointOfNoReturnAt: null,
  cancellationRequestedAt: null,
  resolutionCode: 'cancelled_by_customer',
})

/**
 * D-03 closed: this projects to the same customer state as CANCELLED, and the
 * resolution reason is what tells the customer what actually happened.
 */
export const FAILED: SettlementPresentation = presentSettlement({
  status: 'FAILED',
  pointOfNoReturnAt: null,
  cancellationRequestedAt: null,
  resolutionCode: 'provider_rejected',
})

/**
 * Design-only. Stage 3 cannot reach `SETTLED` — finality is Stage 6 — and this
 * exists so the finished state can be designed rather than discovered late.
 */
export const SETTLED_DESIGN_ONLY: SettlementPresentation = presentSettlement({
  status: 'SETTLED',
  pointOfNoReturnAt: new Date('2026-09-02T10:00:00Z'),
  cancellationRequestedAt: null,
})

export const DETAIL_BASE = {
  reference: 'stl_2Rn8Kq5TzYw6',
  recipientAmount: money('INR', 500_000_000n),
  beneficiaryName: 'Aarti Sharma',
  destinationSummary: 'HDFC •••• 6789',
  createdAt: new Date('2026-09-02T09:30:00Z'),
}

/* ── Stage 10 — the § 12.3 additions ─────────────────────────────────────── */

/**
 * The timeline § 12.3 prints, from the events that actually produce it.
 *
 * Times are chosen so the IST rendering matches the document's example:
 * `14:02:11 IST` is `08:32:11Z`.
 */
export const TIMELINE_EVENTS: readonly TimelineEventInput[] = [
  { status: 'READY', at: new Date('2026-09-02T08:32:11Z') },
  { status: 'LIQUIDITY_RESERVED', at: new Date('2026-09-02T08:32:14Z') },
  {
    status: 'PAYOUT_CONFIRMED',
    at: new Date('2026-09-02T08:33:47Z'),
    utr: '2026083112345678',
  },
  {
    status: 'SETTLED',
    at: new Date('2026-09-02T08:33:52Z'),
    expectedMinor: 500_000_000n,
    observedMinor: 500_000_000n,
  },
]

export const TIMELINE: readonly TimelineRow[] = settlementTimeline(TIMELINE_EVENTS)

/** A settled payment the receiving bank sent back. */
export const RETURN_CONFIRMED: ReturnNoticeView = returnNotice({
  id: 'ret_01JBQ8Z3N7',
  status: 'CONFIRMED',
  amountMinor: 500_000_000n,
  reasonCode: 'RAIL_REVERSAL',
  observedAt: new Date('2026-09-03T06:15:00Z'),
})

/** The same return, once the money is actually back. */
export const RETURN_REPAID: ReturnNoticeView = returnNotice({
  id: 'ret_01JBQ8Z3N7',
  status: 'REPAID',
  amountMinor: 500_000_000n,
  reasonCode: 'RAIL_REVERSAL',
  observedAt: new Date('2026-09-03T06:15:00Z'),
})

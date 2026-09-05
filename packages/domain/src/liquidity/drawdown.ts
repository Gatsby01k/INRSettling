/**
 * Drawdown — the funding leg, `DOMAIN.md § 6.6`, and the settlement rows
 * T12–T14, T29 that drive it.
 *
 * A drawdown has no separate lettered table in the frozen document because its
 * lifecycle *is* the settlement's: T12 requests it, T13 confirms it, T14 fails
 * it and T29 times it out. What the drawdown record adds is the provider-side
 * identity — a reference and a status that can be pulled — so this table is the
 * drawdown's own view of those same four rows rather than a fifth machine.
 *
 * `UNKNOWN` behaves exactly as it does on a payout attempt and a repayment: it
 * is not terminal, it is resolved by an authoritative status pull, and it is
 * never resolved by resubmitting. T29's frozen guard says so in as many words —
 * *"Never resubmit blindly"* — and the reason is the same each time. A drawdown
 * we are unsure about may have moved real money; asking again is free, and
 * asking for it again is not.
 */

export const DRAWDOWN_STATUSES = ['REQUESTED', 'CONFIRMED', 'FAILED', 'UNKNOWN'] as const
export type DrawdownStatus = (typeof DRAWDOWN_STATUSES)[number]

export const TERMINAL_DRAWDOWN_STATUSES: readonly DrawdownStatus[] = ['CONFIRMED', 'FAILED']

export function isDrawdownTerminal(status: DrawdownStatus): boolean {
  return TERMINAL_DRAWDOWN_STATUSES.includes(status)
}

export const DRAWDOWN_TRIGGERS = [
  'request',
  'confirmed',
  'failed',
  'sla_elapsed',
  'pull_resolved_confirmed',
  'pull_resolved_failed',
] as const
export type DrawdownTrigger = (typeof DRAWDOWN_TRIGGERS)[number]

export interface DrawdownTransition {
  readonly id: string
  readonly from: readonly DrawdownStatus[]
  readonly trigger: DrawdownTrigger
  readonly to: DrawdownStatus
  /** The settlement transition this corresponds to, so the two cannot drift. */
  readonly settlementTransition: 'T12' | 'T13' | 'T14' | 'T29' | null
  readonly guard: string
}

export const DRAWDOWN_TRANSITIONS: readonly DrawdownTransition[] = [
  {
    id: 'W01',
    from: [],
    trigger: 'request',
    to: 'REQUESTED',
    settlementTransition: 'T12',
    guard: 'ACTIVE reservation exists; no cancellation pending at the checkpoint',
  },
  {
    id: 'W02',
    from: ['REQUESTED'],
    trigger: 'confirmed',
    to: 'CONFIRMED',
    settlementTransition: 'T13',
    guard: 'provider event verified and idempotent; consumes the reservation (V02)',
  },
  {
    id: 'W03',
    from: ['REQUESTED'],
    trigger: 'failed',
    to: 'FAILED',
    settlementTransition: 'T14',
    guard: 'verified failure event; releases the reservation (V03)',
  },
  {
    id: 'W04',
    from: ['REQUESTED'],
    trigger: 'sla_elapsed',
    to: 'UNKNOWN',
    settlementTransition: 'T29',
    guard: 'no terminal drawdown status within SLA — drawdown watcher. Never resubmit blindly',
  },
  {
    id: 'W05',
    from: ['UNKNOWN'],
    trigger: 'pull_resolved_confirmed',
    to: 'CONFIRMED',
    settlementTransition: null,
    guard: 'authoritative status pull only, never a resubmit',
  },
  {
    id: 'W06',
    from: ['UNKNOWN'],
    trigger: 'pull_resolved_failed',
    to: 'FAILED',
    settlementTransition: null,
    guard: 'authoritative status pull only',
  },
]

export type DrawdownEvaluation =
  | { readonly ok: true; readonly id: string; readonly to: DrawdownStatus }
  | { readonly ok: false; readonly error: 'invalid_transition' }

export function evaluateDrawdownTransition(
  from: DrawdownStatus | null,
  trigger: DrawdownTrigger,
): DrawdownEvaluation {
  const match = DRAWDOWN_TRANSITIONS.find(
    (t) => t.trigger === trigger && (from === null ? t.from.length === 0 : t.from.includes(from)),
  )
  if (!match) return { ok: false, error: 'invalid_transition' }
  return { ok: true, id: match.id, to: match.to }
}

/** Same shape and same reasoning as `INV-25`: stable per drawdown, never per call. */
export const DRAWDOWN_FINGERPRINT_VERSION = 'v1'

export function drawdownFingerprint(drawdownId: string): string {
  return `drawdown:${DRAWDOWN_FINGERPRINT_VERSION}:${drawdownId}`
}

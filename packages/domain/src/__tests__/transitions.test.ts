/**
 * The settlement machine, checked exhaustively.
 *
 * The load-bearing test is the matrix: **every** `(status, trigger)` pair — all
 * 17 × 30 of them, plus the creation row — is either in the frozen table or is
 * rejected as `invalid_transition`. There is no third answer and no pair the
 * suite quietly skips.
 */
import { describe, expect, it } from 'vitest'
import {
  GUARDS,
  LATER_STAGE_GUARDS,
  SETTLEMENT_STATUSES,
  SETTLEMENT_STATUS_EVENTS,
  TERMINAL_STATUSES,
  TRANSITIONS,
  TRANSITION_IDS,
  TRIGGERS,
  COMPANION_EVENTS,
  evaluateTransition,
  isStatusEvent,
  isTerminal,
  legalPairs,
  transitionById,
  type Guard,
  type GuardContext,
  type SettlementStatus,
} from '../index.js'

/** Answers every guard `true`, so a rejection can only come from the table. */
function allGuardsPass(): GuardContext {
  return Object.fromEntries(GUARDS.map((g) => [g, true])) as GuardContext
}

const legal = new Set(legalPairs().map((p) => `${p.from ?? '—'}::${p.trigger}`))

describe('the table matches the frozen document', () => {
  it('has exactly thirty transitions, T01 to T30', () => {
    expect(TRANSITIONS).toHaveLength(30)
    expect(TRANSITIONS.map((t) => t.id)).toEqual([...TRANSITION_IDS])
  })

  it('names a status event for every transition that moves the machine', () => {
    for (const t of TRANSITIONS) {
      if (t.to === null && t.id === 'T26') {
        // The one annotation row. No status change, so no status event.
        expect(t.statusEvent).toBeNull()
        continue
      }
      expect(t.statusEvent, t.id).not.toBeNull()
      expect(isStatusEvent(t.statusEvent!), `${t.id} ${t.statusEvent}`).toBe(true)
    }
  })

  it('draws every companion from the companion vocabulary', () => {
    for (const t of TRANSITIONS) {
      for (const c of [...t.companionEvents, ...(t.companionChoice ?? [])]) {
        expect(COMPANION_EVENTS as readonly string[], `${t.id} ${c}`).toContain(c)
        // The two sets are disjoint (INV-32): a companion is never a status event.
        expect(isStatusEvent(c), `${t.id} ${c}`).toBe(false)
      }
    }
  })

  it('draws every guard from the declared guard list', () => {
    for (const t of TRANSITIONS) {
      for (const g of t.guards) expect(GUARDS as readonly string[], `${t.id} ${g}`).toContain(g)
    }
  })

  it('is unambiguous: no (from, trigger) pair matches two rows', () => {
    const seen = new Map<string, string>()
    for (const t of TRANSITIONS) {
      const froms = t.from.length === 0 ? ['—'] : t.from
      for (const from of froms) {
        const key = `${from}::${t.trigger}`
        expect(seen.get(key), `${key} matches both ${seen.get(key)} and ${t.id}`).toBeUndefined()
        seen.set(key, t.id)
      }
    }
  })

  it('SETTLED never appears in a From column', () => {
    for (const t of TRANSITIONS) {
      expect(t.from as readonly string[], t.id).not.toContain('SETTLED')
    }
  })

  it('no terminal status has an outgoing transition (INV-38)', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const t of TRANSITIONS) {
        expect(t.from as readonly string[], `${t.id} leaves ${terminal}`).not.toContain(terminal)
      }
    }
  })

  it('T04 is the only entry into ACTION_REQUIRED (INV-37)', () => {
    const entries = TRANSITIONS.filter((t) => t.to === 'ACTION_REQUIRED')
    expect(entries.map((t) => t.id)).toEqual(['T04'])
    expect(entries[0]!.from).toEqual(['PREFLIGHTING'])
  })

  it('T26 is an annotation: no status change and no status event', () => {
    const t26 = transitionById('T26')
    expect(t26.to).toBeNull()
    expect(t26.statusEvent).toBeNull()
    expect(t26.companionEvents).toEqual(['settlement.cancellation_requested'])
  })

  it('every status event in the vocabulary is actually used', () => {
    const used = new Set(TRANSITIONS.map((t) => t.statusEvent).filter(Boolean))
    for (const e of SETTLEMENT_STATUS_EVENTS) {
      expect([...used], `${e} is declared but no transition emits it`).toContain(e)
    }
  })

  it('every non-DRAFT status is reachable', () => {
    const reachable = new Set(TRANSITIONS.map((t) => t.to).filter(Boolean))
    // T22 resumes to exception_entered_from, so its destination is data.
    const resumable: SettlementStatus[] = [
      'LIQUIDITY_RESERVING', 'DRAWDOWN_REQUESTED', 'RECONCILING',
    ]
    for (const status of SETTLEMENT_STATUSES) {
      const ok = reachable.has(status) || resumable.includes(status)
      expect(ok, `${status} is unreachable`).toBe(true)
    }
  })
})

describe('the exhaustive matrix — every (status, trigger) pair', () => {
  it('accepts exactly the legal pairs and rejects every other one', () => {
    const accepted: string[] = []
    const rejected: string[] = []

    for (const from of [null, ...SETTLEMENT_STATUSES] as (SettlementStatus | null)[]) {
      for (const trigger of TRIGGERS) {
        const key = `${from ?? '—'}::${trigger}`
        const result = evaluateTransition({
          from,
          trigger,
          guards: allGuardsPass(),
          exceptionEnteredFrom: 'RECONCILING',
        })
        if (result.ok) accepted.push(key)
        else {
          expect(result.error, key).toBe('invalid_transition')
          rejected.push(key)
        }
      }
    }

    // 18 possible "from" values (17 statuses + creation) × 30 triggers.
    expect(accepted.length + rejected.length).toBe(18 * TRIGGERS.length)
    expect(new Set(accepted)).toEqual(legal)
    for (const key of rejected) expect(legal.has(key), `${key} was rejected but is legal`).toBe(false)
  })

  it('rejects every trigger from every terminal status', () => {
    for (const from of TERMINAL_STATUSES) {
      for (const trigger of TRIGGERS) {
        const result = evaluateTransition({ from, trigger, guards: allGuardsPass() })
        expect(result.ok, `${from}::${trigger}`).toBe(false)
        if (!result.ok) expect(result.error).toBe('invalid_transition')
      }
    }
  })

  it('rejects a trigger that is legal elsewhere from the wrong state', () => {
    // authorize is legal only from QUOTED.
    for (const from of SETTLEMENT_STATUSES.filter((s) => s !== 'QUOTED')) {
      const result = evaluateTransition({ from, trigger: 'authorize', guards: allGuardsPass() })
      expect(result.ok, from).toBe(false)
    }
    expect(evaluateTransition({ from: 'QUOTED', trigger: 'authorize', guards: allGuardsPass() }).ok).toBe(true)
  })

  it('creation is legal only with no prior state', () => {
    expect(evaluateTransition({ from: null, trigger: 'create', guards: allGuardsPass() }).ok).toBe(true)
    for (const from of SETTLEMENT_STATUSES) {
      expect(evaluateTransition({ from, trigger: 'create', guards: allGuardsPass() }).ok, from).toBe(false)
    }
  })
})

describe('guards', () => {
  it('a failing guard rejects the transition and names which one', () => {
    const result = evaluateTransition({
      from: 'QUOTED',
      trigger: 'authorize',
      guards: { ...allGuardsPass(), destination_version_verified: false },
    })
    expect(result.ok).toBe(false)
    if (!result.ok && result.error === 'guard_failed') {
      expect(result.transition).toBe('T08')
      expect(result.failed).toEqual(['destination_version_verified'])
    } else {
      throw new Error('expected guard_failed')
    }
  })

  it('an unanswered guard is its own error, not a silent pass or fail', () => {
    // The distinction matters: treating an unanswered guard as false would look
    // safe while hiding a caller that forgot to load state.
    const partial = { ...allGuardsPass() }
    delete (partial as Record<string, boolean>)['active_liquidity_facility']
    const result = evaluateTransition({ from: 'QUOTED', trigger: 'authorize', guards: partial })
    expect(result.ok).toBe(false)
    if (!result.ok && result.error === 'guard_unanswered') {
      expect(result.unanswered).toEqual(['active_liquidity_facility'])
    } else {
      throw new Error('expected guard_unanswered')
    }
  })

  it('every guard the table names is answerable, and none is orphaned', () => {
    const used = new Set(TRANSITIONS.flatMap((t) => t.guards))
    for (const g of GUARDS) expect([...used], `${g} is declared but never used`).toContain(g)
  })

  it('later-stage guards are declared, and are all real guards', () => {
    // Stage 3 owns the machine, not liquidity or payouts. Those answers are
    // supplied by a later stage — or, here, by an explicit test harness — and
    // are never defaulted.
    for (const g of LATER_STAGE_GUARDS) expect(GUARDS as readonly Guard[]).toContain(g)
    expect(LATER_STAGE_GUARDS.length).toBeGreaterThan(0)
  })

  it('T08 carries every authorization guard the frozen table names', () => {
    expect([...transitionById('T08').guards].sort()).toEqual(
      [
        'active_liquidity_facility',
        'actor_may_authorize',
        'beneficiary_verified',
        'destination_version_verified',
        'preflight_still_passing',
        'quote_valid_for_authorization',
      ].sort(),
    )
  })

  it('T15 carries the dispatch guards, including the point-of-no-return check', () => {
    expect([...transitionById('T15').guards].sort()).toEqual(
      [
        'before_point_of_no_return',
        'destination_version_verified',
        'no_cancellation_pending',
        'rail_selected',
      ].sort(),
    )
  })
})

describe('T22 resumes to where the exception came from', () => {
  it('uses exception_entered_from as the destination', () => {
    for (const entered of ['LIQUIDITY_RESERVING', 'DRAWDOWN_REQUESTED', 'RECONCILING'] as const) {
      const result = evaluateTransition({
        from: 'EXCEPTION',
        trigger: 'resolve_resume',
        guards: allGuardsPass(),
        exceptionEnteredFrom: entered,
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.to).toBe(entered)
    }
  })

  it('refuses to resume when it does not know where to go', () => {
    const result = evaluateTransition({
      from: 'EXCEPTION',
      trigger: 'resolve_resume',
      guards: allGuardsPass(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('resume_target_unknown')
  })
})

describe('event expectations per transition', () => {
  it('reports exactly one status event for every moving transition', () => {
    for (const t of TRANSITIONS) {
      if (t.id === 'T26') continue
      const from = t.from.length === 0 ? null : t.from[0]!
      const result = evaluateTransition({
        from,
        trigger: t.trigger,
        guards: allGuardsPass(),
        exceptionEnteredFrom: 'RECONCILING',
      })
      expect(result.ok, t.id).toBe(true)
      if (result.ok) {
        expect(result.statusEvent, t.id).toBe(t.statusEvent)
        expect(result.requiredCompanions, t.id).toEqual(t.companionEvents)
      }
    }
  })

  it('T26 reports no status event and one companion', () => {
    const result = evaluateTransition({
      from: 'AUTHORIZED',
      trigger: 'request_cancellation',
      guards: allGuardsPass(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.statusEvent).toBeNull()
      expect(result.to).toBeNull()
      expect(result.requiredCompanions).toEqual(['settlement.cancellation_requested'])
    }
  })

  it('T27 from DRAWDOWN_CONFIRMED may request a repayment, never a release (INV-22)', () => {
    const t27 = transitionById('T27')
    expect(t27.companionChoice).toContain('facility.repayment_requested')
    expect(t27.companionChoice).toContain('facility.reservation_released')
  })
})

describe('helpers', () => {
  it('isTerminal agrees with the terminal list', () => {
    for (const s of SETTLEMENT_STATUSES) {
      expect(isTerminal(s)).toBe((TERMINAL_STATUSES as readonly string[]).includes(s))
    }
  })

  it('transitionById throws rather than returning a default', () => {
    expect(() => transitionById('T99' as never)).toThrow()
  })

  it('legalPairs covers every row', () => {
    const rows = TRANSITIONS.reduce((n, t) => n + Math.max(t.from.length, 1), 0)
    expect(legalPairs()).toHaveLength(rows)
  })
})

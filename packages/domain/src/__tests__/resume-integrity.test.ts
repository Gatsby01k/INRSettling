/**
 * T22 resume integrity, at the layer where the destination is chosen.
 *
 * T22 is the one transition whose destination is *data*: it resumes to wherever
 * the settlement was when the exception opened. That is the right design — the
 * alternative is nine near-identical static rows that drift — but it means the
 * recorded origin is effectively a jump target, and a jump target that a caller
 * can supply is not a state machine.
 *
 * The database tests prove the field cannot be *written* freely. These prove the
 * complementary half: even given a value, the machine will not resume to
 * somewhere it should never go.
 */
import { describe, expect, it } from 'vitest'
import {
  SETTLEMENT_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  RECONCILIATION_TRANSITIONS,
  deferredCompanions,
  deferredCompanionsFor,
  evaluateTransition,
  type SettlementStatus,
} from '../index.js'

const RESUMABLE: readonly SettlementStatus[] = [
  'LIQUIDITY_RESERVING',
  'LIQUIDITY_RESERVED',
  'DRAWDOWN_REQUESTED',
  'PAYOUT_SUBMITTED',
  'RECONCILING',
]

const resume = (exceptionEnteredFrom?: SettlementStatus) =>
  evaluateTransition({
    from: 'EXCEPTION',
    trigger: 'resolve_resume',
    guards: { resolution_attributed: true },
    ...(exceptionEnteredFrom ? { exceptionEnteredFrom } : {}),
  })

describe('T22 resumes to the recorded origin and nowhere else', () => {
  it('has no static destination of its own', () => {
    // If T22 ever grows a `to`, the dynamic model has quietly been replaced and
    // every resume goes to one place regardless of where it came from.
    const t22 = TRANSITIONS.find((t) => t.id === 'T22')!
    expect(t22.to).toBeNull()
    expect(t22.from).toEqual(['EXCEPTION'])
  })

  it('refuses to resume when no origin was recorded', () => {
    // Not "resume to READY", not "resume to the first legal state". An
    // exception with no recorded origin is a bug, and guessing would turn it
    // into a payment.
    expect(resume()).toMatchObject({ ok: false, error: 'resume_target_unknown', transition: 'T22' })
  })

  it('resumes to exactly the recorded origin, for every legitimate origin', () => {
    for (const origin of RESUMABLE) {
      expect(resume(origin)).toMatchObject({ ok: true, to: origin })
    }
  })

  it('requires an attributed resolution before it will resume at all', () => {
    // A resume with nobody's name on it is how an exception becomes a shrug.
    expect(
      evaluateTransition({
        from: 'EXCEPTION',
        trigger: 'resolve_resume',
        guards: {},
        exceptionEnteredFrom: 'DRAWDOWN_REQUESTED',
      }),
    ).toMatchObject({ ok: false, error: 'guard_unanswered' })

    expect(
      evaluateTransition({
        from: 'EXCEPTION',
        trigger: 'resolve_resume',
        guards: { resolution_attributed: false },
        exceptionEnteredFrom: 'DRAWDOWN_REQUESTED',
      }),
    ).toMatchObject({ ok: false, error: 'guard_failed', failed: ['resolution_attributed'] })
  })

  it('is the only transition whose destination is not fixed by the table', () => {
    // The blast radius of the dynamic model, stated as a number. If a second
    // transition ever becomes dynamic, this test makes someone say so.
    const dynamic = TRANSITIONS.filter((t) => t.to === null && t.statusEvent !== null)
    expect(dynamic.map((t) => t.id)).toEqual(['T22'])
  })
})

describe('the states T22 can never resume to', () => {
  it('never a terminal state', () => {
    // SETTLED via a resume would be the most valuable forgery in the system:
    // money declared delivered by an operator clicking "resolve".
    for (const terminal of TERMINAL_STATUSES) {
      expect(RESUMABLE).not.toContain(terminal)
    }
  })

  it('never ACTION_REQUIRED', () => {
    // ACTION_REQUIRED is a customer instruction. Resuming into it would ask a
    // customer to act on a settlement that is already mid-execution — and past
    // the point of no return, there is nothing they could do about it.
    expect(RESUMABLE).not.toContain('ACTION_REQUIRED')
  })

  it('never a state the machine cannot open an exception from', () => {
    // The resumable set is not a hand-written list that could drift from the
    // table: it is exactly the set of states with an outbound transition into
    // EXCEPTION. Any origin outside it is unreachable, so resuming to it would
    // be resuming to somewhere the settlement has never been.
    const opensException = new Set<SettlementStatus>()
    for (const t of TRANSITIONS) {
      if (t.to === 'EXCEPTION') for (const from of t.from) opensException.add(from)
    }
    expect([...opensException].sort()).toEqual([...RESUMABLE].sort())
  })

  it('leaves no other status reachable by a resume', () => {
    const unreachable = SETTLEMENT_STATUSES.filter((s) => !RESUMABLE.includes(s))
    // Includes DRAFT, PREFLIGHTING, READY, QUOTED, AUTHORIZED, ACTION_REQUIRED,
    // DRAWDOWN_CONFIRMED, PAYOUT_CONFIRMED, EXCEPTION and the three terminals.
    expect(unreachable).toContain('SETTLED')
    expect(unreachable).toContain('ACTION_REQUIRED')
    expect(unreachable).toContain('AUTHORIZED')
    expect(unreachable).toContain('EXCEPTION')
    expect(unreachable.length).toBe(SETTLEMENT_STATUSES.length - RESUMABLE.length)
  })
})

describe('T30 owes R04 to Stage 6 (the deferred companion contract)', () => {
  it('declares the debt on the transition itself, not in a comment', () => {
    const t30 = TRANSITIONS.find((t) => t.id === 'T30')!
    expect(t30.deferredCompanions).toHaveLength(1)
    expect(t30.deferredCompanions![0]).toMatchObject({
      ref: 'R04',
      aggregate: 'Reconciliation',
      owedBy: 'Stage 6',
    })
  })

  it('does not emit R04 as if the aggregate existed', () => {
    // The failure this avoids: inventing a Reconciliation record so a Stage 3
    // checklist can be ticked. An event about a record that does not exist is
    // not evidence of anything, and it has to be unpicked later.
    const t30 = TRANSITIONS.find((t) => t.id === 'T30')!
    expect(t30.companionEvents).toEqual([])
    const evaluated = evaluateTransition({
      from: 'RECONCILING',
      trigger: 'reconciliation_stalled',
      guards: { reconciliation_sla_elapsed: true },
    })
    expect(evaluated).toMatchObject({ ok: true, to: 'EXCEPTION' })
    expect(evaluated.ok && evaluated.permittedCompanions).toEqual([])
  })

  it('is enumerable, so the debt can be discovered rather than remembered', () => {
    // Stage 6 does not have to read Stage 3's source to find out what it owes.
    expect(deferredCompanionsFor('Stage 6').map((d) => d.companion.ref)).toEqual(['R04'])
    expect(deferredCompanions().map((d) => d.transition)).toEqual(['T30'])
  })

  it('every deferred companion names a stage that is still ahead', () => {
    for (const { companion } of deferredCompanions()) {
      expect(['Stage 4', 'Stage 5', 'Stage 6']).toContain(companion.owedBy)
      expect(companion.why.length).toBeGreaterThan(40)
    }
  })
})

describe('Stage 6 discharges the R04 debt', () => {
  it('R04 is a real transition on a real aggregate, not still a promise', () => {
    // The other half of the deferred-companion contract. Declaring a debt is
    // only useful if someone can later prove it was paid, and this is that
    // proof: the transition the companion named now exists in the frozen
    // reconciliation table, with the guard the document gives it.
    const r04 = RECONCILIATION_TRANSITIONS.find((t) => t.id === 'R04')!
    expect(r04).toMatchObject({ from: ['PENDING'], trigger: 'observation_overdue', to: 'MANUAL_REVIEW' })
    expect(r04.guard).toMatch(/reconciliation poller/)

    // And every companion T30 declared is now backed by one.
    for (const { companion } of deferredCompanionsFor('Stage 6')) {
      expect(
        RECONCILIATION_TRANSITIONS.some((t) => t.id === companion.ref),
        `${companion.ref} was owed by ${companion.owedBy} and must now exist`,
      ).toBe(true)
    }
  })
})

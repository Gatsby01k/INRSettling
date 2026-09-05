/**
 * `D-03`, closed for V1.
 *
 * The decision: `FAILED` and `CANCELLED` both project to the customer-facing
 * state `CANCELLED`, and a precise *resolution reason* carries the difference.
 * No `NOT_COMPLETED`; no sixth customer-facing settlement state.
 *
 * These tests fix the decision in place, because the pressure to add a sixth
 * state does not come from a design review — it comes from a support ticket
 * where someone wants "failed" to look different in a list, and by then the
 * state is in three schemas and a public API.
 */
import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_STATUSES,
  RESOLUTIONS,
  RESOLUTION_CODES,
  SETTLEMENT_STATUSES,
  customerStatusColumn,
  isResolutionCode,
  resolutionDefinition,
  resolutionMatchesTerminal,
} from '../index.js'

describe('the shape of the decision', () => {
  it('keeps exactly five customer-facing states', () => {
    expect([...CUSTOMER_STATUSES]).toEqual([
      'READY',
      'SETTLING',
      'SETTLED',
      'ACTION_REQUIRED',
      'CANCELLED',
    ])
  })

  it('has no NOT_COMPLETED anywhere', () => {
    // Stated as a test rather than a comment because the name is the thing to
    // keep out: a state that means "ended, but not the cancelled kind" is a
    // puzzle the customer has to solve rather than an answer.
    expect(CUSTOMER_STATUSES as readonly string[]).not.toContain('NOT_COMPLETED')
    expect(SETTLEMENT_STATUSES as readonly string[]).not.toContain('NOT_COMPLETED')
  })

  it('projects both terminal failures to the same customer state', () => {
    expect(customerStatusColumn({ status: 'FAILED' })).toBe('CANCELLED')
    expect(customerStatusColumn({ status: 'CANCELLED' })).toBe('CANCELLED')
  })

  it('leaves the internal distinction intact', () => {
    // The projection collapses them for the customer. Operations, audit and
    // reconciliation still see two different terminal states, which is the
    // whole reason collapsing the *customer* view is safe.
    expect(SETTLEMENT_STATUSES).toContain('FAILED')
    expect(SETTLEMENT_STATUSES).toContain('CANCELLED')
  })
})

describe('the resolution reason carries what the state no longer says', () => {
  it('gives every terminal settlement a reason to choose from', () => {
    expect(RESOLUTION_CODES.length).toBeGreaterThan(0)
    expect(RESOLUTIONS).toHaveLength(RESOLUTION_CODES.length)
  })

  it('assigns every reason to exactly one terminal status', () => {
    for (const code of RESOLUTION_CODES) {
      const def = resolutionDefinition(code)
      expect(['FAILED', 'CANCELLED']).toContain(def.terminal)
      expect(resolutionMatchesTerminal(code, def.terminal)).toBe(true)
      expect(resolutionMatchesTerminal(code, def.terminal === 'FAILED' ? 'CANCELLED' : 'FAILED')).toBe(
        false,
      )
    }
  })

  it('covers both terminal statuses, so neither ends without an explanation', () => {
    const terminals = new Set(RESOLUTIONS.map((r) => r.terminal))
    expect([...terminals].sort()).toEqual(['CANCELLED', 'FAILED'])
  })

  it('says what happened to the money in every single message', () => {
    // The only question a terminal settlement raises. A message that does not
    // answer it makes the customer write in to ask, which is the outcome the
    // reason field exists to prevent.
    for (const r of RESOLUTIONS) {
      expect(r.message.length).toBeGreaterThan(20)
      expect(r.message).toMatch(/no funds were sent/i)
      // A sentence, not a code fragment dressed up as prose.
      expect(r.message).toMatch(/\.$/)
      expect(r.message).not.toMatch(/[A-Z]{2,}_[A-Z]/)
    }
  })

  it('never blames the customer for an operational failure', () => {
    const operational = RESOLUTIONS.filter((r) => r.terminal === 'FAILED')
    for (const r of operational) {
      expect(r.message).not.toMatch(/\byou (failed|did not|didn't)\b/i)
    }
  })

  it('is a closed set, checkable at a boundary', () => {
    expect(isResolutionCode('provider_rejected')).toBe(true)
    expect(isResolutionCode('NOT_COMPLETED')).toBe(false)
    expect(isResolutionCode('')).toBe(false)
  })

  it('throws rather than defaulting on an unknown code', () => {
    // A default here would be a settlement told it ended for a reason nobody
    // chose, which is worse than an error nobody sees.
    expect(() => resolutionDefinition('nope' as never)).toThrow(/closed set/)
  })

  it('distinguishes the three cancellations the machine can actually produce', () => {
    // T25 (before authorization), a customer cancellation, and T27 (a request
    // honoured at a checkpoint). Collapsing these into one message would lose
    // the only part the customer might dispute.
    const cancellations = RESOLUTIONS.filter((r) => r.terminal === 'CANCELLED').map((r) => r.code)
    expect(cancellations).toEqual([
      'cancelled_by_customer',
      'cancelled_before_authorization',
      'cancellation_honoured',
    ])
    expect(new Set(RESOLUTIONS.map((r) => r.message)).size).toBe(RESOLUTIONS.length)
  })
})

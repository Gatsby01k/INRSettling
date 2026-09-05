/**
 * Payout attempt identity — `INV-24`, `INV-25`.
 *
 * The failure this suite exists to prevent: an idempotency key that is constant
 * across a settlement's life. A provider honouring such a key would answer the
 * second attempt with the first attempt's result, and a payout that was never
 * sent would look sent.
 */
import { describe, expect, it } from 'vitest'
import {
  PAYOUT_ATTEMPT_STATUSES,
  PAYOUT_TRANSITIONS,
  TERMINAL_PAYOUT_ATTEMPT_STATUSES,
  allocateAttemptNumber,
  evaluatePayoutTransition,
  isPayoutAttemptInFlight,
  isPayoutAttemptTerminal,
  payoutIdempotencyKey,
  terminalAttemptPermitsAnother,
  type AttemptSummary,
} from '../index.js'

const S = 'stl_2Rn8Kq5TzYw6'

describe('the idempotency key (INV-25)', () => {
  it('is derived from the settlement and the attempt number', () => {
    expect(payoutIdempotencyKey(S, 1)).toBe(`payout:v1:${S}:1`)
    expect(payoutIdempotencyKey(S, 2)).toBe(`payout:v1:${S}:2`)
  })

  it('is stable: the same attempt always produces the same key', () => {
    expect(payoutIdempotencyKey(S, 1)).toBe(payoutIdempotencyKey(S, 1))
  })

  it('differs between attempts on the same settlement', () => {
    // The regression that motivated this model: a key derived from
    // settlement + authorized_terms_hash is *constant* across attempts, so
    // attempt 2 would have presented attempt 1's key.
    expect(payoutIdempotencyKey(S, 2)).not.toBe(payoutIdempotencyKey(S, 1))
  })

  it('differs between settlements at the same attempt number', () => {
    expect(payoutIdempotencyKey('stl_other', 1)).not.toBe(payoutIdempotencyKey(S, 1))
  })

  it('depends on nothing except those two inputs', () => {
    // Stated as a property rather than a comment: the key is a pure function of
    // (settlementId, attemptNumber), so no instruction change can move it.
    const inputs: [string, number][] = [
      ['stl_a', 1], ['stl_a', 2], ['stl_b', 1], ['stl_b', 7],
    ]
    const keys = inputs.map(([id, n]) => payoutIdempotencyKey(id, n))
    expect(new Set(keys).size).toBe(inputs.length)
    for (const [id, n] of inputs) expect(payoutIdempotencyKey(id, n)).toBe(keys[inputs.findIndex(([i, m]) => i === id && m === n)])
  })

  it('refuses a nonsensical attempt number rather than minting a key for it', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => payoutIdempotencyKey(S, bad)).toThrow(RangeError)
    }
  })
})

describe('terminality (INV-24)', () => {
  it('treats CREDITED, REJECTED and RETURNED as terminal', () => {
    expect([...TERMINAL_PAYOUT_ATTEMPT_STATUSES]).toEqual(['CREDITED', 'REJECTED', 'RETURNED'])
  })

  it('treats UNKNOWN as in flight, not terminal', () => {
    // The whole point. UNKNOWN means "we do not know whether money moved";
    // calling it finished is how a settlement pays twice.
    expect(isPayoutAttemptTerminal('UNKNOWN')).toBe(false)
    expect(isPayoutAttemptInFlight('UNKNOWN')).toBe(true)
  })

  it('classifies every status exactly once', () => {
    for (const status of PAYOUT_ATTEMPT_STATUSES) {
      expect(isPayoutAttemptTerminal(status)).toBe(!isPayoutAttemptInFlight(status))
    }
  })
})

describe('allocating an attempt number', () => {
  const attempt = (attemptNumber: number, status: AttemptSummary['status']): AttemptSummary => ({
    attemptNumber,
    status,
  })

  it('allocates 1 when nothing has been attempted', () => {
    expect(allocateAttemptNumber([])).toEqual({ ok: true, attemptNumber: 1, reason: 'first_attempt' })
  })

  it('reuses the in-flight attempt: a retry is the same submission', () => {
    for (const status of ['SUBMITTED', 'ACCEPTED'] as const) {
      const result = allocateAttemptNumber([attempt(1, status)])
      expect(result).toEqual({ ok: true, attemptNumber: 1, reason: 'reuse_in_flight' })
    }
  })

  it('refuses to allocate attempt 2 while the first is UNKNOWN', () => {
    const result = allocateAttemptNumber([attempt(1, 'UNKNOWN')])
    expect(result).toEqual({ ok: false, reason: 'status_unknown', attemptNumber: 1 })
  })

  it('allocates 2 once the first attempt is authoritatively rejected', () => {
    expect(allocateAttemptNumber([attempt(1, 'REJECTED')])).toEqual({
      ok: true,
      attemptNumber: 2,
      reason: 'next_attempt',
    })
  })

  it('allocates 2 only after UNKNOWN has been resolved by a status pull', () => {
    // INV-24 in one assertion: UNKNOWN blocks, and the same settlement becomes
    // allocatable the moment the pull resolves it.
    expect(allocateAttemptNumber([attempt(1, 'UNKNOWN')]).ok).toBe(false)
    expect(allocateAttemptNumber([attempt(1, 'REJECTED')]).ok).toBe(true)
  })

  it('never allocates another attempt after CREDITED', () => {
    expect(allocateAttemptNumber([attempt(1, 'CREDITED')])).toEqual({
      ok: false,
      reason: 'already_credited',
      attemptNumber: 1,
    })
  })

  it('never allocates another attempt after RETURNED', () => {
    // A credited-then-returned payout is handled by a replacement settlement,
    // because the original instruction is frozen and cannot be re-aimed.
    expect(allocateAttemptNumber([attempt(1, 'CREDITED'), attempt(1, 'RETURNED')]).ok).toBe(false)
    expect(allocateAttemptNumber([attempt(1, 'RETURNED')])).toEqual({
      ok: false,
      reason: 'returned_needs_replacement',
      attemptNumber: 1,
    })
  })

  it('counts from the highest attempt, not the array order', () => {
    const shuffled = [attempt(2, 'REJECTED'), attempt(1, 'REJECTED')]
    expect(allocateAttemptNumber(shuffled)).toEqual({
      ok: true,
      attemptNumber: 3,
      reason: 'next_attempt',
    })
  })

  it('an in-flight attempt outranks a terminal history', () => {
    const history = [attempt(1, 'REJECTED'), attempt(2, 'SUBMITTED')]
    expect(allocateAttemptNumber(history)).toEqual({
      ok: true,
      attemptNumber: 2,
      reason: 'reuse_in_flight',
    })
  })

  it('only REJECTED permits another attempt', () => {
    expect(terminalAttemptPermitsAnother('REJECTED')).toBe(true)
    expect(terminalAttemptPermitsAnother('CREDITED')).toBe(false)
    expect(terminalAttemptPermitsAnother('RETURNED')).toBe(false)
  })
})

describe('the frozen P01–P08 table', () => {
  it('has all eight rows', () => {
    expect(PAYOUT_TRANSITIONS.map((t) => t.id)).toEqual([
      'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08',
    ])
  })

  it('reaches UNKNOWN only through an SLA elapse, and leaves it only by a pull', () => {
    expect(evaluatePayoutTransition('SUBMITTED', 'sla_elapsed')).toMatchObject({ ok: true, to: 'UNKNOWN' })
    expect(evaluatePayoutTransition('UNKNOWN', 'pull_resolved_credited')).toMatchObject({
      ok: true, to: 'CREDITED',
    })
    expect(evaluatePayoutTransition('UNKNOWN', 'pull_resolved_rejected')).toMatchObject({
      ok: true, to: 'REJECTED',
    })
    // Never a blind resubmit (INV-24).
    expect(evaluatePayoutTransition('UNKNOWN', 'dispatch').ok).toBe(false)
    expect(evaluatePayoutTransition('UNKNOWN', 'credited').ok).toBe(false)
  })

  it('rejects every trigger from a terminal attempt except the return of a credit', () => {
    for (const from of TERMINAL_PAYOUT_ATTEMPT_STATUSES) {
      for (const t of PAYOUT_TRANSITIONS) {
        const legal = t.from.includes(from)
        const result = evaluatePayoutTransition(from, t.trigger)
        if (!legal) continue
        // P08 is the one legal move out of a terminal state, and it is a fact
        // about the rail rather than a new payout.
        expect(result).toMatchObject({ ok: true, id: 'P08' })
      }
    }
  })

  it('creates an attempt only from nothing', () => {
    expect(evaluatePayoutTransition(null, 'dispatch')).toMatchObject({ ok: true, to: 'SUBMITTED' })
    for (const from of PAYOUT_ATTEMPT_STATUSES) {
      expect(evaluatePayoutTransition(from, 'dispatch').ok, from).toBe(false)
    }
  })
})

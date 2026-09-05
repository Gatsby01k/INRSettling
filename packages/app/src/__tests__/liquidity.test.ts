/**
 * Stage 4 — the liquidity facility, against a real database.
 *
 * The four exit criteria this file exists to prove, in the frozen plan's words:
 *
 *   - N simultaneous reservations against a facility that can fund N−1 produce
 *     exactly one failure and never negative availability (`INV-20`);
 *   - the facility projection is rebuildable from the ledger, and a deliberate
 *     divergence fires the alarm (`INV-23`);
 *   - release is idempotent under repeated cancel, fail and expiry, and
 *     releasing a `CONSUMED` reservation raises a typed error (`INV-22`);
 *   - a repayment moves `available` only at `CONFIRMED`, never at `REQUESTED`
 *     or `SUBMITTED`; `UNKNOWN` resolves by status pull only (`INV-46`,
 *     `INV-47`).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { money } from '@inrsettle/money'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { capacityRestoringTransitions } from '@inrsettle/domain'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { createSettlement } from '../settlement-transition.service.js'
import {
  advanceRepayment,
  checkFacilityProjection,
  consumeReservation,
  createFacility,
  readFacility,
  releaseReservation,
  requestRepayment,
  reserveLiquidity,
} from '../liquidity.service.js'

let h: Harness
const WS = 'ws_liquidity'
const scope = { workspaceId: WS, environment: 'sandbox' as const }
const actor = { type: 'user' as const, id: 'usr_admin' }
const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}
const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)

/**
 * A sandbox TTL, supplied by the test the way configuration supplies it in
 * production. `D-05` is open on the *duration*; nothing in the code picks one.
 */
const SANDBOX_TTL_SECONDS = 900

let beneficiaryId = ''
let seq = 0

beforeAll(async () => {
  h = await createTestDatabase('liquidity')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin', 'approver', 'operator'],
  })
  const created = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN' },
      destination: {
        kind: 'bank_account', accountNumber: '50100123456789', ifsc: 'HDFC0000123',
        accountType: 'savings', accountHolderName: 'Aarti Sharma',
      },
      actor,
    }),
  )
  beneficiaryId = created.id
  await requestVerification(h.db, scope, createSandboxVerificationProvider(), crypto.cipher, SANDBOX_NAME_MATCH_POLICIES, {
      destinationVersionId: created.destinations[0]!.currentVersion!.id,
      actor,
    })

})
afterAll(async () => { await h.close() })

async function newSettlement(): Promise<string> {
  const { id } = await live((tx) =>
    createSettlement(tx, scope, {
      beneficiaryId,
      recipientAmountMinor: 500_000_000n,
      fundingCurrency: 'USDT',
      purposeCode: 'SOFTWARE_SERVICES',
      externalReference: `liq_${(seq += 1)}`,
      actor,
    }),
  )
  return id
}

/** A facility with a limit expressed in whole units of the funding currency. */
async function newFacility(limitMinor: bigint): Promise<string> {
  const { id } = await live((tx) =>
    createFacility(tx, scope, {
      providerId: 'mock_liquidity',
      currency: 'USDT',
      limit: money('USDT', limitMinor),
      actor,
    }),
  )
  return id
}

/**
 * Each test gets its own facility, so none of them shares a position with
 * another. There is no teardown: a facility that still holds value cannot be
 * closed (the trigger refuses it), and that refusal is itself correct — closing
 * one with an outstanding drawdown would strand a repayment with nowhere to
 * post. Leaving them is cheaper than weakening the rule for the test's benefit.
 */

const UNIT = 1_000_000n

describe('INV-19 — available = limit − drawn − reserved, and never negative', () => {
  it('reports the whole limit as available on a fresh facility', async () => {
    const id = await newFacility(10n * UNIT)
    const facility = await live((tx) => readFacility(tx, id))
    expect(facility?.id).toBe(id)
    expect(facility?.available.minorUnits).toBe(10n * UNIT)
  })

  it('refuses a raw update that would make availability negative', async () => {
    // The CHECK, not the service. This is the line of defence that holds when
    // every TypeScript guard above it has been bypassed.
    const id = await newFacility(10n * UNIT)
    await expect(
      live((tx) => tx.execute(sql`
        UPDATE liquidity_facilities SET drawn_minor = ${11n * UNIT} WHERE id = ${id}`)),
    ).rejects.toThrow(/facility_availability_non_negative/)
  })

  it('permits a reservation that exactly exhausts the facility', async () => {
    // `>= amount`, not `> amount`. Refusing the last settlement a facility can
    // fund would strand liquidity for no reason.
    const id = await newFacility(3n * UNIT)
    const settlementId = await newSettlement()
    const result = await live((tx) =>
      reserveLiquidity(tx, scope, {
        facilityId: id, settlementId, amount: money('USDT', 3n * UNIT),
        ttlSeconds: SANDBOX_TTL_SECONDS, actor,
      }),
    )
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.available.minorUnits).toBe(0n)
  })
})

describe('INV-20 — reservation is atomic under contention', () => {
  it('N simultaneous reservations against N−1 capacity produce exactly one failure', async () => {
    // The frozen exit criterion, verbatim. Run at N=6 against a facility that
    // can fund 5, so the test is a real race rather than a two-way coin flip.
    const N = 6
    const id = await newFacility(BigInt(N - 1) * UNIT)
    const settlements = await Promise.all(Array.from({ length: N }, () => newSettlement()))

    const results = await Promise.allSettled(
      settlements.map((settlementId) =>
        live((tx) =>
          reserveLiquidity(tx, scope, {
            facilityId: id, settlementId, amount: money('USDT', UNIT),
            ttlSeconds: SANDBOX_TTL_SECONDS, actor,
          }),
        ),
      ),
    )

    const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length
    const failed = N - succeeded
    expect(succeeded).toBe(N - 1)
    expect(failed).toBe(1)

    // And the invariant itself, read back from the row: availability never went
    // negative, which the CHECK would have refused anyway — this asserts that
    // the refusal came as a clean answer rather than a constraint violation.
    const facility = await live((tx) => readFacility(tx, id))
    expect(facility?.available.minorUnits).toBe(0n)
    expect(facility?.position.reserved.minorUnits).toBe(BigInt(N - 1) * UNIT)

    const refusal = results.find((r) => r.status === 'fulfilled' && !r.value.ok)
    expect(refusal?.status).toBe('fulfilled')
    if (refusal?.status === 'fulfilled') {
      expect(refusal.value).toMatchObject({ ok: false, reason: 'insufficient_availability' })
    }
  })

  it('refuses a reservation on a suspended facility without touching availability', async () => {
    const id = await newFacility(10n * UNIT)
    await h.admin`UPDATE liquidity_facilities SET status = 'SUSPENDED' WHERE id = ${id}`
    const settlementId = await newSettlement()
    expect(
      await live((tx) =>
        reserveLiquidity(tx, scope, {
          facilityId: id, settlementId, amount: money('USDT', UNIT),
          ttlSeconds: SANDBOX_TTL_SECONDS, actor,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'facility_not_active' })
  })

  it('holds INV-21: a settlement cannot hold two active reservations', async () => {
    const id = await newFacility(10n * UNIT)
    const settlementId = await newSettlement()
    const reserve = () =>
      live((tx) =>
        reserveLiquidity(tx, scope, {
          facilityId: id, settlementId, amount: money('USDT', UNIT),
          ttlSeconds: SANDBOX_TTL_SECONDS, actor,
        }),
      )
    expect(await reserve()).toMatchObject({ ok: true })
    expect(await reserve()).toMatchObject({ ok: false, reason: 'already_reserved' })

    // And through raw SQL, where the partial unique index is the only guard.
    await expect(
      live((tx) => tx.execute(sql`
        INSERT INTO liquidity_reservations
          (id, workspace_id, environment, facility_id, settlement_id, amount_minor,
           amount_currency, status, expires_at)
        VALUES ('rsv_forged', ${WS}, 'sandbox', ${id}, ${settlementId}, ${UNIT},
                'USDT', 'ACTIVE', now() + interval '1 hour')`)),
    ).rejects.toThrow(/one_active|duplicate key/)
  })
})

describe('INV-22 — release is idempotent, and CONSUMED has no release path', () => {
  async function reserved(): Promise<{ facilityId: string; settlementId: string }> {
    const facilityId = await newFacility(10n * UNIT)
    const settlementId = await newSettlement()
    await live((tx) =>
      reserveLiquidity(tx, scope, {
        facilityId, settlementId, amount: money('USDT', UNIT),
        ttlSeconds: SANDBOX_TTL_SECONDS, actor,
      }),
    )
    return { facilityId, settlementId }
  }

  it('releases once and reports repeats as no-ops', async () => {
    const { facilityId, settlementId } = await reserved()
    const first = await live((tx) =>
      releaseReservation(tx, scope, { settlementId, reason: 'settlement_cancelled', actor }),
    )
    expect(first).toMatchObject({ ok: true, noop: false })

    // Repeated cancel, fail and expiry — the three the exit criterion names.
    for (const reason of ['settlement_cancelled', 'settlement_failed', 'drawdown_failed'] as const) {
      expect(
        await live((tx) => releaseReservation(tx, scope, { settlementId, reason, actor })),
      ).toMatchObject({ ok: true, noop: true })
    }

    // Idempotent means the *facility* did not move either. Four releases of one
    // reservation must credit the facility exactly once.
    const facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility?.position.reserved.minorUnits).toBe(0n)
    expect(facility?.available.minorUnits).toBe(10n * UNIT)

    const entries = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM ledger_entries
      WHERE facility_id = ${facilityId} AND movement = 'reservation_released'`))) as unknown as { n: number }[]
    expect(entries[0]!.n).toBe(2) // one balanced pair, not four
  })

  it('refuses to release a CONSUMED reservation with a typed error', async () => {
    // INV-22 asks for exactly this: "a typed error, not a no-op, so a mistaken
    // code path fails loudly instead of silently double-crediting the facility".
    const { facilityId, settlementId } = await reserved()
    await live((tx) => consumeReservation(tx, scope, { settlementId, actor }))

    expect(
      await live((tx) =>
        releaseReservation(tx, scope, { settlementId, reason: 'settlement_cancelled', actor }),
      ),
    ).toMatchObject({ ok: false, reason: 'consumed_cannot_be_released' })

    // Not a no-op: the value is still drawn, and would have been credited twice.
    const facility = await live((tx) => readFacility(tx, facilityId))
    expect(facility?.position.drawn.minorUnits).toBe(UNIT)
    expect(facility?.position.reserved.minorUnits).toBe(0n)
  })

  it('refuses it through raw SQL too', async () => {
    const { settlementId } = await reserved()
    await live((tx) => consumeReservation(tx, scope, { settlementId, actor }))
    await expect(
      live((tx) => tx.execute(sql`
        UPDATE liquidity_reservations SET status = 'RELEASED', released_at = now(),
          released_reason = 'forged' WHERE settlement_id = ${settlementId}`)),
    ).rejects.toThrow(/CONSUMED and has no release path/)
  })

  it('expiry releases through V04 and is equally idempotent', async () => {
    const { settlementId } = await reserved()
    expect(
      await live((tx) =>
        releaseReservation(tx, scope, { settlementId, reason: 'ttl_expired', actor, expired: true }),
      ),
    ).toMatchObject({ ok: true, noop: false })
    expect(
      await live((tx) =>
        releaseReservation(tx, scope, { settlementId, reason: 'ttl_expired', actor, expired: true }),
      ),
    ).toMatchObject({ ok: true, noop: true })

    const rows = (await live((tx) => tx.execute(sql`
      SELECT status FROM liquidity_reservations WHERE settlement_id = ${settlementId}`))) as unknown as
      { status: string }[]
    expect(rows[0]!.status).toBe('EXPIRED')
  })
})

describe('INV-23 — the projection is rebuildable from the ledger', () => {
  it('agrees with the ledger after a full reserve/consume/repay cycle', async () => {
    const facilityId = await newFacility(10n * UNIT)
    const settlementId = await newSettlement()
    await live((tx) =>
      reserveLiquidity(tx, scope, {
        facilityId, settlementId, amount: money('USDT', 2n * UNIT),
        ttlSeconds: SANDBOX_TTL_SECONDS, actor,
      }),
    )
    await live((tx) => consumeReservation(tx, scope, { settlementId, actor }))

    const check = await live((tx) => checkFacilityProjection(tx, facilityId))
    expect(check.agrees).toBe(true)
    expect(check.projected).toEqual({ drawnMinor: 2n * UNIT, reservedMinor: 0n })
    expect(check.stored).toEqual(check.projected)
  })

  it('fires the alarm on a deliberate divergence', async () => {
    // The exit criterion asks for the divergence to be *detected*, so the test
    // has to create one — which takes a superuser, because the application has
    // no path that writes a facility figure without a ledger pair.
    const facilityId = await newFacility(10n * UNIT)
    const settlementId = await newSettlement()
    await live((tx) =>
      reserveLiquidity(tx, scope, {
        facilityId, settlementId, amount: money('USDT', UNIT),
        ttlSeconds: SANDBOX_TTL_SECONDS, actor,
      }),
    )
    expect((await live((tx) => checkFacilityProjection(tx, facilityId))).agrees).toBe(true)

    await h.admin`UPDATE liquidity_facilities SET reserved_minor = reserved_minor + 5 WHERE id = ${facilityId}`

    const check = await live((tx) => checkFacilityProjection(tx, facilityId))
    expect(check.agrees).toBe(false)
    // The ledger wins: it is the one reporting the true position.
    expect(check.projected.reservedMinor).toBe(UNIT)
    expect(check.stored.reservedMinor).toBe(UNIT + 5n)
  })

  it('refuses a half-written movement at commit', async () => {
    // A single entry is not a movement. The deferred trigger is what makes
    // "the ledger cannot be half-written" a fact rather than a convention.
    const facilityId = await newFacility(10n * UNIT)
    await expect(
      live((tx) => tx.execute(sql`
        INSERT INTO ledger_entries
          (id, workspace_id, environment, facility_id, transfer_id, movement, account,
           direction, amount_minor, amount_currency, subject_type, subject_id, created_by)
        VALUES ('led_half', ${WS}, 'sandbox', ${facilityId}, 'ltr_half', 'reservation_created',
                'reserved', 'debit', 100, 'USDT', 'test', 'test', 'usr_admin')`)),
    ).rejects.toThrow(/exactly one of each/)
  })

  it('refuses an unbalanced pair at commit', async () => {
    const facilityId = await newFacility(10n * UNIT)
    await expect(
      live(async (tx) => {
        for (const [id, account, direction, amount] of [
          ['led_a', 'reserved', 'debit', 100],
          ['led_b', 'available', 'credit', 99],
        ] as const) {
          await tx.execute(sql`
            INSERT INTO ledger_entries
              (id, workspace_id, environment, facility_id, transfer_id, movement, account,
               direction, amount_minor, amount_currency, subject_type, subject_id, created_by)
            VALUES (${id}, ${WS}, 'sandbox', ${facilityId}, 'ltr_unbalanced', 'reservation_created',
                    ${account}::ledger_account, ${direction}::ledger_direction, ${amount},
                    'USDT', 'test', 'test', 'usr_admin')`)
        }
      }),
    ).rejects.toThrow(/does not balance/)
  })

  it('is append-only for everyone, including the superuser', async () => {
    const facilityId = await newFacility(10n * UNIT)
    const settlementId = await newSettlement()
    await live((tx) =>
      reserveLiquidity(tx, scope, {
        facilityId, settlementId, amount: money('USDT', UNIT),
        ttlSeconds: SANDBOX_TTL_SECONDS, actor,
      }),
    )
    await expect(
      live((tx) => tx.execute(sql`UPDATE ledger_entries SET amount_minor = 1 WHERE facility_id = ${facilityId}`)),
    ).rejects.toThrow(/append-only|permission denied/i)
    // A history that a privileged role can edit is not a history.
    await expect(
      h.admin`DELETE FROM ledger_entries WHERE facility_id = ${facilityId}`,
    ).rejects.toThrow(/append-only/)
  })
})

describe('INV-46 / INV-47 — capacity returns on CONFIRMED and on nothing else', () => {
  async function drawnFacility(): Promise<{ facilityId: string; settlementId: string }> {
    const facilityId = await newFacility(10n * UNIT)
    const settlementId = await newSettlement()
    await live((tx) =>
      reserveLiquidity(tx, scope, {
        facilityId, settlementId, amount: money('USDT', 4n * UNIT),
        ttlSeconds: SANDBOX_TTL_SECONDS, actor,
      }),
    )
    await live((tx) => consumeReservation(tx, scope, { settlementId, actor }))
    return { facilityId, settlementId }
  }

  const availability = async (facilityId: string): Promise<bigint> =>
    (await live((tx) => readFacility(tx, facilityId)))!.available.minorUnits

  it('exactly Y03 and Y06 restore capacity', async () => {
    // Read from the frozen table rather than from the implementation, so the
    // invariant is checked against the document.
    expect(capacityRestoringTransitions()).toEqual(['Y03', 'Y06'])
  })

  it('a REQUESTED repayment does not move availability', async () => {
    const { facilityId, settlementId } = await drawnFacility()
    const before = await availability(facilityId)
    expect(before).toBe(6n * UNIT)

    const requested = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    expect(requested).toMatchObject({ ok: true, capacityRestored: false })
    // The whole point of INV-46: intent is not capacity.
    expect(await availability(facilityId)).toBe(before)
  })

  it('a SUBMITTED repayment does not move availability either', async () => {
    const { facilityId, settlementId } = await drawnFacility()
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await live((tx) =>
      advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor, providerReference: 'prpy_1' }),
    )
    expect(await availability(facilityId)).toBe(6n * UNIT)
  })

  it('CONFIRMED moves it, once', async () => {
    const { facilityId, settlementId } = await drawnFacility()
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
    const confirmed = await live((tx) =>
      advanceRepayment(tx, scope, { repaymentId, trigger: 'confirmed', actor }),
    )
    expect(confirmed).toMatchObject({ ok: true, capacityRestored: true })
    expect(await availability(facilityId)).toBe(10n * UNIT)

    // And not twice. A confirmed repayment is terminal.
    expect(
      await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'confirmed', actor })),
    ).toMatchObject({ ok: false, reason: 'invalid_transition' })
    expect(await availability(facilityId)).toBe(10n * UNIT)

    const check = await live((tx) => checkFacilityProjection(tx, facilityId))
    expect(check.agrees).toBe(true)
  })

  it('UNKNOWN resolves by pull, and the pull can go either way', async () => {
    for (const [trigger, expectedAvailable] of [
      ['pull_resolved_confirmed', 10n * UNIT],
      ['pull_resolved_failed', 6n * UNIT],
    ] as const) {
      const { facilityId, settlementId } = await drawnFacility()
      const r = await live((tx) =>
        requestRepayment(tx, scope, {
          facilityId, amount: money('USDT', 4n * UNIT),
          source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
        }),
      )
      const repaymentId = r.ok ? r.repaymentId : ''
      await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
      await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'sla_elapsed', actor }))
      expect(await availability(facilityId)).toBe(6n * UNIT)

      await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: trigger, actor }))
      expect(await availability(facilityId)).toBe(expectedAvailable)
    }
  })

  it('an UNKNOWN repayment cannot be resubmitted (INV-47)', async () => {
    // The refusal that prevents a duplicate repayment — the financial error in
    // the opposite direction from a duplicate payout, and just as real.
    const { facilityId, settlementId } = await drawnFacility()
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'sla_elapsed', actor }))

    expect(
      await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor })),
    ).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('a re-request after failure mints a new fingerprint (Y08)', async () => {
    const { facilityId, settlementId } = await drawnFacility()
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    const fingerprintOf = async (): Promise<{ fingerprint: string; attempt: number }> => {
      const rows = (await live((tx) => tx.execute(sql`
        SELECT request_fingerprint, attempt FROM repayments WHERE id = ${repaymentId}`))) as unknown as
        { request_fingerprint: string; attempt: number }[]
      return { fingerprint: rows[0]!.request_fingerprint, attempt: rows[0]!.attempt }
    }
    const before = await fingerprintOf()

    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'rejected', actor }))
    await live((tx) =>
      advanceRepayment(tx, scope, {
        repaymentId, trigger: 're_request', actor, reason: 'provider asked us to retry with new details',
      }),
    )

    const after = await fingerprintOf()
    expect(after.attempt).toBe(before.attempt + 1)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    // Availability still has not moved: a re-request is not a confirmation.
    expect(await availability(facilityId)).toBe(6n * UNIT)
  })

  it('refuses a re-request that reuses the old fingerprint, even through raw SQL', async () => {
    const { facilityId, settlementId } = await drawnFacility()
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'rejected', actor }))

    await expect(
      live((tx) => tx.execute(sql`
        UPDATE repayments SET status = 'REQUESTED' WHERE id = ${repaymentId}`)),
    ).rejects.toThrow(/new attempt number/)
  })

  it('a CONFIRMED repayment can never be reopened', async () => {
    const { facilityId, settlementId } = await drawnFacility()
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'confirmed', actor }))
    await expect(
      live((tx) => tx.execute(sql`UPDATE repayments SET status = 'SUBMITTED' WHERE id = ${repaymentId}`)),
    ).rejects.toThrow(/capacity has already been restored/)
  })
})

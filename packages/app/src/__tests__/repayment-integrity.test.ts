/**
 * Capacity cannot be restored beyond real outstanding drawdown.
 *
 * The failure this suite exists to prevent has one shape and several routes: a
 * facility that reports more capacity than it truly has, so it funds a
 * settlement against money that is not there. Every route runs through a
 * `repayment_confirmed` ledger movement, so every route is checked here — at
 * the service, at the database, and under concurrency, because a rule enforced
 * only in TypeScript is a rule that holds until someone writes SQL.
 *
 * The arithmetic that makes the whole thing checkable: `available = limit −
 * drawn − reserved`, with `drawn >= 0` and `reserved >= 0` as database `CHECK`
 * constraints. Those two together are what makes "available can never exceed
 * the limit" a theorem rather than a hope — so proving `drawn` cannot go
 * negative proves the ceiling as well.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { money } from '@inrsettle/money'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
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
  requestRepayment,
  reserveLiquidity,
} from '../liquidity.service.js'

let h: Harness
const WS = 'ws_repay'
const OTHER_WS = 'ws_repay_other'
const scope = { workspaceId: WS, environment: 'sandbox' as const }
const otherScope = { workspaceId: OTHER_WS, environment: 'sandbox' as const }
const liveScope = { workspaceId: WS, environment: 'live' as const }
const actor = { type: 'user' as const, id: 'usr_admin' }
const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}
const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)
const asOther = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, otherScope, fn)

const TTL = 900
const UNIT = 1_000_000n
let beneficiaryId = ''
let seq = 0

beforeAll(async () => {
  h = await createTestDatabase('repayment_integrity')
  for (const ws of [WS, OTHER_WS]) {
    await seedWorkspace(h.admin, {
      workspaceId: ws, userId: 'usr_admin', email: `${ws}@example.test`,
      roles: ['admin', 'approver', 'operator'],
    })
  }
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
      beneficiaryId, recipientAmountMinor: 500_000_000n, fundingCurrency: 'USDT',
      purposeCode: 'SOFTWARE_SERVICES', externalReference: `rep_${(seq += 1)}`, actor,
    }),
  )
  return id
}

async function newFacility(limitMinor: bigint, currency: 'USDT' | 'USD' = 'USDT'): Promise<string> {
  const { id } = await live((tx) =>
    createFacility(tx, scope, {
      providerId: 'mock_liquidity', currency, limit: money(currency, limitMinor), actor,
    }),
  )
  return id
}

/** A facility with `drawnMinor` genuinely drawn against a real settlement. */
async function drawn(drawnMinor: bigint, limitMinor = 10n * UNIT): Promise<{
  facilityId: string
  settlementId: string
}> {
  const facilityId = await newFacility(limitMinor)
  const settlementId = await newSettlement()
  await live((tx) =>
    reserveLiquidity(tx, scope, {
      facilityId, settlementId, amount: money('USDT', drawnMinor), ttlSeconds: TTL, actor,
    }),
  )
  await live((tx) => consumeReservation(tx, scope, { settlementId, actor }))
  return { facilityId, settlementId }
}

const position = async (facilityId: string) => {
  const f = await live((tx) => readFacility(tx, facilityId))
  return {
    drawn: f!.position.drawn.minorUnits,
    reserved: f!.position.reserved.minorUnits,
    available: f!.available.minorUnits,
    limit: f!.position.limit.minorUnits,
  }
}

const capacityMovements = async (facilityId: string): Promise<number> => {
  const rows = (await live((tx) => tx.execute(sql`
    SELECT count(*)::int AS n FROM ledger_entries
    WHERE facility_id = ${facilityId} AND movement = 'repayment_confirmed'`))) as unknown as
    { n: number }[]
  return rows[0]!.n
}

const confirm = (repaymentId: string) =>
  live(async (tx) => {
    await advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor })
    return advanceRepayment(tx, scope, { repaymentId, trigger: 'confirmed', actor })
  })

/* ── 1. drawn can never go negative ─────────────────────────────────────── */

describe('drawn can never become negative', () => {
  it('refuses a repayment larger than what is outstanding, and posts nothing', async () => {
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const before = await position(facilityId)

    const result = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 5n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'exceeds_outstanding' })

    // Refused at request time, so there is no repayment row to confirm later —
    // and no capacity-restoring movement to find.
    expect(await capacityMovements(facilityId)).toBe(0)
    expect(await position(facilityId)).toEqual(before)
    const rows = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM repayments WHERE facility_id = ${facilityId}`))) as unknown as
      { n: number }[]
    expect(rows[0]!.n).toBe(0)
  })

  it('permits a repayment of exactly the outstanding amount', async () => {
    // The boundary. Refusing this would strand the facility's own money.
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    expect(r).toMatchObject({ ok: true })
    await confirm(r.ok ? r.repaymentId : '')
    expect((await position(facilityId)).drawn).toBe(0n)
  })

  it('refuses at the database even when the service is bypassed entirely', async () => {
    // The service check is a courtesy; this is the guarantee. A repayment row
    // written by raw SQL for more than is drawn cannot post its movement,
    // because the projection update trips CHECK (drawn_minor >= 0).
    const { facilityId, settlementId } = await drawn(2n * UNIT)
    await expect(
      live((tx) => tx.execute(sql`
        UPDATE liquidity_facilities SET drawn_minor = drawn_minor - ${3n * UNIT}
        WHERE id = ${facilityId}`)),
    ).rejects.toThrow(/drawn_minor_check|violates check constraint/)
    expect((await position(facilityId)).drawn).toBe(2n * UNIT)
    expect(settlementId).toBeTruthy()
  })

  it('nets off repayments already in flight when sizing the next one', async () => {
    // The subtle one. Two repayments each for the full drawn amount are
    // individually plausible; confirming both restores capacity twice for money
    // that went out once.
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const first = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    expect(first).toMatchObject({ ok: true })

    // A second, for the same money, against a different source so the
    // one-live-per-settlement index is not what refuses it.
    const second = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT), source: 'MANUAL', actor,
      }),
    )
    expect(second).toMatchObject({ ok: false, reason: 'exceeds_outstanding' })
    expect(second.ok === false && (second.detail as { eligible: string }).eligible).toBe('0')
  })
})

/* ── 2. available can never exceed the limit ────────────────────────────── */

describe('available can never exceed the facility limit', () => {
  it('returns to exactly the limit after a full repayment, never past it', async () => {
    const { facilityId, settlementId } = await drawn(3n * UNIT, 10n * UNIT)
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 3n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    await confirm(r.ok ? r.repaymentId : '')

    const after = await position(facilityId)
    expect(after.available).toBe(after.limit)
    expect(after.drawn).toBe(0n)
    // The ceiling is a consequence, not a separate rule: available = limit −
    // drawn − reserved, and both subtrahends are CHECKed non-negative.
    expect(after.available).toBeLessThanOrEqual(after.limit)
  })

  it('is arithmetically impossible to exceed while drawn and reserved cannot go negative', async () => {
    const { facilityId } = await drawn(2n * UNIT)
    for (const column of ['drawn_minor', 'reserved_minor']) {
      await expect(
        live((tx) => tx.execute(sql.raw(
          `UPDATE liquidity_facilities SET ${column} = -1 WHERE id = '${facilityId}'`,
        ))),
      ).rejects.toThrow(/check constraint/)
    }
  })
})

/* ── 3. the same confirmation cannot restore twice ──────────────────────── */

describe('one confirmation, one restoration', () => {
  it('refuses a second confirmation of the same repayment', async () => {
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await confirm(repaymentId)
    expect(await capacityMovements(facilityId)).toBe(2) // one balanced pair

    expect(
      await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'confirmed', actor })),
    ).toMatchObject({ ok: false, reason: 'invalid_transition' })
    expect(await capacityMovements(facilityId)).toBe(2)
    expect((await position(facilityId)).drawn).toBe(0n)
  })

  it('refuses a pull-resolved confirmation after a trusted one', async () => {
    // The two routes into CONFIRMED (Y03 and Y06) must not compose.
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await confirm(repaymentId)
    expect(
      await live((tx) =>
        advanceRepayment(tx, scope, { repaymentId, trigger: 'pull_resolved_confirmed', actor }),
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_transition' })
    expect(await capacityMovements(facilityId)).toBe(2)
  })

  it('refuses reopening a CONFIRMED repayment through raw SQL', async () => {
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await confirm(repaymentId)
    await expect(
      live((tx) => tx.execute(sql`UPDATE repayments SET status = 'SUBMITTED' WHERE id = ${repaymentId}`)),
    ).rejects.toThrow(/capacity has already been restored/)
  })
})

/* ── 4. concurrency ─────────────────────────────────────────────────────── */

describe('concurrent confirmations cannot double-restore', () => {
  it('serializes two simultaneous confirmations of the same repayment', async () => {
    // Both transactions take the repayment row lock, so they have a total
    // order: one confirms, the other finds CONFIRMED and is refused. Run
    // repeatedly, because a race that only sometimes interleaves is a race a
    // single run will miss.
    for (let i = 0; i < 5; i += 1) {
      const { facilityId, settlementId } = await drawn(4n * UNIT)
      const r = await live((tx) =>
        requestRepayment(tx, scope, {
          facilityId, amount: money('USDT', 4n * UNIT),
          source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
        }),
      )
      const repaymentId = r.ok ? r.repaymentId : ''
      await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))

      const results = await Promise.allSettled([
        live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'confirmed', actor })),
        live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'confirmed', actor })),
      ])
      const restored = results.filter(
        (x) => x.status === 'fulfilled' && x.value.ok && x.value.capacityRestored,
      ).length

      expect(restored, `run ${i}`).toBe(1)
      expect(await capacityMovements(facilityId)).toBe(2)
      expect((await position(facilityId)).drawn).toBe(0n)
      expect((await live((tx) => checkFacilityProjection(tx, facilityId))).agrees).toBe(true)
    }
  })

  it('permits only one live repayment per settlement, even concurrently', async () => {
    // Two confirmations for the same *source* rather than the same row: the
    // shape a double restoration takes when two repayment records exist for one
    // drawdown. The partial unique index makes the second record impossible.
    for (let i = 0; i < 5; i += 1) {
      const { facilityId, settlementId } = await drawn(4n * UNIT)
      const request = () =>
        live((tx) =>
          requestRepayment(tx, scope, {
            facilityId, amount: money('USDT', 4n * UNIT),
            source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
          }),
        )
      const results = await Promise.allSettled([request(), request()])
      const created = results.filter((x) => x.status === 'fulfilled' && x.value.ok).length
      expect(created, `run ${i}`).toBe(1)

      const rows = (await live((tx) => tx.execute(sql`
        SELECT count(*)::int AS n FROM repayments WHERE settlement_id = ${settlementId}`))) as unknown as
        { n: number }[]
      expect(rows[0]!.n).toBe(1)
      expect(facilityId).toBeTruthy()
    }
  })
})

/* ── 5. scope and currency ──────────────────────────────────────────────── */

describe('facility, tenant and currency must match', () => {
  it('refuses a repayment in a currency the facility does not hold', async () => {
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const result = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USD', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'currency_mismatch' })
    expect(await capacityMovements(facilityId)).toBe(0)
  })

  it('refuses a facility belonging to another workspace', async () => {
    // RLS makes it invisible; the service turns invisibility into a named
    // refusal. Without this the row would be written in *this* tenant's scope
    // against a facility we cannot see, and the confirming UPDATE would match
    // zero rows while the ledger entry was written anyway.
    const foreign = await asOther((tx) =>
      createFacility(tx, otherScope, {
        providerId: 'mock_liquidity', currency: 'USDT',
        limit: money('USDT', 10n * UNIT), actor,
      }),
    )
    const settlementId = await newSettlement()
    expect(
      await live((tx) =>
        requestRepayment(tx, scope, {
          facilityId: foreign.id, amount: money('USDT', UNIT),
          source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'facility_not_found' })
  })

  it('refuses a cross-tenant repayment row at the database', async () => {
    // The composite foreign key, not the service. `(facility_id, workspace_id,
    // environment, amount_currency)` must resolve to a real facility, so a row
    // claiming another tenant's facility has no referent.
    const foreign = await asOther((tx) =>
      createFacility(tx, otherScope, {
        providerId: 'mock_liquidity', currency: 'USDT',
        limit: money('USDT', 10n * UNIT), actor,
      }),
    )
    await expect(
      live((tx) => tx.execute(sql`
        INSERT INTO repayments
          (id, workspace_id, environment, facility_id, amount_minor, amount_currency,
           source, status, attempt, request_fingerprint)
        VALUES ('rpy_forged', ${WS}, 'sandbox', ${foreign.id}, ${UNIT}, 'USDT',
                'MANUAL', 'REQUESTED', 1, 'repay:v1:forged:1')`)),
    ).rejects.toThrow(/violates foreign key|repayments_facility_id/)
  })

  it('refuses a repayment row whose currency is not the facility currency', async () => {
    const facilityId = await newFacility(10n * UNIT)
    await expect(
      live((tx) => tx.execute(sql`
        INSERT INTO repayments
          (id, workspace_id, environment, facility_id, amount_minor, amount_currency,
           source, status, attempt, request_fingerprint)
        VALUES ('rpy_wrongccy', ${WS}, 'sandbox', ${facilityId}, ${UNIT}, 'USD',
                'MANUAL', 'REQUESTED', 1, 'repay:v1:wrongccy:1')`)),
    ).rejects.toThrow(/violates foreign key/)
  })

  it('refuses a repayment row in the wrong environment', async () => {
    // Same facility id, different environment. INV-31 isolates on both.
    const facilityId = await newFacility(10n * UNIT)
    await expect(
      withTenant(h.db, liveScope, (tx) => tx.execute(sql`
        INSERT INTO repayments
          (id, workspace_id, environment, facility_id, amount_minor, amount_currency,
           source, status, attempt, request_fingerprint)
        VALUES ('rpy_wrongenv', ${WS}, 'live', ${facilityId}, ${UNIT}, 'USDT',
                'MANUAL', 'REQUESTED', 1, 'repay:v1:wrongenv:1')`)),
    ).rejects.toThrow(/violates foreign key/)
  })

  it('refuses a ledger entry against a facility belonging to another tenant', async () => {
    const foreign = await asOther((tx) =>
      createFacility(tx, otherScope, {
        providerId: 'mock_liquidity', currency: 'USDT',
        limit: money('USDT', 10n * UNIT), actor,
      }),
    )
    await expect(
      live((tx) => tx.execute(sql`
        INSERT INTO ledger_entries
          (id, workspace_id, environment, facility_id, transfer_id, movement, account,
           direction, amount_minor, amount_currency, subject_type, subject_id, created_by)
        VALUES ('led_forged', ${WS}, 'sandbox', ${foreign.id}, 'ltr_forged',
                'repayment_confirmed', 'available', 'debit', ${UNIT}, 'USDT',
                'test', 'test', 'usr_admin')`)),
    ).rejects.toThrow(/violates foreign key/)
  })
})

/* ── 6. FAILED, re-request, and the historical-combination attack ───────── */

describe('a failed repayment cannot combine with a later one', () => {
  it('re-requests in place, so there is never a second live row', async () => {
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'rejected', actor }))
    await live((tx) =>
      advanceRepayment(tx, scope, { repaymentId, trigger: 're_request', actor, reason: 'retry' }),
    )
    await confirm(repaymentId)

    // Two attempts, one row, one restoration.
    const rows = (await live((tx) => tx.execute(sql`
      SELECT count(*)::int AS n, max(attempt) AS attempts FROM repayments
      WHERE settlement_id = ${settlementId}`))) as unknown as { n: number; attempts: number }[]
    expect(rows[0]!.n).toBe(1)
    expect(Number(rows[0]!.attempts)).toBe(2)
    expect(await capacityMovements(facilityId)).toBe(2)
    expect((await position(facilityId)).drawn).toBe(0n)
  })

  it('a failed repayment does not consume eligibility, so a fresh one fits', async () => {
    // A FAILED repayment returned no money, so it must not reduce what may
    // still be repaid — the mirror of the in-flight netting above.
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'rejected', actor }))

    const fresh = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT), source: 'MANUAL', actor,
      }),
    )
    expect(fresh).toMatchObject({ ok: true })
    await confirm(fresh.ok ? fresh.repaymentId : '')

    // Still exactly one restoration, from the one that actually succeeded.
    expect(await capacityMovements(facilityId)).toBe(2)
    expect((await position(facilityId)).drawn).toBe(0n)
  })

  it('refuses re-requesting the failed one once a replacement is live', async () => {
    // The historical-combination attack, stated directly: revive the old failed
    // row while its replacement is in flight, and confirm both.
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const first = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const firstId = first.ok ? first.repaymentId : ''
    await live((tx) => advanceRepayment(tx, scope, { repaymentId: firstId, trigger: 'submit', actor }))
    await live((tx) => advanceRepayment(tx, scope, { repaymentId: firstId, trigger: 'rejected', actor }))

    const second = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    expect(second).toMatchObject({ ok: true })

    // Reviving the failed row would make two live repayments for one drawdown.
    await expect(
      live((tx) =>
        advanceRepayment(tx, scope, { repaymentId: firstId, trigger: 're_request', actor, reason: 'x' }),
      ),
    ).rejects.toThrow(/one_live_per_settlement|duplicate key/)

    await confirm(second.ok ? second.repaymentId : '')
    expect(await capacityMovements(facilityId)).toBe(2)
    expect((await position(facilityId)).drawn).toBe(0n)
  })
})

/* ── 7. UNKNOWN ─────────────────────────────────────────────────────────── */

describe('UNKNOWN restores nothing and resolves only by pull', () => {
  async function unknownRepayment(): Promise<{ facilityId: string; repaymentId: string }> {
    const { facilityId, settlementId } = await drawn(4n * UNIT)
    const r = await live((tx) =>
      requestRepayment(tx, scope, {
        facilityId, amount: money('USDT', 4n * UNIT),
        source: 'CANCELLATION_AFTER_DRAWDOWN', settlementId, actor,
      }),
    )
    const repaymentId = r.ok ? r.repaymentId : ''
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'submit', actor }))
    await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger: 'sla_elapsed', actor }))
    return { facilityId, repaymentId }
  }

  it('restores nothing while UNKNOWN', async () => {
    const { facilityId } = await unknownRepayment()
    expect(await capacityMovements(facilityId)).toBe(0)
    expect((await position(facilityId)).drawn).toBe(4n * UNIT)
  })

  it('cannot be resubmitted, and cannot be confirmed by a trusted event', async () => {
    // INV-47. The only move from not-knowing is to ask.
    const { facilityId, repaymentId } = await unknownRepayment()
    for (const trigger of ['submit', 'confirmed', 'rejected'] as const) {
      expect(
        await live((tx) => advanceRepayment(tx, scope, { repaymentId, trigger, actor })),
        trigger,
      ).toMatchObject({ ok: false, reason: 'invalid_transition' })
    }
    expect(await capacityMovements(facilityId)).toBe(0)
  })

  it('holds its eligibility while UNKNOWN, so no second repayment can be sized against it', async () => {
    // An UNKNOWN repayment may already have returned the money. Treating its
    // amount as still repayable is how the facility gets credited twice.
    const { facilityId } = await unknownRepayment()
    expect(
      await live((tx) =>
        requestRepayment(tx, scope, {
          facilityId, amount: money('USDT', UNIT), source: 'MANUAL', actor,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'exceeds_outstanding' })
  })

  it('resolves through the pull path, in either direction, exactly once', async () => {
    const confirmedCase = await unknownRepayment()
    await live((tx) =>
      advanceRepayment(tx, scope, {
        repaymentId: confirmedCase.repaymentId, trigger: 'pull_resolved_confirmed', actor,
      }),
    )
    expect(await capacityMovements(confirmedCase.facilityId)).toBe(2)
    expect((await position(confirmedCase.facilityId)).drawn).toBe(0n)

    const failedCase = await unknownRepayment()
    await live((tx) =>
      advanceRepayment(tx, scope, {
        repaymentId: failedCase.repaymentId, trigger: 'pull_resolved_failed', actor,
      }),
    )
    expect(await capacityMovements(failedCase.facilityId)).toBe(0)
    expect((await position(failedCase.facilityId)).drawn).toBe(4n * UNIT)
  })
})

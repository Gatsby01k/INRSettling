// GATE-EXEMPT-RAW-SETTLE: this file attempts the forbidden raw writes on purpose —
// proving the database refuses them is the whole point, and a gate that stopped
// it would stop the test that keeps the refusal honest.
/**
 * Database enforcement, attempted with the **runtime role** and raw SQL.
 *
 * TypeScript is not a security boundary. Every control Stage 3 owns is checked
 * here the way an attacker or a careless migration would meet it: as
 * `inrsettle_app`, through `tx.execute`, bypassing every service in the
 * codebase.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { payoutIdempotencyKey } from '@inrsettle/domain'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import { createBeneficiary } from '../beneficiary.service.js'
import { requestVerification } from '../verification.service.js'
import { createQuote } from '../quote.service.js'
import { createSettlement } from '../settlement-transition.service.js'

let h: Harness
const WS = 'ws_dbenf'
// Sandbox, because Stage 3 prices against the labelled sandbox configuration
// and `priceQuote` refuses to price a *live* quote against it (D-08/D-09 open).
const scope = { workspaceId: WS, environment: 'sandbox' as const }
const actor = { type: 'user' as const, id: 'usr_admin' }
const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}
const provider = createSandboxVerificationProvider()
const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)

let beneficiaryId = ''

beforeAll(async () => {
  h = await createTestDatabase('settlement_db_enforcement')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin', 'approver'],
  })
  const created = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN' },
      destination: {
        kind: 'bank_account',
        accountNumber: '50100123456789',
        ifsc: 'HDFC0000123',
        accountType: 'savings',
        accountHolderName: 'Aarti Sharma',
      },
      actor,
    }),
  )
  beneficiaryId = created.id
  await requestVerification(h.db, scope, provider, crypto.cipher, SANDBOX_NAME_MATCH_POLICIES, {
      destinationVersionId: created.destinations[0]!.currentVersion!.id,
      actor,
    })

})
afterAll(async () => { await h.close() })

let seq = 0
async function newDraft(): Promise<string> {
  const { id } = await live((tx) =>
    createSettlement(tx, scope, {
      beneficiaryId,
      recipientAmountMinor: 500_000_000n,
      fundingCurrency: 'USDT',
      purposeCode: 'SOFTWARE_SERVICES',
      externalReference: `ext_${(seq += 1)}`,
      actor,
    }),
  )
  return id
}

/**
 * Force a settlement into a state the machine would take several steps to
 * reach.
 *
 * Even this fixture has to write a paired status event: the INV-32 trigger
 * fires for the **superuser** too, not only for the runtime role. Discovering
 * that while writing the fixture is itself the guarantee working.
 */
const STATUS_EVENT: Record<string, string> = {
  SETTLED: 'settlement.settled',
  FAILED: 'settlement.failed',
  CANCELLED: 'settlement.cancelled',
  AUTHORIZED: 'settlement.authorized',
  PREFLIGHTING: 'settlement.preflight_started',
}

async function forceStatus(id: string, status: string): Promise<void> {
  await h.admin.begin(async (tx) => {
    await tx`UPDATE settlements SET status = ${status}::settlement_status WHERE id = ${id}`
    await tx`
      INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
      VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', ${STATUS_EVENT[status]!},
              'settlement', ${id}, 'user', 'usr_admin')`
  })
}

describe('INV-32 — the status/event pairing rule', () => {
  it('a raw status update with no event is rejected at commit', async () => {
    const id = await newDraft()
    await expect(
      live((tx) => tx.execute(sql`UPDATE settlements SET status = 'READY' WHERE id = ${id}`)),
    ).rejects.toThrow(/exactly 1|not exactly 1/)
  })

  it('a raw status update with two status events is rejected', async () => {
    const id = await newDraft()
    await expect(
      live(async (tx) => {
        await tx.execute(sql`UPDATE settlements SET status = 'READY' WHERE id = ${id}`)
        for (const type of ['settlement.ready', 'settlement.quoted']) {
          await tx.execute(sql`
            INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
            VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', ${type}, 'settlement', ${id}, 'user', 'usr_admin')`)
        }
      }),
    ).rejects.toThrow(/2 status events/)
  })

  it('a companion event cannot substitute for a status event', async () => {
    // The heart of INV-32: emitting quote.locked and calling it done leaves the
    // event stream with a gap the projection would never recover from.
    const id = await newDraft()
    await expect(
      live(async (tx) => {
        await tx.execute(sql`UPDATE settlements SET status = 'QUOTED' WHERE id = ${id}`)
        await tx.execute(sql`
          INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
          VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'quote.locked', 'settlement', ${id}, 'user', 'usr_admin')`)
      }),
    ).rejects.toThrow(/0 status events/)
  })

  it('a status event with no status change is rejected', async () => {
    const id = await newDraft()
    await expect(
      live(async (tx) => {
        await tx.execute(sql`UPDATE settlements SET external_reference = 'x' WHERE id = ${id}`)
        await tx.execute(sql`
          INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
          VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.ready', 'settlement', ${id}, 'user', 'usr_admin')`)
      }),
    ).rejects.toThrow(/did not change status/)
  })

  it('a correctly paired raw update is accepted, so the rule is not simply "no raw SQL"', async () => {
    const id = await newDraft()
    await live(async (tx) => {
      await tx.execute(sql`UPDATE settlements SET status = 'PREFLIGHTING' WHERE id = ${id}`)
      await tx.execute(sql`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.preflight_started', 'settlement', ${id}, 'user', 'usr_admin')`)
    })
    const rows = (await live((tx) =>
      tx.execute(sql`SELECT status FROM settlements WHERE id = ${id}`),
    )) as unknown as { status: string }[]
    expect(rows[0]?.status).toBe('PREFLIGHTING')
  })

  it('an event for a different settlement does not satisfy the rule', async () => {
    const a = await newDraft()
    const b = await newDraft()
    await expect(
      live(async (tx) => {
        await tx.execute(sql`UPDATE settlements SET status = 'READY' WHERE id = ${a}`)
        await tx.execute(sql`
          INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
          VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.ready', 'settlement', ${b}, 'user', 'usr_admin')`)
      }),
    ).rejects.toThrow(/0 status events/)
  })
})

describe('INV-38 — terminal settlements accept no writes at all', () => {
  for (const terminal of ['SETTLED', 'FAILED', 'CANCELLED'] as const) {
    it(`${terminal} rejects a status change`, async () => {
      const id = await newDraft()
      await forceStatus(id, terminal)
      await expect(
        live((tx) => tx.execute(sql`UPDATE settlements SET status = 'READY' WHERE id = ${id}`)),
      ).rejects.toThrow(/terminal/)
    })

    it(`${terminal} rejects a flag write`, async () => {
      const id = await newDraft()
      await forceStatus(id, terminal)
      await expect(
        live((tx) => tx.execute(sql`UPDATE settlements SET cancellation_requested_at = now() WHERE id = ${id}`)),
      ).rejects.toThrow(/terminal/)
    })

    it(`${terminal} rejects a convenience pointer`, async () => {
      // "not a status change, not a flag, not a convenience pointer."
      const id = await newDraft()
      await forceStatus(id, terminal)
      await expect(
        live((tx) => tx.execute(sql`UPDATE settlements SET receipt_id = 'rcp_1' WHERE id = ${id}`)),
      ).rejects.toThrow(/terminal/)
    })

    it(`${terminal} rejects even a no-op touch of updated_at`, async () => {
      const id = await newDraft()
      await forceStatus(id, terminal)
      await expect(
        live((tx) => tx.execute(sql`UPDATE settlements SET updated_at = now() WHERE id = ${id}`)),
      ).rejects.toThrow(/terminal/)
    })
  }

  it('the app role cannot delete a settlement at all', async () => {
    await expect(live((tx) => tx.execute(sql`DELETE FROM settlements`))).rejects.toThrow(/permission denied/i)
  })
})

describe('INV-16 — the instruction is immutable from AUTHORIZED onward', () => {
  async function authorizedRow(): Promise<string> {
    const id = await newDraft()
    // Set the authorization marker directly; the trigger keys off authorized_at.
    await h.admin.begin(async (tx) => {
      await tx`
        UPDATE settlements
        SET status = 'AUTHORIZED', authorized_at = now(), authorized_by = 'usr_admin',
            destination_version_id = (SELECT id FROM payout_destination_versions LIMIT 1),
            authorized_terms = '{"quote_id":"qt_1"}'::jsonb,
            authorized_terms_hash = 'abc'
        WHERE id = ${id}`
      await tx`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.authorized',
                'settlement', ${id}, 'user', 'usr_admin')`
    })
    return id
  }

  const frozen: [string, string][] = [
    ['beneficiary_id', `'ben_other'`],
    ['destination_version_id', 'NULL'],
    ['recipient_amount_minor', '1'],
    ['purpose_code', `'GOODS_EXPORT'`],
    ['funding_currency', `'USD'`],
    ['quote_id', `'qt_other'`],
    ['authorized_terms', `'{"quote_id":"qt_evil"}'::jsonb`],
    ['authorized_terms_hash', `'deadbeef'`],
    ['authorized_at', 'now()'],
    ['authorized_by', `'usr_evil'`],
  ]

  for (const [column, value] of frozen) {
    it(`rejects a raw update to ${column}`, async () => {
      const id = await authorizedRow()
      await expect(
        live((tx) => tx.execute(sql.raw(`UPDATE settlements SET ${column} = ${value} WHERE id = '${id}'`))),
      ).rejects.toThrow(/immutable|violates foreign key/)
    })
  }

  it('still permits the fields that are supposed to move', async () => {
    const id = await authorizedRow()
    await live((tx) => tx.execute(sql`UPDATE settlements SET cancellation_requested_at = now() WHERE id = ${id}`))
    const rows = (await live((tx) =>
      tx.execute(sql`SELECT cancellation_requested_at FROM settlements WHERE id = ${id}`),
    )) as unknown as { cancellation_requested_at: Date | null }[]
    expect(rows[0]?.cancellation_requested_at).not.toBeNull()
  })
})

describe('INV-36 — point_of_no_return_at is never cleared or moved', () => {
  it('rejects clearing it', async () => {
    const id = await newDraft()
    await h.admin`UPDATE settlements SET point_of_no_return_at = now() WHERE id = ${id}`
    await expect(
      live((tx) => tx.execute(sql`UPDATE settlements SET point_of_no_return_at = NULL WHERE id = ${id}`)),
    ).rejects.toThrow(/never cleared/)
  })

  it('rejects moving it', async () => {
    const id = await newDraft()
    await h.admin`UPDATE settlements SET point_of_no_return_at = now() WHERE id = ${id}`
    await expect(
      live((tx) =>
        tx.execute(sql`UPDATE settlements SET point_of_no_return_at = now() + interval '1 hour' WHERE id = ${id}`),
      ),
    ).rejects.toThrow(/never cleared/)
  })
})

describe('INV-13 / INV-14 — quote immutability and single consumption', () => {
  async function newQuote(): Promise<string> {
    const q = await live((tx) =>
      createQuote(tx, scope, {
        fundingCurrency: 'USDT',
        recipientAmount: { currency: 'INR', minorUnits: 500_000_000n },
        actor,
      }),
    )
    return q.id
  }

  const priced: [string, string][] = [
    ['recipient_amount_minor', '1'],
    ['funding_amount_minor', '1'],
    ['fx_rate_scaled', '1.0'],
    ['fx_pair', `'USD/INR'`],
    ['fee_components', `'[]'::jsonb`],
    ['rounding_residual', `'{}'::jsonb`],
    ['expires_at', `now() + interval '1 day'`],
    ['direction', `'SOURCE_FIRST'`],
    ['pricing_version', `'evil'`],
  ]

  for (const [column, value] of priced) {
    it(`rejects a raw update to quote.${column} (INV-13)`, async () => {
      const id = await newQuote()
      await expect(
        live((tx) => tx.execute(sql.raw(`UPDATE quotes SET ${column} = ${value} WHERE id = '${id}'`))),
      ).rejects.toThrow(/immutable/)
    })
  }

  it('permits the lifecycle columns to move', async () => {
    const id = await newQuote()
    await live((tx) => tx.execute(sql`UPDATE quotes SET status = 'LOCKED', locked_at = now() WHERE id = ${id}`))
    const rows = (await live((tx) =>
      tx.execute(sql`SELECT status FROM quotes WHERE id = ${id}`),
    )) as unknown as { status: string }[]
    expect(rows[0]?.status).toBe('LOCKED')
  })

  it('a terminal quote does not move again', async () => {
    const id = await newQuote()
    await live((tx) => tx.execute(sql`UPDATE quotes SET status = 'EXPIRED' WHERE id = ${id}`))
    await expect(
      live((tx) => tx.execute(sql`UPDATE quotes SET status = 'ACTIVE' WHERE id = ${id}`)),
    ).rejects.toThrow(/no outgoing transition/)
  })

  it('a quote cannot be consumed by two settlements (INV-14)', async () => {
    const id = await newQuote()
    const a = await newDraft()
    const b = await newDraft()
    await live((tx) =>
      tx.execute(sql`UPDATE quotes SET status = 'CONSUMED', consumed_by_settlement_id = ${a} WHERE id = ${id}`),
    )
    await expect(
      live((tx) => tx.execute(sql`UPDATE quotes SET consumed_by_settlement_id = ${b} WHERE id = ${id}`)),
    ).rejects.toThrow(/already consumed/)
  })

  it('two quotes cannot claim the same settlement', async () => {
    const first = await newQuote()
    const second = await newQuote()
    const s = await newDraft()
    await live((tx) =>
      tx.execute(sql`UPDATE quotes SET status = 'CONSUMED', consumed_by_settlement_id = ${s} WHERE id = ${first}`),
    )
    await expect(
      live((tx) =>
        tx.execute(sql`UPDATE quotes SET status = 'CONSUMED', consumed_by_settlement_id = ${s} WHERE id = ${second}`),
      ),
    ).rejects.toThrow(/quotes_single_consumption|duplicate key/)
  })

  it('two settlements cannot claim the same quote', async () => {
    const q = await newQuote()
    const a = await newDraft()
    const b = await newDraft()
    await live((tx) => tx.execute(sql`UPDATE settlements SET quote_id = ${q} WHERE id = ${a}`))
    await expect(
      live((tx) => tx.execute(sql`UPDATE settlements SET quote_id = ${q} WHERE id = ${b}`)),
    ).rejects.toThrow(/settlements_quote_once|duplicate key/)
  })
})

/**
 * `INV-24` / `INV-25` — payout attempt identity, at the database.
 *
 * The model these tests defend: a settlement may have several payout attempts
 * over its life, at most one of them in flight at any moment, and each attempt's
 * provider idempotency key is derived from `settlement_id + attempt_number`.
 *
 * What makes that worth a schema rather than a convention is the failure it
 * replaces. A key derived from `settlement_id + authorized_terms_hash` is
 * *constant* for the life of a settlement: attempt 2 would present attempt 1's
 * key, a provider honouring idempotency would hand back attempt 1's result, and
 * a payout that was never sent would read as sent. The same derivation fails in
 * the other direction too — editing the instruction would mint a fresh key, so
 * an instruction edit becomes a way to conjure a second real payout.
 */
describe('INV-24 / INV-25 — payout attempt identity', () => {
  let versionId = ''
  beforeAll(async () => {
    versionId = (
      (await live((tx) =>
        tx.execute(sql`SELECT id FROM payout_destination_versions LIMIT 1`),
      )) as unknown as { id: string }[]
    )[0]!.id
  })

  let attemptSeq = 0
  const insertAttempt = (settlementId: string, attemptNumber: number, status?: string) => {
    const attemptId = `pay_${(attemptSeq += 1)}`
    const key = payoutIdempotencyKey(settlementId, attemptNumber)
    return live((tx) =>
      tx.execute(sql`
        INSERT INTO payout_attempts
          (id, workspace_id, environment, settlement_id, destination_version_id,
           attempt_number, idempotency_key, status, dispatched_by)
        VALUES (${attemptId}, ${WS}, 'sandbox', ${settlementId}, ${versionId},
                ${attemptNumber}, ${key}, ${status ?? 'SUBMITTED'}::payout_attempt_status,
                'usr_admin')`),
    ).then(() => attemptId)
  }

  const setStatus = (attemptId: string, status: string) =>
    live((tx) =>
      tx.execute(sql`
        UPDATE payout_attempts SET status = ${status}::payout_attempt_status
        WHERE id = ${attemptId}`),
    )

  /**
   * Credit an attempt with the evidence a credit requires.
   *
   * Stage 5 added `payout_credit_has_utr` and `payout_credit_is_timed`: a
   * CREDITED row without a UTR and a credit timestamp is a receipt we could not
   * honour, and the database now says so. This fixture supplies both, which is
   * also the more faithful thing to write.
   */
  const creditAttempt = (attemptId: string) =>
    live((tx) =>
      tx.execute(sql`
        UPDATE payout_attempts
        SET status = 'CREDITED', utr = 'UTR000000001', credited_at = now()
        WHERE id = ${attemptId}`),
    )

  it('refuses two simultaneous non-terminal attempts', async () => {
    const id = await newDraft()
    await insertAttempt(id, 1)
    await expect(insertAttempt(id, 2)).rejects.toThrow(/one_in_flight|duplicate key/)
  })

  it('refuses a second attempt while the first is UNKNOWN', async () => {
    // The one that matters most. UNKNOWN means "we do not know whether money
    // moved"; treating it as finished is precisely how a settlement pays twice.
    const id = await newDraft()
    const first = await insertAttempt(id, 1)
    await setStatus(first, 'UNKNOWN')
    await expect(insertAttempt(id, 2)).rejects.toThrow(/one_in_flight|duplicate key/)
  })

  it('permits attempt 2 once attempt 1 is authoritatively rejected', async () => {
    const id = await newDraft()
    const first = await insertAttempt(id, 1)
    await setStatus(first, 'REJECTED')
    await insertAttempt(id, 2)

    const rows = (await live((tx) =>
      tx.execute(sql`
        SELECT attempt_number, idempotency_key FROM payout_attempts
        WHERE settlement_id = ${id} ORDER BY attempt_number`),
    )) as unknown as { attempt_number: number; idempotency_key: string }[]

    // Historical terminal attempts are kept, not overwritten: the record that a
    // first payout was tried is part of what makes the second explicable.
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2])
    expect(rows[0]!.idempotency_key).not.toBe(rows[1]!.idempotency_key)
    expect(rows[1]!.idempotency_key).toBe(payoutIdempotencyKey(id, 2))
  })

  it('a retry of the same attempt presents the same key, and cannot double-insert', async () => {
    const id = await newDraft()
    await insertAttempt(id, 1)
    // A retried network submission is the *same* attempt number, so it derives
    // the same key — and the unique index means the retry cannot become a row.
    await expect(insertAttempt(id, 1)).rejects.toThrow(/duplicate key/)
  })

  it('the same attempt number cannot be reused under a different key', async () => {
    const id = await newDraft()
    await insertAttempt(id, 1)
    await expect(
      live((tx) =>
        tx.execute(sql`
          INSERT INTO payout_attempts
            (id, workspace_id, environment, settlement_id, destination_version_id,
             attempt_number, idempotency_key, status, dispatched_by)
          VALUES ('pay_dup', ${WS}, 'sandbox', ${id}, ${versionId}, 1,
                  'payout:v1:forged:1', 'REJECTED', 'usr_admin')`),
      ),
    ).rejects.toThrow(/settlement_id_attempt_number|duplicate key/)
  })

  it('the idempotency key is globally unique, so no two attempts can collide', async () => {
    const a = await newDraft()
    const b = await newDraft()
    await insertAttempt(a, 1)
    await expect(
      live((tx) =>
        tx.execute(sql`
          INSERT INTO payout_attempts
            (id, workspace_id, environment, settlement_id, destination_version_id,
             attempt_number, idempotency_key, status, dispatched_by)
          VALUES ('pay_collide', ${WS}, 'sandbox', ${b}, ${versionId}, 1,
                  ${payoutIdempotencyKey(a, 1)}, 'SUBMITTED', 'usr_admin')`),
      ),
    ).rejects.toThrow(/idempotency_key|duplicate key/)
  })

  it('changing the authorized terms does not mint a payout attempt', async () => {
    // The regression stated as a test. Under the old derivation this sequence
    // produced a new key and therefore a new real payout; under this model the
    // terms are not an input to identity at all — and INV-16 refuses the edit
    // outright, so the attack has no first step either.
    const id = await newDraft()
    await h.admin.begin(async (tx) => {
      await tx`
        UPDATE settlements
        SET status = 'AUTHORIZED', authorized_at = now(), authorized_by = 'usr_admin',
            authorized_terms_hash = 'hash_one'
        WHERE id = ${id}`
      await tx`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.authorized',
                'settlement', ${id}, 'user', 'usr_admin')`
    })
    const first = await insertAttempt(id, 1)
    await setStatus(first, 'REJECTED')

    // Two independent reasons the attack fails, and it is worth having both.
    //
    // First: the edit itself is refused — and refused for the *superuser* too,
    // because INV-16 lives in a trigger rather than in a grant. There is no
    // role in this system that can re-aim an authorized instruction.
    await expect(
      live((tx) =>
        tx.execute(sql`UPDATE settlements SET authorized_terms_hash = 'hash_two' WHERE id = ${id}`),
      ),
    ).rejects.toThrow(/immutable/)
    await expect(
      h.admin`UPDATE settlements SET authorized_terms_hash = 'hash_two' WHERE id = ${id}`,
    ).rejects.toThrow(/immutable/)

    // Second, and the one that would still hold if the first were ever relaxed:
    // the next attempt's key does not read the terms, so changing them could not
    // have moved it anyway. The terms are not an input to payout identity.
    await insertAttempt(id, 2)
    const rows = (await live((tx) =>
      tx.execute(sql`
        SELECT idempotency_key FROM payout_attempts
        WHERE settlement_id = ${id} AND attempt_number = 2`),
    )) as unknown as { idempotency_key: string }[]
    expect(rows[0]!.idempotency_key).toBe(payoutIdempotencyKey(id, 2))
  })

  it('an attempt identity is immutable once written', async () => {
    const id = await newDraft()
    const attemptId = await insertAttempt(id, 1)
    for (const set of [
      `attempt_number = 2`,
      `idempotency_key = 'payout:v1:forged:9'`,
      `dispatched_at = now() - interval '1 day'`,
    ]) {
      await expect(
        live((tx) => tx.execute(sql.raw(`UPDATE payout_attempts SET ${set} WHERE id = '${attemptId}'`))),
      ).rejects.toThrow(/identity is immutable/)
    }
  })

  it('a terminal attempt does not come back to life', async () => {
    const id = await newDraft()
    const attemptId = await insertAttempt(id, 1)
    await setStatus(attemptId, 'REJECTED')
    await expect(setStatus(attemptId, 'SUBMITTED')).rejects.toThrow(/terminal/)
    // The one legal move out of a terminal state (P08): a credit that is
    // returned by the rail. It is a fact about the money, not a new payout.
    const other = await newDraft()
    const credited = await insertAttempt(other, 1)
    // A credited attempt carries its UTR and its credit timestamp — the Stage 5
    // CHECK refuses one without them, because a credit we could not evidence is
    // a receipt we could not honour.
    await creditAttempt(credited)
    // P08 carries its own evidence too: a returned attempt is a *credited* one
    // that came back, so it keeps its UTR and its credit timestamp and adds the
    // moment of the return.
    await live((tx) =>
      tx.execute(sql`
        UPDATE payout_attempts SET status = 'RETURNED', returned_at = now()
        WHERE id = ${credited}`),
    )
  })

  it('the app role can advance a status but never delete an attempt', async () => {
    // UPDATE is granted because an attempt has a P01-P08 lifecycle; the trigger,
    // not the grant, is what keeps its identity honest. DELETE is granted
    // nowhere: an attempt that may exist at a provider is never erased.
    await expect(live((tx) => tx.execute(sql`DELETE FROM payout_attempts`))).rejects.toThrow(
      /permission denied/i,
    )
  })

  it('rejects an attempt number below one', async () => {
    // The domain refuses to derive a key for attempt 0 at all, so this has to be
    // written by hand to reach the column check — which is the point: both
    // layers say no, and the database says it to callers the domain never sees.
    const id = await newDraft()
    await expect(
      live((tx) =>
        tx.execute(sql`
          INSERT INTO payout_attempts
            (id, workspace_id, environment, settlement_id, destination_version_id,
             attempt_number, idempotency_key, dispatched_by)
          VALUES ('pay_zero', ${WS}, 'sandbox', ${id}, ${versionId}, 0,
                  'payout:v1:hand-written:0', 'usr_admin')`),
      ),
    ).rejects.toThrow(/attempt_number/)
  })
})

describe('the closed exception taxonomy is closed in the database too', () => {
  it('rejects a code outside the enum', async () => {
    await expect(
      h.admin`SELECT 'OTHER'::settlement_exception_code`,
    ).rejects.toThrow(/invalid input value/) // copy-check:allow — Postgres's own enum error
  })

  it('requires an attributed resolution', async () => {
    const id = await newDraft()
    await expect(
      live((tx) =>
        tx.execute(sql`
          INSERT INTO settlement_exceptions
            (id, workspace_id, environment, settlement_id, code, entered_from, resolved_at)
          VALUES ('exc_x', ${WS}, 'sandbox', ${id}, 'DRAWDOWN_FAILED', 'DRAWDOWN_REQUESTED', now())`),
      ),
    ).rejects.toThrow(/resolution_is_attributed/)
  })

  it('permits at most one open exception per settlement', async () => {
    const id = await newDraft()
    const insert = (excId: string) =>
      live((tx) =>
        tx.execute(sql`
          INSERT INTO settlement_exceptions
            (id, workspace_id, environment, settlement_id, code, entered_from)
          VALUES (${excId}, ${WS}, 'sandbox', ${id}, 'DRAWDOWN_FAILED', 'DRAWDOWN_REQUESTED')`),
      )
    await insert('exc_a')
    await expect(insert('exc_b')).rejects.toThrow(/one_open|duplicate key/)
  })
})

/**
 * `T22` resume integrity — the dynamic resume, hardened.
 *
 * T22 is deliberately dynamic: it resumes to wherever the settlement was when
 * the exception opened, rather than duplicating the transition table into a
 * dozen static rows. That design is right, and it has exactly one soft spot —
 * `exception_entered_from` is T22's destination, so a caller who could write it
 * could choose where the machine goes next and call it a resume.
 *
 * The answer is that the field is never caller-supplied. The database derives
 * what it must equal, freezes it while the exception is open, and refuses every
 * exit that is not the recorded origin or an attributed terminal resolution.
 * These tests attack it as `inrsettle_app` through raw SQL, which is the only
 * level at which "cannot" means anything.
 */
describe('T22 — the resume target cannot be chosen', () => {
  /** Put a settlement in `from`, then open an exception on it, honestly. */
  async function inException(from: string, opts: { ponr?: boolean } = {}): Promise<string> {
    const id = await newDraft()
    await h.admin.begin(async (tx) => {
      // One statement, not two: the pairing trigger fires per UPDATE, so a
      // second touch in the same transaction would be a write with no status
      // change sitting next to a status event. INV-32 catching that in a test
      // fixture is the rule doing its job.
      await tx`
        UPDATE settlements
        SET status = ${from}::settlement_status,
            point_of_no_return_at = CASE WHEN ${opts.ponr === true} THEN now() ELSE NULL END
        WHERE id = ${id}`
      await tx`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.authorized',
                'settlement', ${id}, 'user', 'usr_admin')`
    })
    // Entering EXCEPTION *through the runtime role*, so the derivation below is
    // the one an application would actually hit.
    await live(async (tx) => {
      await tx.execute(sql`
        UPDATE settlements SET status = 'EXCEPTION', exception_entered_from = ${from}::settlement_status
        WHERE id = ${id}`)
      await tx.execute(sql`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.exception_opened',
                'settlement', ${id}, 'user', 'usr_admin')`)
    })
    return id
  }

  /** Attempt to move an in-exception settlement to `to`, paired correctly. */
  const moveTo = (id: string, to: string, event = 'settlement.exception_resolved') =>
    live(async (tx) => {
      await tx.execute(sql.raw(`UPDATE settlements SET status = '${to}' WHERE id = '${id}'`))
      await tx.execute(sql`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', ${event}, 'settlement', ${id}, 'user', 'usr_admin')`)
    })

  const originOf = async (id: string): Promise<string | null> => {
    const rows = (await live((tx) =>
      tx.execute(sql`SELECT exception_entered_from FROM settlements WHERE id = ${id}`),
    )) as unknown as { exception_entered_from: string | null }[]
    return rows[0]!.exception_entered_from
  }

  it('records the origin automatically — a mismatched value is refused', async () => {
    // (1) The field is not a parameter. Whatever the caller offers, it must
    //     equal the row's own previous status, and the database is the one that
    //     knows what that was.
    const id = await newDraft()
    await h.admin.begin(async (tx) => {
      await tx`UPDATE settlements SET status = 'DRAWDOWN_REQUESTED' WHERE id = ${id}`
      await tx`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.drawdown_requested',
                'settlement', ${id}, 'user', 'usr_admin')`
    })
    await expect(
      live(async (tx) => {
        await tx.execute(sql`
          UPDATE settlements
          SET status = 'EXCEPTION', exception_entered_from = 'LIQUIDITY_RESERVED'
          WHERE id = ${id}`)
        await tx.execute(sql`
          INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
          VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.exception_opened',
                  'settlement', ${id}, 'user', 'usr_admin')`)
      }),
    ).rejects.toThrow(/must be the status the settlement came from/)
  })

  it('leaving it null on entry is refused too', async () => {
    const id = await newDraft()
    await expect(
      live(async (tx) => {
        await tx.execute(sql`UPDATE settlements SET status = 'EXCEPTION' WHERE id = ${id}`)
        await tx.execute(sql`
          INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
          VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.exception_opened',
                  'settlement', ${id}, 'user', 'usr_admin')`)
      }),
    ).rejects.toThrow(/must be the status the settlement came from/)
  })

  it('freezes the origin while the exception is open', async () => {
    // (2) Without this, the attack is two steps rather than one: open honestly,
    //     then re-aim, then "resume".
    const id = await inException('DRAWDOWN_REQUESTED')
    await expect(
      live((tx) =>
        tx.execute(sql`UPDATE settlements SET exception_entered_from = 'RECONCILING' WHERE id = ${id}`),
      ),
    ).rejects.toThrow(/frozen while the exception is open/)
    expect(await originOf(id)).toBe('DRAWDOWN_REQUESTED')
  })

  it('resumes only to the exact recorded origin', async () => {
    const id = await inException('DRAWDOWN_REQUESTED')
    for (const wrong of ['LIQUIDITY_RESERVED', 'DRAWDOWN_CONFIRMED', 'PAYOUT_SUBMITTED', 'RECONCILING']) {
      await expect(moveTo(id, wrong)).rejects.toThrow(/a resumed exception returns to/)
    }
    await moveTo(id, 'DRAWDOWN_REQUESTED')
    const rows = (await live((tx) =>
      tx.execute(sql`SELECT status FROM settlements WHERE id = ${id}`),
    )) as unknown as { status: string }[]
    // Not "no raw SQL": the *correct* resume goes through.
    expect(rows[0]!.status).toBe('DRAWDOWN_REQUESTED')
  })

  it('never resumes to a terminal state', async () => {
    // (3) `UPDATE settlements SET status = 'SETTLED'` from an open exception is
    //     the single most valuable write an attacker could make, because SETTLED
    //     is where the money is declared delivered. The origin can never be a
    //     terminal state, so the resume can never land on one.
    const id = await inException('PAYOUT_SUBMITTED')
    await expect(moveTo(id, 'SETTLED', 'settlement.settled')).rejects.toThrow(
      /a resumed exception returns to/,
    )
  })

  it('cannot record a terminal state as the origin in the first place', async () => {
    // Belt and braces at the column, so the previous test cannot be defeated by
    // finding some path that opens an exception from a terminal state.
    const id = await newDraft()
    for (const terminal of ['SETTLED', 'FAILED', 'CANCELLED']) {
      await expect(
        h.admin`
          UPDATE settlements SET exception_entered_from = ${terminal}::settlement_status
          WHERE id = ${id}`,
      ).rejects.toThrow(/exception_entered_from_check|check constraint/)
    }
  })

  it('never resumes to ACTION_REQUIRED', async () => {
    // (4) ACTION_REQUIRED is a *customer-facing* state with its own copy and its
    //     own inbound transitions. Resuming into it would tell a customer to act
    //     on a settlement that is mid-execution, which is both wrong and, after
    //     the point of no return, unactionable.
    const id = await inException('LIQUIDITY_RESERVED')
    await expect(moveTo(id, 'ACTION_REQUIRED', 'settlement.action_required')).rejects.toThrow(
      /a resumed exception returns to/,
    )
    const other = await newDraft()
    await expect(
      h.admin`
        UPDATE settlements SET exception_entered_from = 'ACTION_REQUIRED' WHERE id = ${other}`,
    ).rejects.toThrow(/exception_entered_from_check|check constraint/)
  })

  it('a post-point-of-no-return exception cannot resume to a pre-dispatch state', async () => {
    // (5) INV-36 applied to resumes. A settlement whose money may already be
    //     moving must not land back in a phase where it could be cancelled or
    //     re-reserved. The origin here is honest — the row really was in
    //     DRAWDOWN_REQUESTED — which is what makes the case interesting: the
    //     recorded origin is correct and the resume is still refused.
    const id = await newDraft()
    await h.admin.begin(async (tx) => {
      await tx`UPDATE settlements SET status = 'DRAWDOWN_REQUESTED' WHERE id = ${id}`
      await tx`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.drawdown_requested',
                'settlement', ${id}, 'user', 'usr_admin')`
    })
    await live(async (tx) => {
      await tx.execute(sql`
        UPDATE settlements SET status = 'EXCEPTION', exception_entered_from = 'DRAWDOWN_REQUESTED'
        WHERE id = ${id}`)
      await tx.execute(sql`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.exception_opened',
                'settlement', ${id}, 'user', 'usr_admin')`)
    })
    // The dispatch happened while the exception was open (a rail that answered
    // late), so the row is now past the point of no return.
    await h.admin`UPDATE settlements SET point_of_no_return_at = now() WHERE id = ${id}`

    await expect(moveTo(id, 'DRAWDOWN_REQUESTED')).rejects.toThrow(
      /cannot resume to the pre-dispatch state/,
    )
    // Resolving it terminally is still allowed: a stuck settlement must always
    // have somewhere to go, or the exception becomes a trap.
    await moveTo(id, 'FAILED', 'settlement.failed')
  })

  it('a post-PONR exception still resumes to a post-PONR origin', async () => {
    const id = await inException('PAYOUT_SUBMITTED', { ponr: true })
    await moveTo(id, 'PAYOUT_SUBMITTED')
    const rows = (await live((tx) =>
      tx.execute(sql`SELECT status FROM settlements WHERE id = ${id}`),
    )) as unknown as { status: string }[]
    expect(rows[0]!.status).toBe('PAYOUT_SUBMITTED')
  })

  it('keeps the recorded origin after a resume, rather than erasing the history', async () => {
    const id = await inException('RECONCILING')
    await moveTo(id, 'RECONCILING')
    expect(await originOf(id)).toBe('RECONCILING')
  })
})

describe('optimistic concurrency', () => {
  it('a status change advances the version', async () => {
    const id = await newDraft()
    const before = (
      (await live((tx) => tx.execute(sql`SELECT version FROM settlements WHERE id = ${id}`))) as unknown as {
        version: number
      }[]
    )[0]!.version

    await live(async (tx) => {
      await tx.execute(sql`UPDATE settlements SET status = 'PREFLIGHTING' WHERE id = ${id}`)
      await tx.execute(sql`
        INSERT INTO events (id, workspace_id, environment, type, subject_type, subject_id, actor_type, actor_id)
        VALUES (${`evt_${Math.random()}`}, ${WS}, 'sandbox', 'settlement.preflight_started', 'settlement', ${id}, 'user', 'usr_admin')`)
    })

    const after = (
      (await live((tx) => tx.execute(sql`SELECT version FROM settlements WHERE id = ${id}`))) as unknown as {
        version: number
      }[]
    )[0]!.version
    // Bumped by the trigger, so a caller cannot forget to.
    expect(after).toBe(before + 1)
  })
})

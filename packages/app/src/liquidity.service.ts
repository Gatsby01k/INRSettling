/**
 * The liquidity services — `INV-19` through `INV-23`, `INV-46`, `INV-47`.
 *
 * One rule governs this whole file: **every movement of facility value is a
 * balanced ledger pair, and the facility's `drawn`/`reserved` columns are
 * updated from that pair in the same transaction.** There is no path that
 * changes a facility figure without posting to the ledger, which is what makes
 * `INV-23`'s rebuild meaningful — a projection that can drift from its source
 * only because someone forgot is not a projection, it is a second copy.
 *
 * The second rule is that reservation takes the facility row lock *before*
 * reading availability (`INV-20`). Reading first and locking later is the
 * classic over-allocation bug: two transactions both see enough headroom, both
 * proceed, and the facility ends up funding more than its limit. The database
 * `CHECK` would catch it, but as a constraint violation at commit rather than
 * as a clean refusal — and one of the two settlements would already have told
 * its customer it was under way.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import { money, type CurrencyCode, type Money } from '@inrsettle/money'
import {
  availableToSettle,
  canReserve,
  evaluateRepaymentTransition,
  evaluateReservationTransition,
  ledgerPairFor,
  repaymentFingerprint,
  type FacilityPosition,
  type FacilityStatus,
  type LedgerMovement,
  type PrincipalRef,
  type RepaymentSource,
  type RepaymentTrigger,
  type ReservationReleaseReason,
  type TenantScope,
} from '@inrsettle/domain'
import { eventSink } from './events.js'
import { databaseNow } from './quote.service.js'

/* ── Reading a facility ─────────────────────────────────────────────────── */

export interface FacilityRow {
  readonly id: string
  readonly currency: CurrencyCode
  readonly status: FacilityStatus
  readonly position: FacilityPosition
  readonly available: Money
  readonly version: number
}

interface RawFacility {
  id: string
  currency: string
  status: FacilityStatus
  limit_minor: string | number | bigint
  drawn_minor: string | number | bigint
  reserved_minor: string | number | bigint
  version: number
}

function toFacilityRow(raw: RawFacility): FacilityRow {
  const currency = raw.currency as CurrencyCode
  const position: FacilityPosition = {
    currency,
    limit: money(currency, BigInt(raw.limit_minor)),
    drawn: money(currency, BigInt(raw.drawn_minor)),
    reserved: money(currency, BigInt(raw.reserved_minor)),
  }
  return {
    id: raw.id,
    currency,
    status: raw.status,
    position,
    available: availableToSettle(position),
    version: raw.version,
  }
}

/** One facility by id. The form every mutation and every test reads. */
export async function readFacility(tx: Db, facilityId: string): Promise<FacilityRow | null> {
  const rows = (await tx.execute(sql`
    SELECT id, currency, status, limit_minor, drawn_minor, reserved_minor, version
    FROM liquidity_facilities WHERE id = ${facilityId}`)) as unknown as RawFacility[]
  const raw = rows[0]
  return raw ? toFacilityRow(raw) : null
}

/**
 * Every active facility a workspace holds in a currency, oldest first.
 *
 * Plural on purpose. A workspace normally has one, and the customer surface
 * shows one figure — but a provider migration means two for a while, and a
 * function that silently returned the first of several would report an
 * availability figure that was quietly wrong rather than obviously plural.
 */
export async function listFacilities(
  tx: Db,
  scope: TenantScope,
  currency: CurrencyCode,
): Promise<readonly FacilityRow[]> {
  const rows = (await tx.execute(sql`
    SELECT id, currency, status, limit_minor, drawn_minor, reserved_minor, version
    FROM liquidity_facilities
    WHERE workspace_id = ${scope.workspaceId} AND environment = ${scope.environment}
      AND currency = ${currency} AND status = 'ACTIVE'
    ORDER BY created_at, id`)) as unknown as RawFacility[]
  return rows.map(toFacilityRow)
}

/** The same read, under `SELECT … FOR UPDATE`. Every mutation starts here. */
async function lockFacility(tx: Db, facilityId: string): Promise<FacilityRow | null> {
  const rows = (await tx.execute(sql`
    SELECT id, currency, status, limit_minor, drawn_minor, reserved_minor, version
    FROM liquidity_facilities WHERE id = ${facilityId} FOR UPDATE`)) as unknown as RawFacility[]
  const raw = rows[0]
  return raw ? toFacilityRow(raw) : null
}

/* ── The ledger (INV-23) ────────────────────────────────────────────────── */

/**
 * Post one balanced movement and move the projection with it.
 *
 * Both halves happen here, in one place, so there is no way to write a ledger
 * entry without updating the facility or the reverse. The deferred balance
 * trigger checks the pair at commit; this function is what makes the pair exist.
 */
async function postMovement(
  tx: Db,
  scope: TenantScope,
  input: {
    facilityId: string
    movement: Exclude<LedgerMovement, 'limit_changed'>
    amount: Money
    subjectType: string
    subjectId: string
    actor: PrincipalRef
  },
): Promise<string> {
  const { debit, credit } = ledgerPairFor(input.movement)
  const transferId = newId('ledgerTransfer')

  for (const [account, direction] of [
    [debit, 'debit'],
    [credit, 'credit'],
  ] as const) {
    await tx.insert(schema.ledgerEntries).values({
      id: newId('ledgerEntry'),
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      facilityId: input.facilityId,
      transferId,
      movement: input.movement,
      account,
      direction,
      amountMinor: input.amount.minorUnits,
      amountCurrency: input.amount.currency,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      createdBy: input.actor.id,
    })
  }

  // The projection, moved by the same amounts the pair names. Written as SQL
  // arithmetic rather than read-modify-write because the row is already locked
  // and this keeps the update atomic with respect to the CHECK.
  const delta = (account: 'drawn' | 'reserved'): bigint =>
    (debit === account ? input.amount.minorUnits : 0n) -
    (credit === account ? input.amount.minorUnits : 0n)

  await tx.execute(sql`
    UPDATE liquidity_facilities
    SET drawn_minor    = drawn_minor + ${delta('drawn')},
        reserved_minor = reserved_minor + ${delta('reserved')}
    WHERE id = ${input.facilityId}`)

  return transferId
}

/* ── V01 — reserve ──────────────────────────────────────────────────────── */

export type ReserveResult =
  | { ok: true; reservationId: string; available: Money; expiresAt: Date }
  | {
      ok: false
      reason: 'facility_not_found' | 'facility_not_active' | 'insufficient_availability'
        | 'currency_mismatch' | 'already_reserved'
    }

/**
 * Reserve liquidity for a settlement — `INV-20`.
 *
 * `ttlSeconds` is supplied by the caller from configuration and is never
 * defaulted here. `D-05` (reservation TTL) is a commercial and operational
 * parameter: too short strands settlements, too long strands liquidity, and
 * neither number can be invented from first principles. The *mechanism* is
 * closed and lives here; the duration arrives from outside.
 */
export async function reserveLiquidity(
  tx: Db,
  scope: TenantScope,
  input: {
    facilityId: string
    settlementId: string
    amount: Money
    ttlSeconds: number
    actor: PrincipalRef
  },
): Promise<ReserveResult> {
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new RangeError(`reservation TTL must be a positive whole number of seconds, got ${input.ttlSeconds}`)
  }

  // (1) Lock, then read. Not the other way round (`INV-20`).
  const facility = await lockFacility(tx, input.facilityId)
  if (!facility) return { ok: false, reason: 'facility_not_found' }

  const permitted = canReserve(facility.position, facility.status, input.amount)
  if (!permitted.ok) return { ok: false, reason: permitted.reason }

  // (2) INV-21 is enforced by a partial unique index; checking here as well
  //     turns a constraint violation into a named refusal the caller can act on.
  const existing = (await tx.execute(sql`
    SELECT id FROM liquidity_reservations
    WHERE settlement_id = ${input.settlementId} AND status = 'ACTIVE'`)) as unknown as { id: string }[]
  if (existing.length > 0) return { ok: false, reason: 'already_reserved' }

  const now = await databaseNow(tx)
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000)
  const reservationId = newId('liquidityReservation')

  await tx.insert(schema.liquidityReservations).values({
    id: reservationId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    facilityId: facility.id,
    settlementId: input.settlementId,
    amountMinor: input.amount.minorUnits,
    amountCurrency: input.amount.currency,
    status: 'ACTIVE',
    expiresAt,
  })

  await postMovement(tx, scope, {
    facilityId: facility.id,
    movement: 'reservation_created',
    amount: input.amount,
    subjectType: 'liquidity_reservation',
    subjectId: reservationId,
    actor: input.actor,
  })

  const events = eventSink(tx)
  await events.event(scope, {
    type: 'facility.reservation_created',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    actor: input.actor,
    payload: { reservation_id: reservationId, amount_minor: input.amount.minorUnits.toString() },
    deliver: true,
  })

  const after = await lockFacility(tx, facility.id)
  return { ok: true, reservationId, available: after!.available, expiresAt }
}

/* ── V02 — consume, V03 — release, V04 — expire ─────────────────────────── */

export type ReservationResult =
  | { ok: true; reservationId: string; noop: boolean }
  | { ok: false; reason: 'reservation_not_found' | 'consumed_cannot_be_released' | 'invalid_transition' }

interface RawReservation {
  id: string
  facility_id: string
  settlement_id: string
  amount_minor: string | number | bigint
  amount_currency: string
  status: 'ACTIVE' | 'CONSUMED' | 'RELEASED' | 'EXPIRED'
}

async function lockReservation(tx: Db, settlementId: string): Promise<RawReservation | null> {
  // Ordered so the most recent is first: a settlement may have historical
  // released reservations beside the one that matters.
  const rows = (await tx.execute(sql`
    SELECT id, facility_id, settlement_id, amount_minor, amount_currency, status
    FROM liquidity_reservations
    WHERE settlement_id = ${settlementId}
    ORDER BY (status = 'ACTIVE') DESC, created_at DESC
    LIMIT 1 FOR UPDATE`)) as unknown as RawReservation[]
  return rows[0] ?? null
}

/**
 * Release a reservation — `INV-22`.
 *
 * Idempotent under repeated cancel, fail and expiry: releasing an already
 * released or expired reservation is a no-op and reports itself as one. It is
 * **not** idempotent over `CONSUMED`, which returns a typed refusal, because a
 * consumed reservation has no value left on the reservation side and releasing
 * it would credit the facility for money that is still drawn.
 */
export async function releaseReservation(
  tx: Db,
  scope: TenantScope,
  input: {
    settlementId: string
    reason: ReservationReleaseReason
    actor: PrincipalRef
    /** V04 rather than V03. Both release; only the audit trail differs. */
    expired?: boolean
  },
): Promise<ReservationResult> {
  const reservation = await lockReservation(tx, input.settlementId)
  if (!reservation) return { ok: false, reason: 'reservation_not_found' }

  const trigger = input.expired === true ? 'expire' : 'release'
  const evaluated = evaluateReservationTransition(reservation.status, trigger)

  if (!evaluated.ok) {
    if (evaluated.error === 'consumed_cannot_be_released') {
      return { ok: false, reason: 'consumed_cannot_be_released' }
    }
    // ACTIVE is the only state with an outgoing release, so anything else here
    // is RELEASED or EXPIRED — a repeat, which is the idempotent case.
    if (reservation.status === 'RELEASED' || reservation.status === 'EXPIRED') {
      return { ok: true, reservationId: reservation.id, noop: true }
    }
    return { ok: false, reason: 'invalid_transition' }
  }

  const facility = await lockFacility(tx, reservation.facility_id)
  if (!facility) return { ok: false, reason: 'reservation_not_found' }

  const now = await databaseNow(tx)
  await tx
    .update(schema.liquidityReservations)
    .set({ status: evaluated.to, releasedAt: now, releasedReason: input.reason })
    .where(
      and(
        eq(schema.liquidityReservations.id, reservation.id),
        eq(schema.liquidityReservations.status, 'ACTIVE'),
      ),
    )

  const amount = money(reservation.amount_currency as CurrencyCode, BigInt(reservation.amount_minor))
  await postMovement(tx, scope, {
    facilityId: reservation.facility_id,
    movement: evaluated.movement as Exclude<LedgerMovement, 'limit_changed'>,
    amount,
    subjectType: 'liquidity_reservation',
    subjectId: reservation.id,
    actor: input.actor,
  })

  const events = eventSink(tx)
  await events.event(scope, {
    type: input.expired === true ? 'facility.reservation_expired' : 'facility.reservation_released',
    subjectType: 'settlement',
    subjectId: input.settlementId,
    actor: input.actor,
    payload: { reservation_id: reservation.id, reason: input.reason },
    deliver: true,
  })

  return { ok: true, reservationId: reservation.id, noop: false }
}

/**
 * Consume a reservation — V02, driven by a confirmed drawdown (T13).
 *
 * One movement, `reserved → drawn`. The value does not pass through `available`
 * on its way, because it was never spendable again: it went from committed to
 * this settlement to drawn for this settlement.
 */
export async function consumeReservation(
  tx: Db,
  scope: TenantScope,
  input: { settlementId: string; actor: PrincipalRef },
): Promise<ReservationResult> {
  const reservation = await lockReservation(tx, input.settlementId)
  if (!reservation) return { ok: false, reason: 'reservation_not_found' }

  const evaluated = evaluateReservationTransition(reservation.status, 'consume')
  if (!evaluated.ok) return { ok: false, reason: 'invalid_transition' }

  const now = await databaseNow(tx)
  await tx
    .update(schema.liquidityReservations)
    .set({ status: 'CONSUMED', consumedAt: now })
    .where(
      and(
        eq(schema.liquidityReservations.id, reservation.id),
        eq(schema.liquidityReservations.status, 'ACTIVE'),
      ),
    )

  await lockFacility(tx, reservation.facility_id)
  await postMovement(tx, scope, {
    facilityId: reservation.facility_id,
    movement: 'reservation_consumed',
    amount: money(reservation.amount_currency as CurrencyCode, BigInt(reservation.amount_minor)),
    subjectType: 'liquidity_reservation',
    subjectId: reservation.id,
    actor: input.actor,
  })

  return { ok: true, reservationId: reservation.id, noop: false }
}

/* ── Repayment (Y01–Y08) ────────────────────────────────────────────────── */

export type RepaymentResult =
  | { ok: true; repaymentId: string; status: string; capacityRestored: boolean }
  | { ok: false; reason: string; detail?: unknown }

/**
 * How much of this facility's drawn value may still be claimed by a *new*
 * repayment: `drawn` minus everything already in flight.
 *
 * `INV-46` excludes in-flight repayments from *availability*, which is about
 * what a customer may spend. This is the mirror question — what may still be
 * repaid — and it has to net them off for the opposite reason: a repayment that
 * has not confirmed has not reduced `drawn`, so a second one sized against the
 * raw `drawn` figure would be sized against money the first one is already
 * coming back for.
 *
 * Read under the facility row lock the caller already holds.
 */
async function eligibleOutstanding(tx: Db, facilityId: string): Promise<bigint> {
  const rows = (await tx.execute(sql`
    SELECT f.drawn_minor AS drawn,
           COALESCE((
             SELECT sum(r.amount_minor) FROM repayments r
             WHERE r.facility_id = f.id
               AND r.status IN ('REQUESTED', 'SUBMITTED', 'UNKNOWN')
           ), 0) AS in_flight
    FROM liquidity_facilities f WHERE f.id = ${facilityId}`)) as unknown as {
    drawn: string | number | bigint
    in_flight: string | number | bigint
  }[]
  const row = rows[0]
  if (!row) return 0n
  const eligible = BigInt(row.drawn) - BigInt(row.in_flight)
  return eligible > 0n ? eligible : 0n
}

/**
 * Y01 — request a repayment. **This does not restore capacity** (`INV-46`).
 *
 * The most important thing this function does is *not* touch `drawn`. A
 * repayment that has been requested is money we intend to give back and the
 * provider has not confirmed receiving; treating it as capacity would let a
 * workspace settle against funds that are still out.
 */
export async function requestRepayment(
  tx: Db,
  scope: TenantScope,
  input: {
    facilityId: string
    amount: Money
    source: RepaymentSource
    settlementId?: string
    returnId?: string
    actor: PrincipalRef
  },
): Promise<RepaymentResult> {
  const evaluated = evaluateRepaymentTransition(null, 'request')
  if (!evaluated.ok) return { ok: false, reason: 'invalid_transition' }

  // (a) The facility must be *this tenant's*. `readFacility` runs under RLS, so
  //     a facility belonging to another workspace or environment simply is not
  //     there. Checking here turns that into a named refusal; without it the
  //     repayment row would be written in this tenant's scope against a
  //     facility we cannot see, and the confirming UPDATE would silently match
  //     zero rows while the ledger entry was written anyway — a projection
  //     divergence manufactured by a typo in a facility id.
  const facility = await lockFacility(tx, input.facilityId)
  if (!facility) return { ok: false, reason: 'facility_not_found' }

  // (b) One currency. A repayment denominated in something the facility does
  //     not hold is not a smaller or larger repayment, it is a category error.
  if (input.amount.currency !== facility.currency) {
    return {
      ok: false,
      reason: 'currency_mismatch',
      detail: { facility: facility.currency, repayment: input.amount.currency },
    }
  }

  if (input.amount.minorUnits <= 0n) return { ok: false, reason: 'amount_not_positive' }

  // (c) The eligibility ceiling, and the reason this function reads the
  //     database at all.
  //
  //     A repayment may not exceed what is actually outstanding *and not
  //     already claimed by another repayment*. Subtracting the in-flight ones
  //     is the part that is easy to miss: two repayments each for the full
  //     drawn amount are individually plausible, and confirming both would
  //     restore capacity twice for money that went out once. The database
  //     `CHECK (drawn_minor >= 0)` catches that at the second confirmation —
  //     but as a constraint violation on a transaction that has already told
  //     someone their repayment was accepted. Refusing at request time is the
  //     difference between a clean answer and an incident.
  const outstanding = await eligibleOutstanding(tx, input.facilityId)
  if (input.amount.minorUnits > outstanding) {
    return {
      ok: false,
      reason: 'exceeds_outstanding',
      detail: {
        requested: input.amount.minorUnits.toString(),
        eligible: outstanding.toString(),
        drawn: facility.position.drawn.minorUnits.toString(),
      },
    }
  }

  const repaymentId = newId('repayment')
  await tx.insert(schema.repayments).values({
    id: repaymentId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    facilityId: input.facilityId,
    amountMinor: input.amount.minorUnits,
    amountCurrency: input.amount.currency,
    source: input.source,
    settlementId: input.settlementId ?? null,
    returnId: input.returnId ?? null,
    status: 'REQUESTED',
    attempt: 1,
    requestFingerprint: repaymentFingerprint(repaymentId, 1),
  })

  const events = eventSink(tx)
  await events.event(scope, {
    type: 'facility.repayment_requested',
    subjectType: input.settlementId ? 'settlement' : 'facility',
    subjectId: input.settlementId ?? input.facilityId,
    actor: input.actor,
    payload: {
      repayment_id: repaymentId,
      amount_minor: input.amount.minorUnits.toString(),
      source: input.source,
      // Said out loud in the event, because operations reads this: the facility
      // has not got this money back yet and availability has not moved.
      capacity_restored: false,
    },
    deliver: true,
  })

  return { ok: true, repaymentId, status: 'REQUESTED', capacityRestored: false }
}

interface RawRepayment {
  id: string
  facility_id: string
  amount_minor: string | number | bigint
  amount_currency: string
  status: 'REQUESTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'
  attempt: number
  request_fingerprint: string
  settlement_id: string | null
}

/**
 * Advance a repayment — Y02–Y08.
 *
 * The single branch that matters is `restoresCapacity`. It is read from the
 * frozen table rather than decided here, so `INV-46` holds by construction:
 * only the transitions the document marks as capacity-restoring post a ledger
 * movement, and the document marks exactly Y03 and Y06.
 */
export async function advanceRepayment(
  tx: Db,
  scope: TenantScope,
  input: {
    repaymentId: string
    trigger: RepaymentTrigger
    actor: PrincipalRef
    providerReference?: string
    /** Y08 only: an attributed operator decision. */
    reason?: string
  },
): Promise<RepaymentResult> {
  const rows = (await tx.execute(sql`
    SELECT id, facility_id, amount_minor, amount_currency, status, attempt,
           request_fingerprint, settlement_id
    FROM repayments WHERE id = ${input.repaymentId} FOR UPDATE`)) as unknown as RawRepayment[]
  const current = rows[0]
  if (!current) return { ok: false, reason: 'repayment_not_found' }

  const evaluated = evaluateRepaymentTransition(current.status, input.trigger)
  if (!evaluated.ok) {
    return { ok: false, reason: 'invalid_transition', detail: { from: current.status, trigger: input.trigger } }
  }

  const now = await databaseNow(tx)
  const patch: Record<string, unknown> = { status: evaluated.to }
  if (evaluated.to === 'SUBMITTED') patch['submittedAt'] = now
  if (evaluated.to === 'CONFIRMED') patch['confirmedAt'] = now
  if (evaluated.to === 'FAILED') patch['failedAt'] = now
  if (input.providerReference) patch['providerReference'] = input.providerReference

  if (evaluated.requiresNewFingerprint) {
    // Y08. A re-request is a *new* submission and must never present the key of
    // the one that failed (`INV-47`); the database refuses it too.
    const attempt = current.attempt + 1
    patch['attempt'] = attempt
    patch['requestFingerprint'] = repaymentFingerprint(current.id, attempt)
    patch['failedAt'] = null
    patch['providerReference'] = null
  }

  await tx.update(schema.repayments).set(patch as never).where(eq(schema.repayments.id, current.id))

  // The one transition that gives capacity back.
  if (evaluated.restoresCapacity) {
    await lockFacility(tx, current.facility_id)
    await postMovement(tx, scope, {
      facilityId: current.facility_id,
      movement: 'repayment_confirmed',
      amount: money(current.amount_currency as CurrencyCode, BigInt(current.amount_minor)),
      subjectType: 'repayment',
      subjectId: current.id,
      actor: input.actor,
    })
  }

  const events = eventSink(tx)
  await events.event(scope, {
    type: evaluated.restoresCapacity ? 'facility.repayment_confirmed' : 'facility.repayment_updated',
    subjectType: current.settlement_id ? 'settlement' : 'facility',
    subjectId: current.settlement_id ?? current.facility_id,
    actor: input.actor,
    payload: {
      repayment_id: current.id,
      transition: evaluated.id,
      to: evaluated.to,
      capacity_restored: evaluated.restoresCapacity,
    },
    deliver: true,
  })
  await events.audit(scope, {
    actor: input.actor,
    action: `facility.repayment_${input.trigger}`,
    subjectType: 'repayment',
    subjectId: current.id,
    before: { status: current.status, attempt: current.attempt },
    after: { status: evaluated.to, transition: evaluated.id },
    ...(input.reason ? { reason: input.reason } : {}),
  })

  return {
    ok: true,
    repaymentId: current.id,
    status: evaluated.to,
    capacityRestored: evaluated.restoresCapacity,
  }
}

/* ── INV-23 — the projection check ──────────────────────────────────────── */

export interface ProjectionCheck {
  readonly facilityId: string
  readonly agrees: boolean
  readonly projected: { drawnMinor: bigint; reservedMinor: bigint }
  readonly stored: { drawnMinor: bigint; reservedMinor: bigint }
}

/**
 * Compare the facility's cached figures against the ledger.
 *
 * *"If the projection and the ledger disagree, the ledger wins and an
 * operational alarm fires."* This function is the comparison; the caller raises
 * the alarm. Kept separate so the sweeper and the test can ask the same
 * question, and so the answer is data rather than a thrown exception — a
 * divergence needs reporting, not a crashed job.
 */
export async function checkFacilityProjection(tx: Db, facilityId: string): Promise<ProjectionCheck> {
  const rows = (await tx.execute(sql`
    SELECT f.drawn_minor AS stored_drawn,
           f.reserved_minor AS stored_reserved,
           p.drawn_minor AS projected_drawn,
           p.reserved_minor AS projected_reserved
    FROM liquidity_facilities f, project_facility_position(f.id) p
    WHERE f.id = ${facilityId}`)) as unknown as {
    stored_drawn: string | number | bigint
    stored_reserved: string | number | bigint
    projected_drawn: string | number | bigint
    projected_reserved: string | number | bigint
  }[]
  const row = rows[0]
  if (!row) throw new Error(`facility ${facilityId} not found`)

  const stored = {
    drawnMinor: BigInt(row.stored_drawn),
    reservedMinor: BigInt(row.stored_reserved),
  }
  const projected = {
    drawnMinor: BigInt(row.projected_drawn),
    reservedMinor: BigInt(row.projected_reserved),
  }
  return {
    facilityId,
    agrees: stored.drawnMinor === projected.drawnMinor && stored.reservedMinor === projected.reservedMinor,
    projected,
    stored,
  }
}

/* ── Creating a facility ────────────────────────────────────────────────── */

export async function createFacility(
  tx: Db,
  scope: TenantScope,
  input: { providerId: string; currency: CurrencyCode; limit: Money; actor: PrincipalRef },
): Promise<{ id: string }> {
  if (input.limit.currency !== input.currency) {
    throw new Error(`facility currency ${input.currency} does not match its limit ${input.limit.currency}`)
  }
  const id = newId('liquidityFacility')
  await tx.insert(schema.liquidityFacilities).values({
    id,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    providerId: input.providerId,
    currency: input.currency,
    limitMinor: input.limit.minorUnits,
    status: 'ACTIVE',
  })

  const events = eventSink(tx)
  await events.audit(scope, {
    actor: input.actor,
    action: 'facility.create',
    subjectType: 'facility',
    subjectId: id,
    after: { limit_minor: input.limit.minorUnits.toString(), currency: input.currency },
  })
  return { id }
}

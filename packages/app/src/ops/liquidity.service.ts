/**
 * The two things `ops_liquidity` can do — `SECURITY.md § 3.2`.
 *
 * > `ops_liquidity` (facility limits, repayments)
 *
 * Both are writes, so both go through the **application** role inside
 * `withTenant`, exactly like a customer action: `inrsettle_ops` holds no write
 * privilege anywhere, and every constraint, trigger and ledger rule that
 * governs a facility governs an operator changing one.
 *
 * ## What a limit change is, and what it is not
 *
 * Raising a limit raises headroom. It does **not** move money, post a ledger
 * entry, or touch `drawn` or `reserved` — availability is
 * `limit − drawn − reserved` (`INV-19`), derived rather than stored, so a limit
 * change moves one term of that subtraction and nothing else.
 *
 * Lowering one is the interesting direction. A limit cannot be lowered below
 * what is already committed: `drawn + reserved` is money that has moved or is
 * promised, and a limit under it would make availability negative — which
 * `availableToSettle` treats as an incident rather than a number, and which the
 * database `CHECK` refuses independently. So this function refuses first, with
 * a reason the operator can act on, rather than letting a constraint violation
 * surface as a failed request.
 *
 * ## Why suspending is here and closing is not
 *
 * `FACILITY_SUSPENDED` is an exception code the machine already knows
 * (`STATE_MACHINES.md § 7`), so suspension is an operational state with a
 * defined consequence: new reservations stop, existing ones stand. Closing a
 * facility is a commercial act with a settlement question attached — what
 * happens to a drawdown outstanding against a facility that no longer exists —
 * and `D-16b` has not answered it. It is not invented here.
 */
import { sql } from 'drizzle-orm'
import type { Db, TenantScope } from '@inrsettle/db'
import { withTenant } from '@inrsettle/db'
import { money, type CurrencyCode, type Money } from '@inrsettle/money'
import { advanceRepayment } from '../liquidity.service.js'
import type { RepaymentTrigger } from '@inrsettle/domain'
import { eventSink } from '../events.js'
import { requireCapability, writeOperatorRecord, type OperatorContext } from './access.service.js'

/* ── Facility limits ────────────────────────────────────────────────────── */

export type SetFacilityLimitResult =
  | { ok: true; facilityId: string; previous: Money; next: Money; available: Money }
  | {
      ok: false
      reason: 'facility_not_found' | 'currency_mismatch' | 'below_committed' | 'facility_closed'
      committed?: Money
    }

export async function setFacilityLimit(
  appDb: Db,
  scope: TenantScope,
  ctx: OperatorContext,
  input: { facilityId: string; limit: Money },
): Promise<SetFacilityLimitResult> {
  requireCapability(ctx, 'ops:liquidity_manage')

  return withTenant(appDb, scope, async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT id, currency, status, limit_minor, drawn_minor, reserved_minor, version
        FROM liquidity_facilities WHERE id = ${input.facilityId} FOR UPDATE`)) as unknown as {
      id: string; currency: string; status: string
      limit_minor: string; drawn_minor: string; reserved_minor: string; version: number
    }[]
    const facility = locked[0]
    if (!facility) return { ok: false as const, reason: 'facility_not_found' as const }
    if (facility.status === 'CLOSED') return { ok: false as const, reason: 'facility_closed' as const }
    if (facility.currency !== input.limit.currency) {
      return { ok: false as const, reason: 'currency_mismatch' as const }
    }

    const currency = facility.currency as CurrencyCode
    const committedMinor = BigInt(facility.drawn_minor) + BigInt(facility.reserved_minor)
    if (input.limit.minorUnits < committedMinor) {
      // Refused here, with a figure, rather than letting the CHECK reject it:
      // an operator lowering a limit needs to know what it is already carrying,
      // and "constraint violation" is not that.
      return {
        ok: false as const,
        reason: 'below_committed' as const,
        committed: money(currency, committedMinor),
      }
    }

    const previous = money(currency, BigInt(facility.limit_minor))
    await tx.execute(sql`
      UPDATE liquidity_facilities
         SET limit_minor = ${input.limit.minorUnits.toString()}::bigint,
             version = version + 1,
             updated_at = now()
       WHERE id = ${input.facilityId}`)

    await eventSink(tx).audit(scope, {
      actor: ctx.operator.principal,
      action: 'ops.facility_limit_changed',
      subjectType: 'facility',
      subjectId: input.facilityId,
      before: { limit_minor: facility.limit_minor, currency },
      after: { limit_minor: input.limit.minorUnits.toString(), currency },
      reason: ctx.reason,
    })
    await writeOperatorRecord(tx, scope, ctx, 'write', {
      subjectType: 'facility', subjectId: input.facilityId,
    })

    return {
      ok: true as const,
      facilityId: input.facilityId,
      previous,
      next: input.limit,
      available: money(currency, input.limit.minorUnits - committedMinor),
    }
  })
}

/* ── Suspension ─────────────────────────────────────────────────────────── */

export type SetFacilityStatusResult =
  | { ok: true; facilityId: string; from: string; to: 'ACTIVE' | 'SUSPENDED' }
  | { ok: false; reason: 'facility_not_found' | 'facility_closed' | 'no_change' }

/**
 * Suspend a facility, or bring it back.
 *
 * Suspension stops new reservations; it does not unwind existing ones. A
 * reservation already made is a promise against money the settlement is
 * counting on, and cancelling it because the facility was suspended would fail
 * settlements that were fine.
 */
export async function setFacilityStatus(
  appDb: Db,
  scope: TenantScope,
  ctx: OperatorContext,
  input: { facilityId: string; status: 'ACTIVE' | 'SUSPENDED' },
): Promise<SetFacilityStatusResult> {
  requireCapability(ctx, 'ops:liquidity_manage')

  return withTenant(appDb, scope, async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT id, status FROM liquidity_facilities
       WHERE id = ${input.facilityId} FOR UPDATE`)) as unknown as
      { id: string; status: string }[]
    const facility = locked[0]
    if (!facility) return { ok: false as const, reason: 'facility_not_found' as const }
    if (facility.status === 'CLOSED') return { ok: false as const, reason: 'facility_closed' as const }
    if (facility.status === input.status) return { ok: false as const, reason: 'no_change' as const }

    await tx.execute(sql`
      UPDATE liquidity_facilities
         SET status = ${input.status}::facility_status, version = version + 1, updated_at = now()
       WHERE id = ${input.facilityId}`)

    await eventSink(tx).audit(scope, {
      actor: ctx.operator.principal,
      action: input.status === 'SUSPENDED' ? 'ops.facility_suspended' : 'ops.facility_reactivated',
      subjectType: 'facility',
      subjectId: input.facilityId,
      before: { status: facility.status },
      after: { status: input.status },
      reason: ctx.reason,
    })
    await writeOperatorRecord(tx, scope, ctx, 'write', {
      subjectType: 'facility', subjectId: input.facilityId,
    })

    return {
      ok: true as const,
      facilityId: input.facilityId,
      from: facility.status,
      to: input.status,
    }
  })
}

/* ── Repayments ─────────────────────────────────────────────────────────── */

export type AdvanceRepaymentResult =
  | { ok: true; repaymentId: string; status: string }
  | { ok: false; reason: string }


/**
 * Move a repayment along — submitted, confirmed, or failed.
 *
 * A thin operator wrapper over `advanceRepayment`, which holds the rule that
 * matters: **availability moves when the repayment confirms and not before**
 * (`INV-46`). An operator recording a confirmation is telling the system that
 * money arrived, and the ledger movement follows from that fact rather than
 * from the operator's authority — which is why this delegates rather than
 * writing its own update.
 */
export async function advanceRepaymentAsOperator(
  appDb: Db,
  scope: TenantScope,
  ctx: OperatorContext,
  input: {
    repaymentId: string
    /** The repayment machine's own vocabulary, not a status name. */
    trigger: RepaymentTrigger
    providerReference?: string
  },
): Promise<AdvanceRepaymentResult> {
  requireCapability(ctx, 'ops:liquidity_manage')

  return withTenant(appDb, scope, async (tx) => {
    const advanced = await advanceRepayment(tx, scope, {
      repaymentId: input.repaymentId,
      trigger: input.trigger,
      actor: ctx.operator.principal,
      // `Y08` is the attributed operator decision, and the reason it wants is
      // the one this operator already gave.
      reason: ctx.reason,
      ...(input.providerReference === undefined
        ? {}
        : { providerReference: input.providerReference }),
    })
    if (!advanced.ok) return { ok: false as const, reason: advanced.reason }

    await eventSink(tx).audit(scope, {
      actor: ctx.operator.principal,
      action: 'ops.repayment_advanced',
      subjectType: 'repayment',
      subjectId: input.repaymentId,
      after: { trigger: input.trigger },
      reason: ctx.reason,
    })
    await writeOperatorRecord(tx, scope, ctx, 'write', {
      subjectType: 'repayment', subjectId: input.repaymentId,
    })

    return { ok: true as const, repaymentId: input.repaymentId, status: advanced.status }
  })
}

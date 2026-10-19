import { and, eq } from 'drizzle-orm'
import type postgres from 'postgres'
import { schema, withTenant, type Db } from '@inrsettle/db'
import { money, type CurrencyCode } from '@inrsettle/money'
import { isTerminal, payoutIdempotencyKey, type PrincipalRef, type TenantScope } from '@inrsettle/domain'
import {
  activeMappingTable, advanceRepayment, applyObservation, beginReconciliation, chooseRail,
  compensateCancellation, completeReservation, decryptAccountNumberForVerification,
  dispatchPayout, evaluateAndSettle, getSettlement, honourCancellation, issueReceipt,
  listFacilities, pullPayoutStatus, requestDrawdown, reserveForSettlement, resolveDrawdown,
  sweepPayoutSla, type FieldCipher,
} from '@inrsettle/app-services'
import { persistentSandboxPayout, simulatedFunding } from './simulator.js'

const actor: PrincipalRef = { type: 'job', id: 'settlement.execute' }
function accepted<T extends { ok: boolean }>(result: T): T {
  if (!result.ok) throw new Error(`Execution refused: ${JSON.stringify(result)}`)
  return result
}

async function finishCancellationRepayments(db: Db, simulator: postgres.Sql, scope: TenantScope, settlementId: string) {
  const rows = await withTenant(db, scope, tx => tx.select().from(schema.repayments).where(and(
    eq(schema.repayments.settlementId, settlementId), eq(schema.repayments.source, 'CANCELLATION_AFTER_DRAWDOWN'),
  )))
  for (const row of rows) {
    if (row.status !== 'REQUESTED' && row.status !== 'SUBMITTED') continue
    if (row.status === 'REQUESTED') accepted(await withTenant(db, scope, tx => advanceRepayment(tx, scope, {
      repaymentId: row.id, trigger: 'submit', actor,
    })))
    const evidence = await simulatedFunding(simulator, scope, row.requestFingerprint, row.amountMinor, row.amountCurrency)
    accepted(await withTenant(db, scope, tx => advanceRepayment(tx, scope, {
      repaymentId: row.id, trigger: 'confirmed', actor, providerReference: evidence.providerReference,
    })))
  }
}

/** Every transition is delegated to an existing application service. The
 * counterparty evidence is simulated; no live money can enter this runtime. */
export async function executeSandboxSettlement(
  db: Db, simulator: postgres.Sql, cipher: FieldCipher,
  scope: TenantScope, settlementId: string,
): Promise<void> {
  if (scope.environment !== 'sandbox') throw new Error('Sandbox execution refuses live')
  const within = <T>(fn: (tx: Db) => Promise<T>) => withTenant(db, scope, fn)
  const provider = persistentSandboxPayout(simulator, scope)
  const mapping = await within(tx => activeMappingTable(tx, provider.id))
  if (!mapping) throw new Error('Provider mapping is missing')
  await finishCancellationRepayments(db, simulator, scope, settlementId)

  for (let step = 0; step < 16; step += 1) {
    const settlement = await within(tx => getSettlement(tx, settlementId))
    if (!settlement || isTerminal(settlement.status)) return
    // The snapshot, not today's market rate, owns the funding leg.
    const snapshot = settlement.authorizedTerms as { terms?: { funding_amount: { minor_units: string; currency: CurrencyCode } } } | null
    if (!snapshot?.terms) return
    const funding = money(snapshot.terms.funding_amount.currency, BigInt(snapshot.terms.funding_amount.minor_units))
    const facilities = await within(tx => listFacilities(tx, scope, funding.currency))
    const facility = facilities[0]
    if (!facility) throw new Error('No configured sandbox facility')

    if (settlement.cancellationRequestedAt && !settlement.pointOfNoReturnAt && settlement.status !== 'DRAWDOWN_REQUESTED') {
      const compensation = accepted(await within(tx => compensateCancellation(tx, scope, { settlementId, actor })))
      accepted(await within(tx => honourCancellation(tx, scope, { settlementId, actor,
        facilityCompensation: compensation.ok && compensation.compensation === 'repayment_requested' ? 'repayment' : 'release',
      })))
      await finishCancellationRepayments(db, simulator, scope, settlementId)
      return
    }

    switch (settlement.status) {
      case 'AUTHORIZED':
        accepted(await reserveForSettlement(db, scope, { settlementId, facilityId: facility.id, fundingAmount: funding, ttlSeconds: 900, actor }))
        break
      case 'LIQUIDITY_RESERVING':
        accepted(await within(tx => completeReservation(tx, scope, { settlementId, facilityId: facility.id, fundingAmount: funding, ttlSeconds: 900, actor })))
        break
      case 'LIQUIDITY_RESERVED':
        accepted(await within(tx => requestDrawdown(tx, scope, { settlementId, actor })))
        break
      case 'DRAWDOWN_REQUESTED': {
        const [drawdown] = await within(tx => tx.select().from(schema.drawdowns).where(eq(schema.drawdowns.settlementId, settlementId)).limit(1))
        if (!drawdown) throw new Error('Drawdown record is missing')
        const evidence = await simulatedFunding(simulator, scope, drawdown.requestFingerprint, drawdown.amountMinor, drawdown.amountCurrency)
        accepted(await within(tx => resolveDrawdown(tx, scope, { settlementId, actor, trigger: 'confirmed',
          providerReference: evidence.providerReference, providerEventVerified: true, evidence: { ...evidence, facilityId: drawdown.facilityId },
        })))
        break
      }
      case 'DRAWDOWN_CONFIRMED': {
        const [destination] = await within(tx => tx.select().from(schema.payoutDestinationVersions)
          .where(eq(schema.payoutDestinationVersions.id, settlement.destinationVersionId!)).limit(1))
        if (!destination) throw new Error('Frozen destination is missing')
        const rail = await chooseRail(provider, { destinationKind: destination.kind === 'bank_account' ? 'bank_account' : 'vpa', amountMinor: settlement.recipientAmountMinor })
        if (!rail.ok) throw new Error(`Rail selection refused: ${rail.reason}`)
        // Dispatch and enqueue are committed before the counterparty is called.
        accepted(await within(tx => dispatchPayout(tx, scope, { settlementId, actor,
          railSelected: true, rail: rail.rail, slaSeconds: 5, providerId: provider.id,
          fundingAmountMinor: settlement.recipientAmountMinor,
        })))
        // Sandbox status is pulled first on recovery, so a worker restart never
        // relies on whether it happened to receive the submission response.
        const command = {
          settlementId, attemptNumber: 1, idempotencyKey: payoutIdempotencyKey(settlementId, 1),
          rail: rail.rail, amountMinor: settlement.recipientAmountMinor, currency: 'INR' as const,
          destination: {
            destinationVersionId: destination.id, kind: destination.kind === 'bank_account' ? 'bank_account' as const : 'vpa' as const,
            ...(destination.accountNumberCiphertext ? { accountNumber: await within(tx => decryptAccountNumberForVerification(tx, scope, cipher, destination.id)) ?? '' } : {}),
            ...(destination.ifsc ? { ifsc: destination.ifsc } : {}), ...(destination.vpa ? { vpa: destination.vpa } : {}),
            accountHolderName: destination.accountHolderName ?? '',
          },
        }
        try { await provider.submitPayout(command) } catch (error) {
          // A timeout is uncertainty. Always query before deciding the result.
          if (!(error instanceof Error) || error.name !== 'PayoutTimeout') throw error
        }
        break
      }
      case 'PAYOUT_SUBMITTED': {
        const key = payoutIdempotencyKey(settlementId, 1)
        const answer = await provider.getPayout(key)
        if (answer.ok && answer.status === 'not_found') {
          // This simulator stores a submission atomically before returning. A
          // missing record after restart proves its call did not run. Production
          // providers must establish their own authoritative lookup guarantees.
          const [attempt] = await within(tx => tx.select().from(schema.payoutAttempts).where(eq(schema.payoutAttempts.settlementId, settlementId)).limit(1))
          if (!attempt) throw new Error('Payout attempt missing')
          const [dest] = await within(tx => tx.select().from(schema.payoutDestinationVersions).where(eq(schema.payoutDestinationVersions.id, attempt.destinationVersionId)).limit(1))
          if (!dest) throw new Error('Destination missing')
          try { await provider.submitPayout({ settlementId, attemptNumber: attempt.attemptNumber, idempotencyKey: attempt.idempotencyKey,
            rail: attempt.rail!, amountMinor: attempt.amountMinor!, currency: 'INR', destination: {
              destinationVersionId: dest.id, kind: 'bank_account', accountNumber: await within(tx => decryptAccountNumberForVerification(tx, scope, cipher, dest.id)) ?? '',
              ifsc: dest.ifsc ?? '', accountHolderName: dest.accountHolderName ?? '',
            } }) } catch (error) { if (!(error instanceof Error) || error.name !== 'PayoutTimeout') throw error }
        }
        const outcome = await pullPayoutStatus(db, scope, provider, mapping, { settlementId, actor })
        if (!outcome.ok) { await within(tx => sweepPayoutSla(tx, scope, { settlementId, actor })); return }
        break
      }
      case 'PAYOUT_CONFIRMED':
        accepted(await within(tx => beginReconciliation(tx, scope, { settlementId, actor,
          expected: money('INR', settlement.recipientAmountMinor), slaSeconds: 60,
        })))
        break
      case 'RECONCILING': {
        const evidence = await provider.getPayout(payoutIdempotencyKey(settlementId, 1))
        if (!evidence.ok || evidence.status !== 'CREDITED' || evidence.creditedMinor === undefined) return
        accepted(await within(tx => applyObservation(tx, scope, { settlementId, actor,
          source: 'authoritative_status_pull', observedMinor: evidence.creditedMinor!, observedCurrency: 'INR',
        })))
        const current = await within(tx => getSettlement(tx, settlementId))
        if (current?.status !== 'RECONCILING') return
        accepted(await within(tx => evaluateAndSettle(tx, scope, { settlementId, actor,
          issueReceipt: async inner => {
            const receipt = await issueReceipt(inner, scope, { settlementId, actor })
            if (!receipt.ok) throw new Error('Receipt issuance refused')
            return { receiptId: receipt.artifactId, contentHash: receipt.contentHash }
          },
        })))
        break
      }
      case 'EXCEPTION':
        if (settlement.openExceptionCode === 'PAYOUT_STATUS_UNKNOWN') await pullPayoutStatus(db, scope, provider, mapping, { settlementId, actor })
        return
      default: return
    }
  }
  throw new Error('Execution exceeded its transition bound')
}

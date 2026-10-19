/** A crypto refund is not a return of a prior INR bank credit. Provider
 * completion still requires independent net-credit reconciliation. */
export function describeSaberPoolSell(status: unknown): {
  phase: 'in_flight' | 'manual_review' | 'provider_completed' | 'provider_failed' | 'refund' | 'unsupported'
  rawStatus: string | null
  requiresIndependentReconciliation: true
} {
  const rawStatus = typeof status === 'string' ? status : null
  let phase: 'in_flight' | 'manual_review' | 'provider_completed' | 'provider_failed' | 'refund' | 'unsupported' = 'unsupported'
  if (rawStatus === 'CREATED' || rawStatus === 'PROCESSING' || rawStatus === 'VERIFICATION_PENDING') phase = 'in_flight'
  if (rawStatus === 'APPROVAL_REQUIRED') phase = 'manual_review'
  if (rawStatus === 'COMPLETED') phase = 'provider_completed'
  if (rawStatus === 'FAILED' || rawStatus === 'CANCELLED' || rawStatus === 'SOURCE_INVALID') phase = 'provider_failed'
  if (rawStatus === 'REFUND_INITIATED' || rawStatus === 'REFUND_COMPLETED') phase = 'refund'
  return { phase, rawStatus, requiresIndependentReconciliation: true }
}

/**
 * The customer-visible event types — `API_CONTRACT.md § 10.2`, quoted exactly.
 *
 * > Internal events — liquidity, drawdowns, reservations, provider events,
 * > individual payout attempts — are never delivered to customer endpoints. The
 * > internal state machine is not the integration surface.
 *
 * This list is the enforcement of that sentence, and it is an **allow-list**.
 * The domain emits far more event types than these; a delivery path that
 * excluded a deny-list would leak every new internal event the day it was
 * added, silently, to endpoints that were subscribed to "everything".
 *
 * So the rule runs the other way: a type is deliverable only if it appears
 * below, and adding one is a deliberate edit to a file whose whole subject is
 * what customers may see. A test asserts every type here appears in `§ 10.2` and
 * that every type in `§ 10.2` appears here — the document and the allow-list
 * cannot drift apart without failing the build.
 */

export const CUSTOMER_EVENT_TYPES = [
  'beneficiary.created',
  'beneficiary.verified',
  'beneficiary.verification_failed',

  'settlement.created',
  'settlement.ready',
  'settlement.action_required',
  'settlement.settling',
  'settlement.settled',
  'settlement.cancelled',
  'settlement.cancellation_requested',

  'settlement.replacement_created',

  'settlement.return_observed',
  'settlement.return_confirmed',
  'settlement.return_repaid',
  'settlement.return_rejected',

  'quote.expired',

  'batch.validated',
  'batch.completed',
  'batch.partially_completed',

  'receipt.available',
] as const
export type CustomerEventType = (typeof CUSTOMER_EVENT_TYPES)[number]

const DELIVERABLE = new Set<string>(CUSTOMER_EVENT_TYPES)

export function isCustomerEventType(type: string): type is CustomerEventType {
  return DELIVERABLE.has(type)
}

/**
 * The type used by `POST /v1/webhook_endpoints/{id}/test`.
 *
 * Deliberately not in the deliverable list: a test event is not something that
 * happened, and a customer whose integration treats it as one would act on a
 * settlement that does not exist. It is signed identically, so the *verification*
 * path is genuinely exercised, and it names itself in the payload.
 */
export const TEST_EVENT_TYPE = 'endpoint.test'

/**
 * Does this endpoint want this event?
 *
 * An empty subscription means every customer-visible type — `§ 12`'s change
 * policy says clients must "tolerate unknown event types", so a new type
 * reaching an endpoint that asked for everything is expected behaviour, not a
 * surprise. An endpoint that listed types gets exactly those.
 */
export function endpointWantsEvent(
  subscribed: readonly string[],
  type: string,
): boolean {
  if (!isCustomerEventType(type)) return false
  return subscribed.length === 0 || subscribed.includes(type)
}

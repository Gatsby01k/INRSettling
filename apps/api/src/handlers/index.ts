/**
 * The handler table, keyed by the route names in `routes.ts`.
 *
 * A test asserts this table and the route table have exactly the same keys, so
 * a route added without a handler fails the build rather than returning a `500`
 * to the first customer who finds it.
 */
import type { HandlerTable } from '../pipeline.js'
import {
  createBeneficiaryHandler, disableBeneficiaryHandler, getBeneficiaryHandler,
  listBeneficiariesHandler, verifyBeneficiaryHandler,
} from './beneficiaries.js'
import { createQuoteHandler, getQuoteHandler } from './quotes.js'
import {
  authorizeSettlementHandler, cancelSettlementHandler, createSettlementHandler,
  getSettlementHandler, listSettlementsHandler, receiptHandler, settlementReturnsHandler,
} from './settlements.js'
import { compositeReceiptHandler } from './receipts.js'
import { batchSettlementsHandler, createBatchHandler, getBatchHandler } from './batches.js'
import { getEventHandler, listEventsHandler } from './events.js'
import {
  createWebhookEndpointHandler, deleteWebhookEndpointHandler,
  getWebhookEndpointHandler, testWebhookEndpointHandler,
} from './webhook-endpoints.js'

export const HANDLERS: HandlerTable = {
  'beneficiaries.create': createBeneficiaryHandler,
  'beneficiaries.list': listBeneficiariesHandler,
  'beneficiaries.get': getBeneficiaryHandler,
  'beneficiaries.verify': verifyBeneficiaryHandler,
  'beneficiaries.disable': disableBeneficiaryHandler,

  'quotes.create': createQuoteHandler,
  'quotes.get': getQuoteHandler,

  'settlements.create': createSettlementHandler,
  'settlements.list': listSettlementsHandler,
  'settlements.get': getSettlementHandler,
  'settlements.authorize': authorizeSettlementHandler,
  'settlements.cancel': cancelSettlementHandler,
  'settlements.receipt': receiptHandler,
  'settlements.returns': settlementReturnsHandler,
  'settlements.receipt.composite': compositeReceiptHandler,

  'batches.create': createBatchHandler,
  'batches.get': getBatchHandler,
  'batches.settlements': batchSettlementsHandler,

  'events.list': listEventsHandler,
  'events.get': getEventHandler,

  'webhook_endpoints.create': createWebhookEndpointHandler,
  'webhook_endpoints.get': getWebhookEndpointHandler,
  'webhook_endpoints.delete': deleteWebhookEndpointHandler,
  'webhook_endpoints.test': testWebhookEndpointHandler,
}

/**
 * Quote endpoints — `API_CONTRACT.md § 7.2`, `§ 8`.
 *
 * *"Recipient-first by default"* is not a convenience: it is the product's
 * framing (`INV-08`). The customer says what the beneficiary receives, and the
 * funding side is derived — so a request that omits `direction` gets the
 * direction the whole product is built around, not the one that happens to be
 * first in an enum.
 *
 * The pricing configuration is the labelled sandbox fixture. `D-08b` and `D-09b`
 * are external and unanswered; nothing here invents a spread, a fee level or a
 * quote window.
 */
import { ApiError, notFound } from '@inrsettle/domain'
import { money, type CurrencyCode, isCurrencyCode } from '@inrsettle/money'
import { createQuote, getQuote, QuoteError } from '@inrsettle/app-services'
import type { Handler } from '../pipeline.js'
import { quoteJson } from '@inrsettle/app-services'
import { objectField, requireBody, requireString, stringField } from './body.js'

export const createQuoteHandler: Handler = async (ctx) => {
  const body = requireBody(ctx)
  const direction = stringField(body, 'direction') ?? 'recipient_first'
  if (direction !== 'recipient_first' && direction !== 'funding_first') {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: `"${direction}" is not a quote direction.`,
      detail: 'Send "recipient_first" (the default) or "funding_first".',
      param: 'direction',
    })
  }

  const fundingCurrency = stringField(body, 'funding_currency') ?? 'USDT'
  if (!isCurrencyCode(fundingCurrency)) {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: `"${fundingCurrency}" is not a currency this service quotes.`,
      detail: 'V1 funds settlements in USDT.',
      param: 'funding_currency',
    })
  }

  const amountField = direction === 'recipient_first' ? 'recipient_amount' : 'funding_amount'
  const amountBody = objectField(body, amountField)
  const minorUnits = requireString(amountBody, 'minor_units')
  if (!/^\d+$/.test(minorUnits)) {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: `${amountField}.minor_units must be a whole number, as a string.`,
      detail: '₹5,000,000.00 is "500000000". A string, so values above 2^53 survive JavaScript clients.',
      param: `${amountField}.minor_units`,
    })
  }
  const currencyText = stringField(amountBody, 'currency')
    ?? (direction === 'recipient_first' ? 'INR' : fundingCurrency)
  if (!isCurrencyCode(currencyText)) {
    throw new ApiError({
      type: 'invalid_request_error', code: 'invalid_parameter',
      message: `"${currencyText}" is not a currency this service quotes.`,
      detail: 'The recipient side is always INR; the funding side is your funding_currency.',
      param: `${amountField}.currency`,
    })
  }

  const amount = money(currencyText as CurrencyCode, BigInt(minorUnits))

  try {
    const quote = await createQuote(ctx.tx, ctx.scope, {
      direction: direction === 'recipient_first' ? 'RECIPIENT_FIRST' : 'SOURCE_FIRST',
      ...(direction === 'recipient_first'
        ? { recipientAmount: amount }
        : { fundingAmount: amount }),
      fundingCurrency: fundingCurrency as CurrencyCode,
      actor: ctx.key.principal,
    })
    return { status: 201, body: quoteJson(quote, ctx.numberFormat), subjectId: quote.id }
  } catch (e) {
    if (e instanceof QuoteError) {
      throw new ApiError({
        type: 'invalid_request_error', code: 'invalid_parameter',
        message: 'That quote could not be priced.',
        detail: e.message,
      })
    }
    throw e
  }
}

export const getQuoteHandler: Handler = async (ctx) => {
  const quote = await getQuote(ctx.tx, ctx.params['id']!)
  if (!quote) throw notFound('quote')
  return { status: 200, body: quoteJson(quote, ctx.numberFormat) }
}

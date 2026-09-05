/**
 * Reading a request body, with the error copy rule applied.
 *
 * `API_CONTRACT.md § 5` rule 4: *"The error copy rule from `PRODUCT.md § 7.1`
 * applies to the API. An API error is as specific and as actionable as the
 * screen."* So none of these helpers can produce "invalid request": every one
 * names the field, says what was wrong with it, and says what to send instead.
 *
 * The body arriving here has already been through `parseStrictJson`, so a
 * duplicate key was refused upstream and cannot have collapsed two different
 * requests into one fingerprint.
 */
import { ApiError, type JsonValue } from '@inrsettle/domain'
import type { HandlerContext } from '../pipeline.js'

export type JsonObject = { [key: string]: JsonValue }

export function requireBody(ctx: HandlerContext): JsonObject {
  if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) {
    throw new ApiError({
      type: 'invalid_request_error',
      code: 'invalid_body',
      message: 'This endpoint needs a JSON object as its body.',
      detail: 'Send Content-Type: application/json and a top-level { … } object.',
    })
  }
  return ctx.body as JsonObject
}

export function requireString(body: JsonObject, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError({
      type: 'invalid_request_error',
      code: value === undefined ? 'missing_parameter' : 'invalid_parameter',
      message: value === undefined
        ? `${field} is required.`
        : `${field} must be a non-empty string.`,
      detail: `Send "${field}" as a string in the request body.`,
      param: field,
    })
  }
  return value
}

/** An absent optional field is `undefined`, never `null` — see the fingerprint. */
export function stringField(body: JsonObject, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ApiError({
      type: 'invalid_request_error',
      code: 'invalid_parameter',
      message: `${field} must be a string.`,
      detail: `Remove "${field}" if you do not need it, or send it as a string.`,
      param: field,
    })
  }
  return value
}

export function objectField(body: JsonObject, field: string): JsonObject {
  const value = body[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError({
      type: 'invalid_request_error',
      code: value === undefined ? 'missing_parameter' : 'invalid_parameter',
      message: value === undefined ? `${field} is required.` : `${field} must be an object.`,
      detail: `Send "${field}" as a JSON object.`,
      param: field,
    })
  }
  return value as JsonObject
}

export function stringArrayField(body: JsonObject, field: string): readonly string[] | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ApiError({
      type: 'invalid_request_error',
      code: 'invalid_parameter',
      message: `${field} must be an array of strings.`,
      detail: `Send "${field}" as ["one", "two"], or omit it.`,
      param: field,
    })
  }
  return value as string[]
}

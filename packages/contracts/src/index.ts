/** Zod schemas shared by apps, the API and the SDK. Stage 1 surface only. */
import { z } from 'zod'
import { CURRENCIES } from '@inrsettle/money'

export const environmentSchema = z.enum(['sandbox', 'live'])
export type Environment = z.infer<typeof environmentSchema>

export const workspaceRoleSchema = z.enum(['viewer', 'operator', 'approver', 'admin', 'developer'])
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>

/**
 * INRSettle staff roles — `SECURITY.md § 3.2`.
 *
 * > Internal (INRSettle staff) roles are entirely separate and never granted
 * > inside a customer workspace.
 *
 * A separate enum rather than more values on `workspaceRoleSchema`, because the
 * sentence above is the requirement and one shared enum is how it stops being
 * true: a membership row could then name `ops_admin`, and the check that was
 * supposed to be impossible would be a runtime string comparison somebody has
 * to remember to write.
 */
export const internalRoleSchema = z.enum(['ops_read', 'ops_resolve', 'ops_liquidity', 'ops_admin'])
export type InternalRole = z.infer<typeof internalRoleSchema>

/**
 * `operator` is INRSettle staff acting in Internal Operations. It is its own
 * principal type and not a `user`, so an audit record answers "was this the
 * customer or was this us" by its type rather than by whoever reads it
 * recognising the id.
 */
export const principalTypeSchema = z.enum(['user', 'api_key', 'job', 'provider', 'operator'])
export type PrincipalType = z.infer<typeof principalTypeSchema>

export const principalRefSchema = z.object({
  type: principalTypeSchema,
  id: z.string().min(1),
})
export type PrincipalRef = z.infer<typeof principalRefSchema>

/** INV-04: minor_units crosses the wire as a string. */
export const moneyJsonSchema = z.object({
  currency: z.enum(Object.keys(CURRENCIES) as [string, ...string[]]),
  minor_units: z.string().regex(/^-?\d+$/, 'minor_units must be an integer string'),
  scale: z.number().int().nonnegative(),
  display: z.string(),
})

/** API_CONTRACT.md § 5 — one envelope, everywhere. */
export const errorTypeSchema = z.enum([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'conflict_error',
  'rate_limit_error',
  'provider_error',
  'api_error',
])

export const errorEnvelopeSchema = z.object({
  error: z.object({
    type: errorTypeSchema,
    code: z.string(),
    message: z.string(),
    detail: z.string().optional(),
    param: z.string().optional(),
    doc_url: z.string().url().optional(),
    request_id: z.string(),
  }),
})
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>

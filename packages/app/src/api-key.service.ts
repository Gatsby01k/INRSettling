/**
 * API keys — SECURITY.md § 3.3.
 *
 * The plaintext is generated with a CSPRNG, returned exactly once, and never
 * stored: only its SHA-256 reaches the database. Verification hashes the
 * presented key and looks that up, so a database disclosure yields no usable
 * credential.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  evaluateApiKey, prefixFor, scopesWithin,
  type Capability, type KeyDecision, type PrincipalRef, type TenantScope,
} from '@inrsettle/domain'
import { eventSink } from './events.js'

export class ApiKeyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ApiKeyError'
  }
}

export function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

export interface CreatedApiKey {
  id: string
  /** Shown once. Never retrievable again. */
  plaintext: string
  prefix: string
  scopes: readonly string[]
}

export async function createApiKey(
  tx: Db,
  scope: TenantScope,
  args: {
    name: string
    scopes: readonly Capability[]
    actor: PrincipalRef
    actorCapabilities: ReadonlySet<Capability>
  },
): Promise<CreatedApiKey> {
  if (!args.actorCapabilities.has('apikey:manage')) {
    throw new ApiKeyError('actor lacks apikey:manage', 'permission_denied')
  }
  // A key can never hold a capability its grantor lacks.
  const within = scopesWithin(args.scopes, args.actorCapabilities)
  if (!within.ok) {
    throw new ApiKeyError(
      `cannot grant scopes the grantor does not hold: ${within.disallowed.join(', ')}`,
      'scope_exceeds_grantor',
    )
  }

  const prefix = prefixFor(scope.environment)
  const plaintext = `${prefix}${randomBytes(24).toString('base64url')}`
  const id = newId('apiKey')

  await tx.insert(schema.apiKeys).values({
    id,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    name: args.name,
    prefix,
    secretSha256: hashSecret(plaintext),
    scopes: [...args.scopes],
    createdBy: args.actor.id,
  })

  await eventSink(tx).audit(scope, {
    actor: args.actor,
    action: 'api_key.created',
    subjectType: 'api_key',
    subjectId: id,
    after: { name: args.name, scopes: [...args.scopes] },
  })

  return { id, plaintext, prefix, scopes: args.scopes }
}

export interface VerifiedKey {
  keyId: string
  principal: PrincipalRef
  scopes: readonly string[]
}

/**
 * Verify a presented key. A key from the other environment is `unknown_key`,
 * not `wrong_environment`, to the caller: it must not confirm an object exists.
 */
export async function verifyApiKey(
  tx: Db, scope: TenantScope, plaintext: string, required?: Capability,
): Promise<VerifiedKey> {
  const hash = hashSecret(plaintext)
  const [row] = await tx
    .select()
    .from(schema.apiKeys)
    .where(and(
      eq(schema.apiKeys.secretSha256, hash),
      eq(schema.apiKeys.workspaceId, scope.workspaceId),
    ))
    .limit(1)

  const decision: KeyDecision = evaluateApiKey(
    plaintext,
    row
      ? {
          found: true,
          revoked: row.revokedAt !== null,
          environment: row.environment,
          scopes: row.scopes,
        }
      : null,
    required ? { environment: scope.environment, capability: required } : { environment: scope.environment },
  )

  if (!decision.allowed) {
    throw new ApiKeyError(
      decision.code === 'missing_scope'
        ? 'This key does not hold the required scope.'
        : 'No such API key.',
      decision.code === 'missing_scope' ? 'missing_scope' : 'unknown_key',
    )
  }

  // Constant-time confirmation of the hash we matched on.
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(row!.secretSha256, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiKeyError('No such API key.', 'unknown_key')
  }

  await tx.update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, row!.id))

  return {
    keyId: row!.id,
    principal: { type: 'api_key', id: row!.id },
    scopes: row!.scopes,
  }
}

export async function revokeApiKey(
  tx: Db,
  scope: TenantScope,
  args: { keyId: string; actor: PrincipalRef; actorCapabilities: ReadonlySet<Capability>; reason?: string },
): Promise<void> {
  if (!args.actorCapabilities.has('apikey:manage')) {
    throw new ApiKeyError('actor lacks apikey:manage', 'permission_denied')
  }
  await tx.update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(schema.apiKeys.id, args.keyId),
      eq(schema.apiKeys.workspaceId, scope.workspaceId),
      eq(schema.apiKeys.environment, scope.environment),
    ))

  await eventSink(tx).audit(scope, {
    actor: args.actor,
    action: 'api_key.revoked',
    subjectType: 'api_key',
    subjectId: args.keyId,
    ...(args.reason ? { reason: args.reason } : {}),
  })
}

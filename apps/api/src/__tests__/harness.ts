/**
 * The contract-test harness.
 *
 * A request is a plain object and `handle` is a plain function, so a contract
 * test is a function call against a real database rather than a web server. That
 * matters: the Stage 8 exit criterion is *"contract tests cover every endpoint,
 * every error type, and the idempotency semantics"*, which is a lot of tests,
 * and tests that cost a server boot each get run less often than tests that do
 * not.
 *
 * Everything below the pipeline is real — real Postgres, real RLS, real
 * migrations, real key hashing. The only injected fakes are the ones the API is
 * forbidden from holding anyway (`SECURITY.md § 8`).
 */
import { randomBytes } from 'node:crypto'
import type { SQL } from 'drizzle-orm'
import type postgres from 'postgres'
import { schema, withTenant, type Db } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  createFieldCipher, createDestinationFingerprinter, hashSecret,
  loadRuleSetFromDatabase, activeRuleSetVersion,
  unlimitedRateLimiter, type RateLimiter,
} from '@inrsettle/app-services'
import type { PreflightRuleSet, TenantScope } from '@inrsettle/domain'
import { handle, type PipelineOptions } from '../pipeline.js'
import { HANDLERS } from '../handlers/index.js'
import type { ApiDeps } from '../deps.js'
import type { ApiRequest, ApiResponse } from '../http.js'

export interface ApiHarness {
  readonly db: Db
  readonly deps: ApiDeps
  readonly scope: TenantScope
  readonly rateLimiter: RateLimiter
}

export interface CreatedKey {
  readonly id: string
  readonly plaintext: string
}

/**
 * Mint a key straight into the table.
 *
 * Provisioning through the admin handle rather than through `createApiKey`,
 * because a contract test's subject is what the API does with a key, not how
 * the key got made — and going through the admin handle keeps the fixture
 * honest about which side of RLS it is on.
 */
export async function seedApiKey(
  admin: postgres.Sql,
  args: {
    workspaceId: string
    environment: 'sandbox' | 'live'
    scopes: readonly string[]
    revoked?: boolean
  },
): Promise<CreatedKey> {
  const prefix = args.environment === 'live' ? 'sk_live_' : 'sk_test_'
  const plaintext = `${prefix}${randomBytes(24).toString('base64url')}`
  const id = newId('apiKey')
  await admin`
    INSERT INTO api_keys (id, workspace_id, environment, name, prefix, secret_sha256, scopes, created_by, revoked_at)
    VALUES (${id}, ${args.workspaceId}, ${args.environment}::environment, 'test key',
            ${prefix}, ${hashSecret(plaintext)}, ${admin.array([...args.scopes])}, 'usr_seed',
            ${args.revoked === true ? admin`now()` : null})`
  return { id, plaintext }
}

export async function loadSandboxRuleSet(admin: postgres.Sql): Promise<PreflightRuleSet> {
  const version = await activeRuleSetVersion(admin, 'sandbox', new Date())
  const loaded = await loadRuleSetFromDatabase(admin, version!)
  return loaded!.ruleSet
}

export function testDeps(ruleSet: PreflightRuleSet): ApiDeps {
  // A cipher for webhook secrets, and an *encryptor* for destinations. The
  // asymmetry is SECURITY.md § 8 and is asserted by a test of its own.
  const cipher = createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } })
  return {
    ruleSet,
    destinationEncryptor: cipher,
    destinationFingerprinter: createDestinationFingerprinter(randomBytes(32)),
    webhookCipher: createFieldCipher({ activeKeyId: 'w1', keks: { w1: randomBytes(32) } }),
    verificationProviderId: 'mock_verification',
    verificationMethod: 'penny_drop',
    hasActiveLiquidityFacility: true,
    // A 500 in a contract test is a bug in the API, not an expected outcome;
    // printing it is the difference between "expected 500 to be 201" and a
    // stack trace naming the line.
    onUnexpectedError: (error, requestId) => {
      console.error(`[api 500] ${requestId}`, error)
    },
  }
}

export interface CallOptions {
  readonly key?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly rawBody?: string
  readonly rateLimiter?: RateLimiter
  readonly now?: () => Date
}

export function makeCaller(db: Db, deps: ApiDeps) {
  return async function call(
    method: string, path: string, options: CallOptions = {},
  ): Promise<ApiResponse & { json: unknown }> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    if (options.key !== undefined) headers['authorization'] = `Bearer ${options.key}`
    const rawBody = options.rawBody
      ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

    const request: ApiRequest = {
      method, path, headers,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(rawBody === undefined ? {} : { rawBody }),
    }
    const pipeline: PipelineOptions = {
      db, deps, handlers: HANDLERS,
      rateLimiter: options.rateLimiter ?? unlimitedRateLimiter(),
      ...(options.now === undefined ? {} : { now: options.now }),
    }
    const response = await handle(request, pipeline)
    return {
      ...response,
      json: response.body === '' ? null : JSON.parse(response.body),
    }
  }
}

/** A beneficiary with a verified destination, so settlements can be created. */
export async function seedVerifiedBeneficiary(
  db: Db, scope: TenantScope, admin: postgres.Sql,
): Promise<{ beneficiaryId: string; destinationId: string; versionId: string }> {
  const beneficiaryId = newId('beneficiary')
  const destinationId = newId('payoutDestination')
  const versionId = newId('destinationVersion')

  await withTenant(db, scope, async (tx) => {
    await tx.insert(schema.beneficiaries).values({
      id: beneficiaryId,
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      displayName: 'Priya Technologies Pvt Ltd',
      legalName: 'Priya Technologies Private Limited',
      type: 'business',
      country: 'IN',
      status: 'verified',
      createdBy: 'usr_seed',
    })
    await tx.insert(schema.payoutDestinations).values({
      id: destinationId,
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      beneficiaryId,
      kind: 'bank_account',
      createdBy: 'usr_seed',
    })
    await tx.insert(schema.payoutDestinationVersions).values({
      id: versionId,
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      destinationId,
      versionNumber: 1,
      kind: 'bank_account',
      accountNumberCiphertext: 'v1.k1.x.x.x.x',
      accountNumberLast4: '4417',
      ifsc: 'HDFC0001234',
      accountType: 'current',
      accountHolderName: 'Priya Technologies Private Limited',
      detailsFingerprint: `fp_${versionId}`,
      createdBy: 'usr_seed',
    })
    // Verification attaches to the *version*, never to the destination
    // (INV-45), so a verified beneficiary means a resolved verification row.
    await tx.insert(schema.destinationVerifications).values({
      id: newId('destinationVerification'),
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      destinationVersionId: versionId,
      status: 'verified',
      method: 'penny_drop',
      providerId: 'mock_verification',
      providerReference: `pv_${versionId}`,
      nameMatchOutcome: 'satisfied',
      resolvedAt: new Date(),
      requestedBy: 'usr_seed',
    })
  })

  await admin`
    UPDATE payout_destinations SET current_version_id = ${versionId} WHERE id = ${destinationId}`
  await admin`
    UPDATE beneficiaries SET default_destination_id = ${destinationId} WHERE id = ${beneficiaryId}`

  return { beneficiaryId, destinationId, versionId }
}

/**
 * A tenant-scoped read, typed.
 *
 * A helper rather than an inline cast because `(await …) as unknown as T[]`
 * spanning a line break is not parseable by the test transform — and because a
 * test asserting isolation should visibly go through `withTenant` rather than
 * around it.
 */
export async function queryRows<T>(db: Db, scope: TenantScope, statement: SQL): Promise<T[]> {
  const result = await withTenant(db, scope, (tx) => tx.execute(statement))
  return result as unknown as T[]
}

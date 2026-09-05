/**
 * Beneficiary verification — `INV-45`, `INV-33`, `INV-43`.
 *
 * Three things this file is responsible for getting right, and they are the
 * three things that would be quietly wrong in a naive implementation:
 *
 *   **A result may only be applied to the version it was asked about.** The
 *   provider is not trusted to get this right and is not asked to: the
 *   verification row records the version, and a callback naming any other
 *   version is refused and recorded as refused.
 *
 *   **A redelivered callback changes nothing.** Providers retry. The raw event
 *   is stored under a unique `(provider_id, provider_event_id)`, and a second
 *   delivery is a no-op rather than a second state change.
 *
 *   **A refusal that records something cannot throw.** Rejecting a callback
 *   writes an audit row; throwing would roll that row back and destroy the
 *   evidence of the refusal. So these return a result and the caller decides.
 *   (Stage 1 learned this the hard way in `session.service.ts`.)
 */
import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema, withTenant } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import { enqueue } from '@inrsettle/jobs'
import {
  decideNameMatch,
  policyFor,
  type BeneficiaryVerificationProvider,
  type NameMatchDecision,
  type NameMatchPolicySet,
  type PrincipalRef,
  type TenantScope,
  type VerificationCallback,
  type VerificationMethod,
  type VerificationOutcome,
} from '@inrsettle/domain'
import { eventSink } from './events.js'
import {
  BeneficiaryError,
  decryptAccountNumberForVerification,
  refreshBeneficiaryStatus,
} from './beneficiary.service.js'
import type { FieldCipher } from './crypto/field-encryption.js'

export interface RequestVerificationInput {
  destinationVersionId: string
  actor: PrincipalRef
}

export type RequestVerificationRefusal =
  'version_not_found' | 'already_verified' | 'already_in_flight' | 'unsupported_kind'

export type RequestVerificationResult =
  | { ok: true; verificationId: string; status: 'verifying' | 'verified' | 'failed'; reasonCode?: string }
  | { ok: false; reason: RequestVerificationRefusal }

/**
 * Start (or short-circuit) a verification for one destination version.
 *
 * The provider is handed the plaintext details and never sees an id it could
 * use to reach anything else; what comes back is applied to this version only.
 */
/**
 * Phase 1 — record the request. **No provider call.**
 *
 * `ARCHITECTURE.md § 5`: *"Adapters are called from jobs, never from inside a
 * database transaction […]. No adapter method may be invoked while a row lock is
 * held."* The first cut of this service called `provider.verify(…)` between an
 * `INSERT` and an `UPDATE` in one transaction, so a penny drop that took four
 * seconds held a transaction open for four seconds and a provider that hung held
 * it until the statement timeout. A sandbox provider that answers instantly is
 * why nothing showed it.
 *
 * The row is still written *before* the call, which is the property that was
 * worth protecting: a timeout leaves a verification our database knows about
 * rather than a penny drop nobody recorded.
 *
 * Takes the caller's transaction, so a verification cannot exist without the
 * beneficiary creation that asked for it — and a rolled-back creation leaves
 * neither it nor its job.
 */
export async function openVerification(
  tx: Db,
  scope: TenantScope,
  input: RequestVerificationInput & { method: VerificationMethod; providerId: string },
): Promise<{ ok: true; verificationId: string } | { ok: false; reason: RequestVerificationRefusal }> {
  const [version] = await tx
    .select()
    .from(schema.payoutDestinationVersions)
    .where(eq(schema.payoutDestinationVersions.id, input.destinationVersionId))
    .limit(1)
  if (!version) return { ok: false, reason: 'version_not_found' }

  const existing = await tx
    .select()
    .from(schema.destinationVerifications)
    .where(eq(schema.destinationVerifications.destinationVersionId, version.id))
    .orderBy(desc(schema.destinationVerifications.requestedAt))

  if (existing.some((v) => v.status === 'verified')) return { ok: false, reason: 'already_verified' }
  if (existing.some((v) => v.status === 'verifying')) return { ok: false, reason: 'already_in_flight' }

  const verificationId = newId('destinationVerification')
  await tx.insert(schema.destinationVerifications).values({
    id: verificationId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    destinationVersionId: version.id,
    status: 'verifying',
    method: input.method,
    providerId: input.providerId,
    requestedBy: input.actor.id,
  })

  await eventSink(tx).audit(scope, {
    actor: input.actor,
    action: 'beneficiary.verification_requested',
    subjectType: 'destination_version',
    subjectId: version.id,
    after: { verificationId, providerId: input.providerId, method: input.method },
  })

  return { ok: true, verificationId }
}

export const BENEFICIARY_VERIFY_JOB = 'beneficiary.verify'

/**
 * Schedule the provider call. Separate from `openVerification` on purpose.
 *
 * Recording the request and scheduling the work are two different acts, and only
 * one of them needs a queue. The API records *and* schedules, in the same
 * transaction, so a verification cannot exist without the job that will run it.
 * A caller that intends to run the job itself — the composed
 * `requestVerification` below, and every test that wants a synchronous answer —
 * records without scheduling, and does not need a queue installed to do it.
 */
export async function enqueueBeneficiaryVerify(
  tx: Db, scope: TenantScope, input: { verificationId: string },
): Promise<void> {
  await enqueue(
    tx, BENEFICIARY_VERIFY_JOB,
    {
      verificationId: input.verificationId,
      workspaceId: scope.workspaceId,
      environment: scope.environment,
    },
    { jobKey: `${BENEFICIARY_VERIFY_JOB}:${input.verificationId}` },
  )
}

export interface VerificationJobDeps {
  readonly provider: BeneficiaryVerificationProvider
  readonly cipher: FieldCipher
  readonly policies: NameMatchPolicySet
}

/**
 * Phase 2 — the job. `ARCHITECTURE.md § 7`'s `beneficiary.verify`.
 *
 * Three pieces, and the middle one holds nothing: a short transaction to read
 * what the provider needs, the **unbounded call outside every transaction**, and
 * a short transaction to record the answer.
 *
 * Takes the connection **pool**, not a transaction — the same type-level refusal
 * `submitDispatchedPayout` uses, and for the same reason: a caller must not be
 * able to wrap a provider call in their own transaction.
 *
 * Idempotent: a verification that has already resolved is left exactly as it is,
 * so a redelivered job is a read.
 */
export async function runBeneficiaryVerifyJob(
  db: Db,
  scope: TenantScope,
  deps: VerificationJobDeps,
  input: { verificationId: string; actor?: PrincipalRef },
): Promise<
  | { ok: true; status: 'verifying' | 'verified' | 'failed'; reasonCode?: string }
  | { ok: false; reason: 'unknown_verification' | 'already_resolved' | 'unsupported_kind' }
> {
  const loaded = await withTenant(db, scope, async (tx) => {
    const [verification] = await tx
      .select()
      .from(schema.destinationVerifications)
      .where(eq(schema.destinationVerifications.id, input.verificationId))
      .limit(1)
    if (!verification) return { missing: 'unknown_verification' } as const
    if (verification.status !== 'verifying') return { missing: 'already_resolved' } as const

    const [version] = await tx
      .select()
      .from(schema.payoutDestinationVersions)
      .where(eq(schema.payoutDestinationVersions.id, verification.destinationVersionId))
      .limit(1)
    if (!version) return { missing: 'unknown_verification' } as const
    if (!deps.provider.supports(version.kind)) return { missing: 'unsupported_kind' } as const

    const [destination] = await tx
      .select()
      .from(schema.payoutDestinations)
      .where(eq(schema.payoutDestinations.id, version.destinationId))
      .limit(1)
    if (!destination) return { missing: 'unknown_verification' } as const

    const [beneficiary] = await tx
      .select()
      .from(schema.beneficiaries)
      .where(eq(schema.beneficiaries.id, destination.beneficiaryId))
      .limit(1)
    if (!beneficiary) return { missing: 'unknown_verification' } as const

    // Decryption happens here, in `worker`, which is the only process that holds
    // the capability (`SECURITY.md § 8`). The plaintext never leaves this
    // function's caller and is never persisted.
    const accountNumber = await decryptAccountNumberForVerification(tx, scope, deps.cipher, version.id)

    return {
      verification, version, destination, beneficiary,
      accountNumber,
      expectedName: version.accountHolderName ?? beneficiary.legalName ?? beneficiary.displayName,
      requestedBy: verification.requestedBy,
    }
  })

  if ('missing' in loaded) return { ok: false, reason: loaded.missing }

  const actor: PrincipalRef = input.actor ?? { type: 'job', id: BENEFICIARY_VERIFY_JOB }

  // Outside every transaction. This is the unbounded part.
  const outcome = await deps.provider.verify({
    requestId: loaded.verification.id,
    destinationVersionId: loaded.version.id,
    kind: loaded.version.kind,
    ...(loaded.accountNumber ? { accountNumber: loaded.accountNumber } : {}),
    ...(loaded.version.ifsc ? { ifsc: loaded.version.ifsc } : {}),
    ...(loaded.version.vpa ? { vpa: loaded.version.vpa } : {}),
    beneficiaryName: loaded.expectedName,
  })

  return withTenant(db, scope, async (tx) => {
    if (outcome.status === 'verifying') {
      // The provider has taken it and will call back. The reference is what
      // makes that callback resolvable to this row.
      await tx
        .update(schema.destinationVerifications)
        .set({ providerReference: outcome.providerReference })
        .where(eq(schema.destinationVerifications.id, loaded.verification.id))
      await eventSink(tx).event(scope, {
        type: 'beneficiary.verification_started',
        subjectType: 'payout_destination',
        subjectId: loaded.version.destinationId,
        actor,
        payload: { destination_version_id: loaded.version.id, verification_id: loaded.verification.id },
        deliver: true,
      })
      return { ok: true, status: 'verifying' as const }
    }

    const applied = await applyOutcome(tx, scope, {
      verificationId: loaded.verification.id,
      destinationVersionId: loaded.version.id,
      destinationId: loaded.version.destinationId,
      beneficiaryId: loaded.destination.beneficiaryId,
      outcome,
      actor,
      provider: deps.provider,
      policies: deps.policies,
      expectedName: loaded.expectedName,
    })
    return {
      ok: true,
      status: applied.status,
      ...(applied.reasonCode ? { reasonCode: applied.reasonCode } : {}),
    }
  })
}

/**
 * Open and run, in that order, in separate transactions.
 *
 * The composed convenience. Takes the **pool**, because the two halves are two
 * transactions with a provider call between them — there is no transaction a
 * caller could pass that would make that safe.
 */
export async function requestVerification(
  db: Db,
  scope: TenantScope,
  provider: BeneficiaryVerificationProvider,
  cipher: FieldCipher,
  policies: NameMatchPolicySet,
  input: RequestVerificationInput,
): Promise<RequestVerificationResult> {
  const opened = await withTenant(db, scope, (tx) =>
    openVerification(tx, scope, {
      ...input, method: provider.method, providerId: provider.id,
    }))
  if (!opened.ok) return opened

  const run = await runBeneficiaryVerifyJob(db, scope, { provider, cipher, policies }, {
    verificationId: opened.verificationId,
    actor: input.actor,
  })
  if (!run.ok) {
    return run.reason === 'unsupported_kind'
      ? { ok: false, reason: 'unsupported_kind' }
      : { ok: false, reason: 'version_not_found' }
  }
  return {
    ok: true,
    verificationId: opened.verificationId,
    status: run.status,
    ...(run.reasonCode ? { reasonCode: run.reasonCode } : {}),
  }
}

/* ── Applying an outcome ───────────────────────────────────────────────── */

async function applyOutcome(
  tx: Db,
  scope: TenantScope,
  args: {
    verificationId: string
    destinationVersionId: string
    destinationId: string
    beneficiaryId: string
    outcome: Extract<VerificationOutcome, { status: 'account_confirmed' | 'failed' }>
    actor: PrincipalRef
    provider: BeneficiaryVerificationProvider
    policies: NameMatchPolicySet
    expectedName: string
    providerEventId?: string | undefined
  },
): Promise<{ status: 'verified' | 'failed'; reasonCode?: string; nameMatch: NameMatchDecision }> {
  const { outcome } = args

  /**
   * The provider confirms the *account*; the policy decides the *name*.
   *
   * This split is the whole point of removing the old global threshold. A
   * provider reporting `account_confirmed` has said the account exists and is
   * payable — it has not said the name is good enough, because "good enough"
   * depends on which method ran and what that method actually returns. The
   * versioned policy for `(providerId, method)` makes that call, and it fails
   * closed: evidence it cannot use is `insufficient_evidence`, never a pass.
   */
  const policy = policyFor(args.policies, args.provider.id, args.provider.method)
  const nameMatch = decideNameMatch(
    policy,
    outcome.status === 'failed' ? outcome.nameEvidence : outcome.nameEvidence,
    args.expectedName,
  )

  const status: 'verified' | 'failed' =
    outcome.status === 'account_confirmed' && nameMatch.outcome === 'satisfied' ? 'verified' : 'failed'

  const reasonCode =
    outcome.status === 'failed'
      ? outcome.reasonCode
      : nameMatch.outcome === 'mismatch'
        ? 'name_mismatch'
        : nameMatch.outcome === 'insufficient_evidence'
          ? 'unavailable'
          : undefined

  await tx
    .update(schema.destinationVerifications)
    .set({
      status,
      nameMatchOutcome: nameMatch.outcome,
      nameMatchBasis: nameMatch.basis,
      nameMatchScore: nameMatch.score,
      nameMatchPolicyVersion: args.policies.version,
      reasonCode: reasonCode ?? null,
      resolvedAt: new Date(),
      ...(args.providerEventId ? { providerEventId: args.providerEventId } : {}),
    })
    .where(eq(schema.destinationVerifications.id, args.verificationId))

  const events = eventSink(tx)
  await events.audit(scope, {
    actor: args.actor,
    action: status === 'verified' ? 'beneficiary.verified' : 'beneficiary.verification_failed',
    subjectType: 'destination_version',
    subjectId: args.destinationVersionId,
    after: {
      verificationId: args.verificationId,
      status,
      // How the name decision was reached, so it can be explained later without
      // re-running it. The registry name itself is a third party's record of a
      // person and is not needed to explain the decision, so it stays out.
      nameMatchOutcome: nameMatch.outcome,
      nameMatchBasis: nameMatch.basis,
      nameMatchScore: nameMatch.score,
      nameMatchPolicyVersion: args.policies.version,
      reasonCode: reasonCode ?? null,
    },
  })
  await events.event(scope, {
    type: status === 'verified' ? 'beneficiary.verified' : 'beneficiary.verification_failed',
    subjectType: 'payout_destination',
    subjectId: args.destinationId,
    actor: args.actor,
    payload: {
      beneficiary_id: args.beneficiaryId,
      destination_version_id: args.destinationVersionId,
      verification_id: args.verificationId,
      status,
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    },
    deliver: true,
  })

  await refreshBeneficiaryStatus(tx, scope, args.beneficiaryId)
  return reasonCode ? { status, reasonCode, nameMatch } : { status, nameMatch }
}

/* ── Provider callbacks ────────────────────────────────────────────────── */

export type CallbackResult =
  | { applied: true; verificationId: string; status: 'verified' | 'failed' }
  | { applied: false; reason: 'duplicate_event' }
  | { applied: false; reason: 'unknown_verification' }
  | { applied: false; reason: 'version_mismatch'; expected: string; received: string }
  | { applied: false; reason: 'not_in_flight'; status: string }
  | { applied: false; reason: 'uninterpretable' }
  | { applied: false; reason: 'untrusted_evidence' }

/**
 * Ingest a raw provider payload.
 *
 * Order matters and is not negotiable: the raw event is persisted **first**
 * (`INV-33`), then interpreted (`INV-43` — interpretation may fail, ingestion
 * may not), then applied only if it names the version it claims to.
 *
 * Every refusal returns rather than throws, so the record of the refusal
 * survives the transaction.
 *
 * **Untrusted evidence is stored and never applied.** `signatureValid` is what
 * the transport concluded about the payload's authenticity. A payload that did
 * not authenticate is still persisted and audited — `INV-33` is about keeping
 * evidence, and an unsigned callback is itself evidence worth keeping — but it
 * can never move a destination version to VERIFIED. Anything else would make
 * "verified" mean "somebody posted to our webhook".
 */
export async function ingestVerificationCallback(
  tx: Db,
  scope: TenantScope,
  provider: BeneficiaryVerificationProvider,
  policies: NameMatchPolicySet,
  args: {
    providerEventId: string
    payload: unknown
    signatureValid: boolean
    actor: PrincipalRef
  },
): Promise<CallbackResult> {
  const events = eventSink(tx)

  // 1. Persist verbatim. This happens whether or not we can read it.
  const eventRowId = newId('providerEvent')
  const inserted = await tx
    .insert(schema.providerEvents)
    .values({
      id: eventRowId,
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      providerId: provider.id,
      providerEventId: args.providerEventId,
      eventType: 'beneficiary.verification_result',
      payload: args.payload as Record<string, unknown>,
      signatureValid: args.signatureValid,
    })
    .onConflictDoNothing({
      target: [schema.providerEvents.providerId, schema.providerEvents.providerEventId],
    })
    .returning({ id: schema.providerEvents.id })

  if (inserted.length === 0) {
    // Already seen. A retry must not re-apply an outcome.
    return { applied: false, reason: 'duplicate_event' }
  }

  // 1a. Trust gate. The payload is now stored (INV-33) and stays stored; what
  //     it may no longer do is change state. This check sits before
  //     interpretation on purpose — an unauthenticated payload should not even
  //     get to influence which verification row we look at.
  if (!args.signatureValid) {
    await markInterpreted(tx, eventRowId, 'untrusted_signature')
    await events.audit(scope, {
      actor: args.actor,
      action: 'beneficiary.verification_callback_rejected',
      subjectType: 'provider_event',
      subjectId: eventRowId,
      after: {
        reason: 'untrusted_signature',
        providerId: provider.id,
        providerEventId: args.providerEventId,
      },
    })
    return { applied: false, reason: 'untrusted_evidence' }
  }

  // 2. Interpret. Never throws; an unreadable payload stays stored and inert.
  const callback: VerificationCallback | null = provider.interpret?.(args.payload) ?? null
  if (!callback) {
    await markInterpreted(tx, eventRowId, 'uninterpretable')
    return { applied: false, reason: 'uninterpretable' }
  }

  const [verification] = await tx
    .select()
    .from(schema.destinationVerifications)
    .where(eq(schema.destinationVerifications.id, callback.requestId))
    .limit(1)

  if (!verification) {
    await markInterpreted(tx, eventRowId, 'unknown_verification')
    return { applied: false, reason: 'unknown_verification' }
  }

  // 3. The check that makes INV-45 real. A provider result may only ever be
  //    applied to the exact version that was submitted for checking — not to
  //    the destination's current version, and not to whatever the callback
  //    says. If they disagree, the callback is wrong, and we record that.
  if (verification.destinationVersionId !== callback.destinationVersionId) {
    await markInterpreted(tx, eventRowId, 'version_mismatch')
    await events.audit(scope, {
      actor: args.actor,
      action: 'beneficiary.verification_callback_rejected',
      subjectType: 'destination_version',
      subjectId: verification.destinationVersionId,
      after: {
        reason: 'version_mismatch',
        expected: verification.destinationVersionId,
        received: callback.destinationVersionId,
        providerEventId: args.providerEventId,
      },
    })
    return {
      applied: false,
      reason: 'version_mismatch',
      expected: verification.destinationVersionId,
      received: callback.destinationVersionId,
    }
  }

  if (verification.status !== 'verifying') {
    await markInterpreted(tx, eventRowId, 'not_in_flight')
    await events.audit(scope, {
      actor: args.actor,
      action: 'beneficiary.verification_callback_rejected',
      subjectType: 'destination_version',
      subjectId: verification.destinationVersionId,
      after: { reason: 'not_in_flight', status: verification.status, providerEventId: args.providerEventId },
    })
    return { applied: false, reason: 'not_in_flight', status: verification.status }
  }

  if (callback.outcome.status === 'verifying') {
    await markInterpreted(tx, eventRowId, 'still_pending')
    return { applied: false, reason: 'not_in_flight', status: 'verifying' }
  }

  const [version] = await tx
    .select()
    .from(schema.payoutDestinationVersions)
    .where(eq(schema.payoutDestinationVersions.id, verification.destinationVersionId))
    .limit(1)
  if (!version) {
    await markInterpreted(tx, eventRowId, 'unknown_verification')
    return { applied: false, reason: 'unknown_verification' }
  }
  const [destination] = await tx
    .select()
    .from(schema.payoutDestinations)
    .where(eq(schema.payoutDestinations.id, version.destinationId))
    .limit(1)
  if (!destination) {
    await markInterpreted(tx, eventRowId, 'unknown_verification')
    return { applied: false, reason: 'unknown_verification' }
  }

  const [beneficiary] = await tx
    .select()
    .from(schema.beneficiaries)
    .where(eq(schema.beneficiaries.id, destination.beneficiaryId))
    .limit(1)
  if (!beneficiary) {
    await markInterpreted(tx, eventRowId, 'unknown_verification')
    return { applied: false, reason: 'unknown_verification' }
  }

  await markInterpreted(tx, eventRowId, 'applied')
  const applied = await applyOutcome(tx, scope, {
    verificationId: verification.id,
    destinationVersionId: verification.destinationVersionId,
    destinationId: version.destinationId,
    beneficiaryId: destination.beneficiaryId,
    outcome: callback.outcome,
    actor: args.actor,
    provider,
    policies,
    expectedName: version.accountHolderName ?? beneficiary.legalName ?? beneficiary.displayName,
    providerEventId: eventRowId,
  })

  return { applied: true, verificationId: verification.id, status: applied.status }
}

async function markInterpreted(tx: Db, eventRowId: string, interpretation: string): Promise<void> {
  await tx
    .update(schema.providerEvents)
    .set({ interpretedAt: new Date(), interpretation })
    .where(eq(schema.providerEvents.id, eventRowId))
}

/** Throwing wrapper for call sites that genuinely want an exception. */
export async function requestVerificationOrThrow(
  db: Db,
  scope: TenantScope,
  provider: BeneficiaryVerificationProvider,
  cipher: FieldCipher,
  policies: NameMatchPolicySet,
  input: RequestVerificationInput,
): Promise<{ verificationId: string; status: 'verifying' | 'verified' | 'failed' }> {
  const result = await requestVerification(db, scope, provider, cipher, policies, input)
  if (!result.ok) {
    throw new BeneficiaryError(
      result.reason === 'version_not_found' ? 'destination_not_found' : 'invalid_payout_details',
      `Verification could not be started: ${result.reason}`,
      [{ reason: result.reason }],
    )
  }
  return { verificationId: result.verificationId, status: result.status }
}

/** The verification history of one version, newest first. */
export async function listVerifications(
  tx: Db,
  scope: TenantScope,
  destinationVersionId: string,
): Promise<(typeof schema.destinationVerifications.$inferSelect)[]> {
  return tx
    .select()
    .from(schema.destinationVerifications)
    .where(
      and(
        eq(schema.destinationVerifications.destinationVersionId, destinationVersionId),
        eq(schema.destinationVerifications.workspaceId, scope.workspaceId),
      ),
    )
    .orderBy(desc(schema.destinationVerifications.requestedAt))
}

/**
 * Beneficiaries and payout destinations — `DOMAIN.md § 6.2`.
 *
 * The one behaviour worth stating plainly, because everything else follows from
 * it: **editing payout details never mutates a row.** It appends a new
 * `payout_destination_version`, which starts `UNVERIFIED`, and moves
 * `current_version_id` to it. The previous version keeps its own verification,
 * its `verified_at`, and its history (`INV-44`, `INV-45`). Stage 3 will bind a
 * settlement to one exact version, and this is what makes that binding mean
 * something.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import {
  INITIAL_VERSION_VERIFICATION,
  deriveBeneficiaryStatus,
  destinationSummary,
  maskAccountNumber,
  normalisePayoutDetails,
  validateBeneficiaryIdentity,
  validatePayoutDetails,
  type BeneficiaryIdentity,
  type BeneficiaryStatus,
  type BeneficiaryType,
  type DestinationKind,
  type PayoutDetails,
  type DestinationFingerprinter,
  type PrincipalRef,
  type TenantScope,
  type VerificationStatus,
} from '@inrsettle/domain'
import { eventSink } from './events.js'
import type { FieldCipher } from './crypto/field-encryption.js'
import { fingerprintsEqual } from './crypto/destination-fingerprint.js'

/* ── Read models ───────────────────────────────────────────────────────── */

/**
 * What a destination version looks like *outside* this module.
 *
 * There is no `accountNumber` field, and there is no method that returns one.
 * `INV-12` is enforced by the shape of the read model rather than by remembering
 * to redact: the full number cannot appear in an API response, an event, an
 * audit record or a log line, because nothing that leaves here carries it.
 */
export interface DestinationVersionView {
  id: string
  destinationId: string
  versionNumber: number
  kind: DestinationKind
  accountNumberLast4: string | null
  ifsc: string | null
  accountType: string | null
  accountHolderName: string | null
  vpa: string | null
  summary: string
  // No `contentHash`/fingerprint field, deliberately. The fingerprint is a
  // keyed value whose only job is internal change detection; exposing it would
  // hand a caller an oracle they could compare against their own guesses.
  verificationStatus: VerificationStatus
  verificationMethod: string | null
  nameMatchScore: number | null
  verifiedAt: Date | null
  createdAt: Date
  supersededAt: Date | null
}

export interface DestinationView {
  id: string
  beneficiaryId: string
  kind: DestinationKind
  currentVersion: DestinationVersionView | null
  disabledAt: Date | null
}

export interface BeneficiaryView {
  id: string
  displayName: string
  legalName: string | null
  type: BeneficiaryType
  country: string
  taxIdLast4: string | null
  hasTaxId: boolean
  status: BeneficiaryStatus
  defaultDestinationId: string | null
  destinations: DestinationView[]
  createdAt: Date
  disabledAt: Date | null
}

/* ── Errors ────────────────────────────────────────────────────────────── */

export type BeneficiaryErrorCode =
  | 'beneficiary_not_found'
  | 'destination_not_found'
  | 'destination_disabled'
  | 'invalid_identity'
  | 'invalid_payout_details'
  | 'kind_change_not_allowed'

export class BeneficiaryError extends Error {
  constructor(
    readonly code: BeneficiaryErrorCode,
    message: string,
    readonly problems: readonly unknown[] = [],
  ) {
    super(message)
    this.name = 'BeneficiaryError'
  }
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

function versionContext(scope: TenantScope) {
  return {
    field: 'payout_destination_version.account_number',
    workspaceId: scope.workspaceId,
    environment: scope.environment,
  }
}

function taxIdContext(scope: TenantScope) {
  return {
    field: 'beneficiary.tax_id',
    workspaceId: scope.workspaceId,
    environment: scope.environment,
  }
}

type VersionRow = typeof schema.payoutDestinationVersions.$inferSelect
type VerificationRow = typeof schema.destinationVerifications.$inferSelect

function toVersionView(row: VersionRow, verification: VerificationRow | undefined): DestinationVersionView {
  return {
    id: row.id,
    destinationId: row.destinationId,
    versionNumber: row.versionNumber,
    kind: row.kind,
    accountNumberLast4: row.accountNumberLast4,
    ifsc: row.ifsc,
    accountType: row.accountType,
    accountHolderName: row.accountHolderName,
    vpa: row.vpa,
    summary: destinationSummary({
      kind: row.kind,
      ifsc: row.ifsc,
      accountNumberLast4: row.accountNumberLast4,
      vpa: row.vpa,
    }),
    // No verification row means the version has never been checked. A new
    // version therefore reads as unverified without anything writing that fact
    // down, which is the safe direction for this default to fail in.
    verificationStatus: verification?.status ?? INITIAL_VERSION_VERIFICATION,
    verificationMethod: verification?.method ?? null,
    nameMatchScore: verification?.nameMatchScore ?? null,
    verifiedAt: verification?.status === 'verified' ? verification.resolvedAt : null,
    createdAt: row.createdAt,
    supersededAt: row.supersededAt,
  }
}

/**
 * The verification that describes a version: the most recently resolved one, or
 * the in-flight one if nothing has resolved yet. Always keyed by version id, so
 * a verification can never describe details it did not check.
 */
async function verificationsForVersions(
  tx: Db,
  versionIds: readonly string[],
): Promise<Map<string, VerificationRow>> {
  if (versionIds.length === 0) return new Map()
  const rows = await tx
    .select()
    .from(schema.destinationVerifications)
    .where(inArray(schema.destinationVerifications.destinationVersionId, [...versionIds]))
    .orderBy(desc(schema.destinationVerifications.requestedAt))

  const out = new Map<string, VerificationRow>()
  for (const row of rows) {
    const existing = out.get(row.destinationVersionId)
    if (!existing) {
      out.set(row.destinationVersionId, row)
      continue
    }
    // A resolved outcome always describes the version better than an in-flight
    // attempt started after it, and `verified` outranks `failed` for the same
    // details because a later failed retry does not un-deliver a past check.
    const rank = (r: VerificationRow): number =>
      r.status === 'verified' ? 3 : r.status === 'failed' ? 2 : 1
    if (rank(row) > rank(existing)) out.set(row.destinationVersionId, row)
  }
  return out
}

/* ── Create ────────────────────────────────────────────────────────────── */

/**
 * The infrastructure a beneficiary write needs. Bundled because these two
 * always travel together and both hold key material — a call site that has one
 * and not the other is a mistake worth making impossible.
 */
export interface DestinationCrypto {
  readonly cipher: FieldCipher
  readonly fingerprinter: DestinationFingerprinter
}

export interface CreateBeneficiaryInput {
  identity: BeneficiaryIdentity
  /** Optional at creation: a beneficiary may be saved before its bank details. */
  destination?: PayoutDetails
  actor: PrincipalRef
}

export async function createBeneficiary(
  tx: Db,
  scope: TenantScope,
  crypto: DestinationCrypto,
  input: CreateBeneficiaryInput,
): Promise<BeneficiaryView> {
  const identityProblems = validateBeneficiaryIdentity(input.identity)
  if (identityProblems.length > 0) {
    throw new BeneficiaryError('invalid_identity', 'Beneficiary details are incomplete', identityProblems)
  }
  if (input.destination) {
    const problems = validatePayoutDetails(input.destination)
    if (problems.length > 0) {
      throw new BeneficiaryError('invalid_payout_details', 'Payout details are incomplete', problems)
    }
  }

  const beneficiaryId = newId('beneficiary')
  const taxId = input.identity.taxId?.trim()

  await tx.insert(schema.beneficiaries).values({
    id: beneficiaryId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    displayName: input.identity.displayName.trim(),
    legalName: input.identity.legalName?.trim() ?? null,
    type: input.identity.type,
    country: input.identity.country,
    taxIdCiphertext: taxId ? crypto.cipher.encrypt(taxId, taxIdContext(scope)) : null,
    taxIdLast4: taxId ? taxId.slice(-4) : null,
    status: 'draft',
    createdBy: input.actor.id,
  })

  const events = eventSink(tx)
  await events.audit(scope, {
    actor: input.actor,
    action: 'beneficiary.created',
    subjectType: 'beneficiary',
    subjectId: beneficiaryId,
    // Masked: an audit record is read by people, and INV-12 does not make an
    // exception for the audit log.
    after: { displayName: input.identity.displayName, type: input.identity.type, taxIdLast4: taxId?.slice(-4) ?? null },
  })
  await events.event(scope, {
    type: 'beneficiary.created',
    subjectType: 'beneficiary',
    subjectId: beneficiaryId,
    actor: input.actor,
    payload: { display_name: input.identity.displayName, type: input.identity.type },
    deliver: true,
  })

  if (input.destination) {
    await addPayoutDestination(tx, scope, crypto, {
      beneficiaryId,
      details: input.destination,
      actor: input.actor,
      makeDefault: true,
    })
  }

  return (await getBeneficiary(tx, scope, beneficiaryId))!
}

/* ── Destinations ──────────────────────────────────────────────────────── */

export interface AddDestinationInput {
  beneficiaryId: string
  details: PayoutDetails
  actor: PrincipalRef
  makeDefault?: boolean
}

export async function addPayoutDestination(
  tx: Db,
  scope: TenantScope,
  crypto: DestinationCrypto,
  input: AddDestinationInput,
): Promise<DestinationView> {
  const problems = validatePayoutDetails(input.details)
  if (problems.length > 0) {
    throw new BeneficiaryError('invalid_payout_details', 'Payout details are incomplete', problems)
  }
  const [beneficiary] = await tx
    .select()
    .from(schema.beneficiaries)
    .where(eq(schema.beneficiaries.id, input.beneficiaryId))
    .limit(1)
  if (!beneficiary) {
    throw new BeneficiaryError('beneficiary_not_found', 'No such beneficiary')
  }

  const destinationId = newId('payoutDestination')
  await tx.insert(schema.payoutDestinations).values({
    id: destinationId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    beneficiaryId: input.beneficiaryId,
    kind: input.details.kind,
    createdBy: input.actor.id,
  })

  await appendVersion(tx, scope, crypto, {
    destinationId,
    beneficiaryId: input.beneficiaryId,
    details: input.details,
    actor: input.actor,
    versionNumber: 1,
    action: 'payout_destination.created',
  })

  if (input.makeDefault || !beneficiary.defaultDestinationId) {
    await tx
      .update(schema.beneficiaries)
      .set({ defaultDestinationId: destinationId, updatedAt: new Date() })
      .where(eq(schema.beneficiaries.id, input.beneficiaryId))
  }

  await refreshBeneficiaryStatus(tx, scope, input.beneficiaryId)
  const view = await getDestination(tx, scope, destinationId)
  return view!
}

export interface EditDestinationInput {
  destinationId: string
  details: PayoutDetails
  actor: PrincipalRef
}

export interface EditDestinationResult {
  destination: DestinationView
  /** False when the details were identical and no version was created. */
  versionCreated: boolean
}

/**
 * Edit payout details.
 *
 * Nothing is updated in place. A new version is appended, it starts
 * `UNVERIFIED`, and the previous version is stamped `superseded_at` while
 * keeping its own verification intact.
 *
 * An edit that changes nothing creates nothing. This is not an optimisation:
 * without it, opening the edit form and pressing save would silently
 * un-verify a working destination, and the customer would have no way to tell
 * why their settlement suddenly needed action.
 */
export async function editPayoutDestination(
  tx: Db,
  scope: TenantScope,
  crypto: DestinationCrypto,
  input: EditDestinationInput,
): Promise<EditDestinationResult> {
  const problems = validatePayoutDetails(input.details)
  if (problems.length > 0) {
    throw new BeneficiaryError('invalid_payout_details', 'Payout details are incomplete', problems)
  }

  const [destination] = await tx
    .select()
    .from(schema.payoutDestinations)
    .where(eq(schema.payoutDestinations.id, input.destinationId))
    .limit(1)
  if (!destination) throw new BeneficiaryError('destination_not_found', 'No such payout destination')
  if (destination.disabledAt) {
    throw new BeneficiaryError('destination_disabled', 'This payout destination is disabled')
  }
  if (destination.kind !== input.details.kind) {
    // A bank account and a UPI id are different destinations, not two versions
    // of one. Allowing the change would let a verified bank account become an
    // unrelated VPA under an id a settlement may already reference.
    throw new BeneficiaryError(
      'kind_change_not_allowed',
      'Add a separate payout destination instead of changing this one between a bank account and UPI',
    )
  }

  const [current] = await tx
    .select()
    .from(schema.payoutDestinationVersions)
    .where(eq(schema.payoutDestinationVersions.destinationId, input.destinationId))
    .orderBy(desc(schema.payoutDestinationVersions.versionNumber))
    .limit(1)

  const fingerprint = crypto.fingerprinter.fingerprint(scope, input.details)
  if (current && fingerprintsEqual(current.detailsFingerprint, fingerprint)) {
    const view = await getDestination(tx, scope, input.destinationId)
    return { destination: view!, versionCreated: false }
  }

  const now = new Date()
  if (current) {
    await tx
      .update(schema.payoutDestinationVersions)
      .set({ supersededAt: now })
      .where(eq(schema.payoutDestinationVersions.id, current.id))
  }

  await appendVersion(tx, scope, crypto, {
    destinationId: input.destinationId,
    beneficiaryId: destination.beneficiaryId,
    details: input.details,
    actor: input.actor,
    versionNumber: (current?.versionNumber ?? 0) + 1,
    action: 'payout_destination.version_created',
    previousVersionId: current?.id,
  })

  await refreshBeneficiaryStatus(tx, scope, destination.beneficiaryId)
  const view = await getDestination(tx, scope, input.destinationId)
  return { destination: view!, versionCreated: true }
}

async function appendVersion(
  tx: Db,
  scope: TenantScope,
  crypto: DestinationCrypto,
  args: {
    destinationId: string
    beneficiaryId: string
    details: PayoutDetails
    actor: PrincipalRef
    versionNumber: number
    action: string
    previousVersionId?: string | undefined
  },
): Promise<string> {
  const versionId = newId('destinationVersion')
  // Store exactly what the fingerprint was taken over, so a row and its
  // fingerprint can never describe different details.
  const d = normalisePayoutDetails(args.details)

  await tx.insert(schema.payoutDestinationVersions).values({
    id: versionId,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    destinationId: args.destinationId,
    versionNumber: args.versionNumber,
    kind: d.kind,
    accountNumberCiphertext:
      d.kind === 'bank_account' ? crypto.cipher.encrypt(d.accountNumber, versionContext(scope)) : null,
    accountNumberLast4: d.kind === 'bank_account' ? maskAccountNumber(d.accountNumber) : null,
    ifsc: d.kind === 'bank_account' ? d.ifsc : null,
    accountType: d.kind === 'bank_account' ? d.accountType : null,
    accountHolderName: d.kind === 'bank_account' ? d.accountHolderName : null,
    vpa: d.kind === 'upi' ? d.vpa : null,
    detailsFingerprint: crypto.fingerprinter.fingerprint(scope, d),
    createdBy: args.actor.id,
  })

  await tx
    .update(schema.payoutDestinations)
    .set({ currentVersionId: versionId })
    .where(eq(schema.payoutDestinations.id, args.destinationId))

  const summary = destinationSummary({
    kind: d.kind,
    ifsc: d.kind === 'bank_account' ? d.ifsc : null,
    accountNumberLast4: d.kind === 'bank_account' ? maskAccountNumber(d.accountNumber) : null,
    vpa: d.kind === 'upi' ? d.vpa : null,
  })

  const events = eventSink(tx)
  await events.audit(scope, {
    actor: args.actor,
    action: args.action,
    subjectType: 'payout_destination_version',
    subjectId: versionId,
    // The summary is the masked form. There is no branch of this call that can
    // put a full account number into the audit log.
    after: {
      destinationId: args.destinationId,
      versionNumber: args.versionNumber,
      summary,
      verificationStatus: INITIAL_VERSION_VERIFICATION,
    },
    ...(args.previousVersionId ? { before: { versionId: args.previousVersionId } } : {}),
  })
  await events.event(scope, {
    type: args.action,
    subjectType: 'payout_destination',
    subjectId: args.destinationId,
    actor: args.actor,
    payload: {
      beneficiary_id: args.beneficiaryId,
      destination_version_id: versionId,
      version_number: args.versionNumber,
      summary,
      verification_status: INITIAL_VERSION_VERIFICATION,
    },
    deliver: true,
  })

  return versionId
}

/* ── Status ────────────────────────────────────────────────────────────── */

/**
 * Recompute the beneficiary's summary status from its destinations.
 *
 * The status is derived, never asserted: it cannot drift from the versions it
 * summarises, and it is never what execution checks — `INV-11` checks the
 * version.
 */
export async function refreshBeneficiaryStatus(
  tx: Db,
  scope: TenantScope,
  beneficiaryId: string,
): Promise<BeneficiaryStatus> {
  const [beneficiary] = await tx
    .select()
    .from(schema.beneficiaries)
    .where(eq(schema.beneficiaries.id, beneficiaryId))
    .limit(1)
  if (!beneficiary) throw new BeneficiaryError('beneficiary_not_found', 'No such beneficiary')

  const destinations = await tx
    .select()
    .from(schema.payoutDestinations)
    .where(
      and(
        eq(schema.payoutDestinations.beneficiaryId, beneficiaryId),
        sql`${schema.payoutDestinations.disabledAt} IS NULL`,
      ),
    )

  const currentVersionIds = destinations
    .map((d) => d.currentVersionId)
    .filter((v): v is string => v !== null)
  const verifications = await verificationsForVersions(tx, currentVersionIds)

  const status = deriveBeneficiaryStatus({
    disabled: beneficiary.disabledAt !== null,
    rejected: beneficiary.status === 'rejected',
    destinationCount: destinations.length,
    anyCurrentVersionVerified: currentVersionIds.some(
      (id) => verifications.get(id)?.status === 'verified',
    ),
  })

  if (status !== beneficiary.status) {
    await tx
      .update(schema.beneficiaries)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.beneficiaries.id, beneficiaryId))
  }
  return status
}

/* ── Reads ─────────────────────────────────────────────────────────────── */

export async function getBeneficiary(
  tx: Db,
  scope: TenantScope,
  beneficiaryId: string,
): Promise<BeneficiaryView | null> {
  const [row] = await tx
    .select()
    .from(schema.beneficiaries)
    .where(eq(schema.beneficiaries.id, beneficiaryId))
    .limit(1)
  if (!row) return null

  const destinations = await tx
    .select()
    .from(schema.payoutDestinations)
    .where(eq(schema.payoutDestinations.beneficiaryId, beneficiaryId))
    .orderBy(schema.payoutDestinations.createdAt)

  const currentVersionIds = destinations
    .map((d) => d.currentVersionId)
    .filter((v): v is string => v !== null)

  const versionRows = currentVersionIds.length
    ? await tx
        .select()
        .from(schema.payoutDestinationVersions)
        .where(inArray(schema.payoutDestinationVersions.id, currentVersionIds))
    : []
  const versions = new Map(versionRows.map((v) => [v.id, v]))
  const verifications = await verificationsForVersions(tx, currentVersionIds)

  return {
    id: row.id,
    displayName: row.displayName,
    legalName: row.legalName,
    type: row.type,
    country: row.country,
    taxIdLast4: row.taxIdLast4,
    hasTaxId: row.taxIdCiphertext !== null,
    status: row.status,
    defaultDestinationId: row.defaultDestinationId,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    destinations: destinations.map((d) => {
      const version = d.currentVersionId ? versions.get(d.currentVersionId) : undefined
      return {
        id: d.id,
        beneficiaryId: d.beneficiaryId,
        kind: d.kind,
        currentVersion: version
          ? toVersionView(version, verifications.get(version.id))
          : null,
        disabledAt: d.disabledAt,
      }
    }),
  }
}

export async function getDestination(
  tx: Db,
  scope: TenantScope,
  destinationId: string,
): Promise<DestinationView | null> {
  const [row] = await tx
    .select()
    .from(schema.payoutDestinations)
    .where(eq(schema.payoutDestinations.id, destinationId))
    .limit(1)
  if (!row) return null

  let currentVersion: DestinationVersionView | null = null
  if (row.currentVersionId) {
    const [version] = await tx
      .select()
      .from(schema.payoutDestinationVersions)
      .where(eq(schema.payoutDestinationVersions.id, row.currentVersionId))
      .limit(1)
    if (version) {
      const verifications = await verificationsForVersions(tx, [version.id])
      currentVersion = toVersionView(version, verifications.get(version.id))
    }
  }

  return {
    id: row.id,
    beneficiaryId: row.beneficiaryId,
    kind: row.kind,
    currentVersion,
    disabledAt: row.disabledAt,
  }
}

/** Every version of one destination, newest first — the history the customer can see. */
export async function listDestinationVersions(
  tx: Db,
  scope: TenantScope,
  destinationId: string,
): Promise<DestinationVersionView[]> {
  const rows = await tx
    .select()
    .from(schema.payoutDestinationVersions)
    .where(eq(schema.payoutDestinationVersions.destinationId, destinationId))
    .orderBy(desc(schema.payoutDestinationVersions.versionNumber))
  const verifications = await verificationsForVersions(tx, rows.map((r) => r.id))
  return rows.map((r) => toVersionView(r, verifications.get(r.id)))
}

export interface ListBeneficiariesOptions {
  limit?: number
  search?: string
  status?: BeneficiaryStatus
}

export async function listBeneficiaries(
  tx: Db,
  scope: TenantScope,
  options: ListBeneficiariesOptions = {},
): Promise<BeneficiaryView[]> {
  const limit = Math.min(options.limit ?? 50, 200)
  const conditions = []
  if (options.status) conditions.push(eq(schema.beneficiaries.status, options.status))
  if (options.search?.trim()) {
    const needle = `%${options.search.trim().toLowerCase()}%`
    conditions.push(sql`lower(${schema.beneficiaries.displayName}) LIKE ${needle}`)
  }

  const rows = await tx
    .select({ id: schema.beneficiaries.id })
    .from(schema.beneficiaries)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.beneficiaries.createdAt))
    .limit(limit)

  const out: BeneficiaryView[] = []
  for (const { id } of rows) {
    const view = await getBeneficiary(tx, scope, id)
    if (view) out.push(view)
  }
  return out
}

/**
 * The plaintext account number, for the verification call and nothing else.
 *
 * Not exported from the package barrel. The only caller is
 * `verification.service.ts`, which passes it straight to a provider adapter and
 * never returns it. Keeping it here rather than on the read model is what makes
 * "there is no decrypt-for-display path" a fact about the code.
 */
export async function decryptAccountNumberForVerification(
  tx: Db,
  scope: TenantScope,
  cipher: FieldCipher,
  versionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ ciphertext: schema.payoutDestinationVersions.accountNumberCiphertext })
    .from(schema.payoutDestinationVersions)
    .where(eq(schema.payoutDestinationVersions.id, versionId))
    .limit(1)
  if (!row?.ciphertext) return null
  return cipher.decrypt(row.ciphertext, versionContext(scope))
}

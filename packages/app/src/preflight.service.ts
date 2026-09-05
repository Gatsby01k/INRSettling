/**
 * Running preflight — `PRODUCT.md § 7`.
 *
 * The engine is pure and lives in `@inrsettle/domain`. This file does the two
 * impure things it cannot: assemble the subject from the database, and choose
 * the rule set version.
 *
 * The split matters for the determinism claim. "Same input, same output" is
 * only meaningful if the input is a value you can write down, so the subject is
 * built here, once, and handed over — the evaluator never reaches back for a
 * row it forgot to load.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import type { CurrencyCode } from '@inrsettle/money'
import {
  INITIAL_VERSION_VERIFICATION,
  destinationSummary,
  runPreflight,
  type PreflightOutcome,
  type PreflightRuleSet,
  type PreflightSubject,
  type TenantScope,
} from '@inrsettle/domain'
import { getBeneficiary } from './beneficiary.service.js'

export interface PreflightInput {
  beneficiaryId: string
  /** Which destination to check. Defaults to the beneficiary's default. */
  destinationId?: string
  amount: { currency: CurrencyCode; minorUnits: bigint }
  purposeCode: string | null
  documents?: readonly string[]
  /** Stage 4 owns liquidity; Stage 2 only needs the fact. */
  hasActiveLiquidityFacility: boolean
}

export type BuildSubjectResult =
  | { ok: true; subject: PreflightSubject }
  | { ok: false; reason: 'beneficiary_not_found' }

/**
 * Assemble the preflight subject.
 *
 * The destination that gets checked is the *current version* of the chosen
 * destination. A settlement authorized later is bound to that exact version
 * (`INV-11`, `INV-16`) — so if the customer edits the details between preflight
 * and authorization, a new version exists, it is unverified, and preflight will
 * say so on the next run rather than the settlement inheriting a stale pass.
 */
export async function buildPreflightSubject(
  tx: Db,
  scope: TenantScope,
  ruleSet: PreflightRuleSet,
  input: PreflightInput,
): Promise<BuildSubjectResult> {
  const beneficiary = await getBeneficiary(tx, scope, input.beneficiaryId)
  if (!beneficiary) return { ok: false, reason: 'beneficiary_not_found' }

  const chosen =
    beneficiary.destinations.find((d) =>
      input.destinationId ? d.id === input.destinationId : d.id === beneficiary.defaultDestinationId,
    ) ??
    // No default and none named: fall back to the first usable one, so a
    // beneficiary with exactly one destination never reports "no destination".
    beneficiary.destinations.find((d) => d.disabledAt === null)

  const usable = chosen && chosen.disabledAt === null && chosen.currentVersion ? chosen : undefined
  const purpose = ruleSet.purposeCodes.find((p) => p.code === input.purposeCode)

  const subject: PreflightSubject = {
    beneficiary: {
      id: beneficiary.id,
      displayName: beneficiary.displayName,
      legalName: beneficiary.legalName ?? beneficiary.displayName,
      type: beneficiary.type,
      status: beneficiary.status,
      country: beneficiary.country,
      hasTaxId: beneficiary.hasTaxId,
    },
    ...(usable?.currentVersion
      ? {
          destination: {
            id: usable.id,
            versionId: usable.currentVersion.id,
            kind: usable.currentVersion.kind,
            verificationStatus:
              usable.currentVersion.verificationStatus ?? INITIAL_VERSION_VERIFICATION,
            summary: usable.currentVersion.summary,
            nameMatchScore: usable.currentVersion.nameMatchScore,
          },
        }
      : {}),
    amount: input.amount,
    purpose: {
      code: input.purposeCode,
      label: purpose?.label ?? null,
      // Null while D-06 is open. A rule may require it; nothing invents it.
      regulatoryCode: purpose?.regulatoryCode ?? null,
    },
    workspace: {
      hasActiveLiquidityFacility: input.hasActiveLiquidityFacility,
      environment: scope.environment,
    },
    documents: input.documents ?? [],
  }

  return { ok: true, subject }
}

export type PreflightResult =
  | { ok: true; outcome: PreflightOutcome; subject: PreflightSubject }
  | { ok: false; reason: 'beneficiary_not_found' }

export async function runPreflightFor(
  tx: Db,
  scope: TenantScope,
  ruleSet: PreflightRuleSet,
  input: PreflightInput,
): Promise<PreflightResult> {
  const built = await buildPreflightSubject(tx, scope, ruleSet, input)
  if (!built.ok) return built
  return { ok: true, outcome: runPreflight(built.subject, ruleSet), subject: built.subject }
}

/** Purposes the customer may choose from, for the given rule set. */
export function availablePurposes(
  ruleSet: PreflightRuleSet,
): readonly { code: string; label: string }[] {
  return ruleSet.purposeCodes.map((p) => ({ code: p.code, label: p.label }))
}

/**
 * A destination summary for a version id, without loading the whole
 * beneficiary. Used by surfaces that render a requirement in isolation.
 */
export async function summariseVersion(tx: Db, versionId: string): Promise<string | null> {
  const [row] = await tx
    .select()
    .from(schema.payoutDestinationVersions)
    .where(eq(schema.payoutDestinationVersions.id, versionId))
    .limit(1)
  if (!row) return null
  return destinationSummary({
    kind: row.kind,
    ifsc: row.ifsc,
    accountNumberLast4: row.accountNumberLast4,
    vpa: row.vpa,
  })
}

/**
 * Name-match policy — `D-11` (open).
 *
 * There is no global name-match threshold, and there was never a defensible one.
 * A numeric score is not a property of "verification": it is a property of one
 * provider's implementation of one method. A penny drop may return the registry
 * name and no score; a lookup may return a score on an undocumented scale; some
 * methods return no name evidence at all. A single `NAME_MATCH_THRESHOLD = 80`
 * constant asserted that every provider speaks the same language, which is a
 * claim we cannot make until `D-11` is answered with real evidence.
 *
 * So the policy is **data, versioned and sourced**, exactly like the preflight
 * rules (`D-06`): a `NameMatchPolicySet` maps `(providerId, method)` to one of
 * four policies, and carries a `source` saying whether it came from a sandbox
 * fixture or from a real provider's documentation.
 *
 * The four policies are the four shapes the evidence can take:
 *
 *   `not_required`       the method supports no name evidence at all
 *   `provider_assertion` the provider asserts pass/fail and we take its word
 *   `numeric_score`      the provider supplies a score on a stated scale
 *   `registry_name`      the provider returns a name and INRSettle matches it
 *
 * The decision is total and fails closed: evidence the policy cannot use is
 * `insufficient_evidence`, never a pass.
 */
import type { VerificationMethod } from './destination.js'

/* ── Evidence ──────────────────────────────────────────────────────────── */

/**
 * What a provider actually returned about the name. A provider may return
 * several kinds at once; the policy picks the one it is written against.
 */
export interface NameMatchEvidence {
  /** The provider's own pass/fail assertion, where it makes one. */
  readonly asserted?: boolean | undefined
  /** A numeric score, on the scale the policy declares. */
  readonly score?: number | undefined
  /** The account-holder name the rail reported. */
  readonly registryName?: string | undefined
}

export const NO_NAME_EVIDENCE: NameMatchEvidence = {}

/* ── Policy ────────────────────────────────────────────────────────────── */

export type NameMatchPolicy =
  /**
   * The method carries no name evidence. A UPI handle lookup that only proves
   * the VPA resolves is the honest example: there is nothing to match against,
   * and pretending otherwise would be worse than saying so.
   */
  | { readonly kind: 'not_required'; readonly reason: string }
  /** The provider decides. Recorded as its assertion, not as our judgement. */
  | { readonly kind: 'provider_assertion' }
  /**
   * A numeric score. `scaleMax` is stated because "80" means nothing without
   * it — one provider's 0..100 is another's 0..1.
   */
  | {
      readonly kind: 'numeric_score'
      readonly minimumScore: number
      readonly scaleMax: number
      /** When true, a missing score is a pass. Default (absent) is: it is not. */
      readonly allowMissingScore?: boolean | undefined
    }
  /**
   * The provider returns the registry name and INRSettle does the comparison.
   * `minimumSimilarity` is on the 0..100 scale of `compareNames` below.
   */
  | { readonly kind: 'registry_name'; readonly minimumSimilarity: number }

export interface NameMatchPolicyEntry {
  readonly providerId: string
  readonly method: VerificationMethod
  readonly policy: NameMatchPolicy
}

export type PolicySource = 'sandbox_fixture' | 'provider_documented' | 'ad_bank'

export interface NameMatchPolicySet {
  readonly version: string
  /**
   * Where these policies came from. `sandbox_fixture` is simulator
   * configuration and is never presented as a statement about a real provider.
   */
  readonly source: PolicySource
  readonly description: string
  readonly entries: readonly NameMatchPolicyEntry[]
}

/**
 * The policy for one provider and method, or `undefined` when the pair is not
 * registered.
 *
 * There is deliberately no default policy. A fallback would have to be either
 * permissive — letting an unregistered provider verify names on rules nobody
 * wrote — or a fake unreachable threshold pretending to be a policy. Absence is
 * the truthful representation, and `decideNameMatch` fails closed on it.
 */
export function policyFor(
  set: NameMatchPolicySet,
  providerId: string,
  method: VerificationMethod,
): NameMatchPolicy | undefined {
  return set.entries.find((e) => e.providerId === providerId && e.method === method)?.policy
}

/* ── Name comparison ───────────────────────────────────────────────────── */

/** Honorifics and suffixes that carry no identity and vary by data source. */
const NOISE_TOKENS = new Set([
  'MR', 'MRS', 'MS', 'MISS', 'DR', 'SHRI', 'SMT', 'SRI', 'KUMARI',
  'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'INC', 'CO', 'COMPANY', 'AND', 'THE',
])

export function normaliseName(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && !NOISE_TOKENS.has(t))
}

/**
 * A deterministic similarity on 0..100.
 *
 * Token-set overlap against the shorter name, so "AARTI SHARMA" scores 100
 * against "AARTI R SHARMA" — a middle initial the bank holds and the customer
 * omitted is not a different person. An initial matches a token beginning with
 * it, which is the single most common real difference between what a customer
 * types and what a bank stores.
 *
 * This is deliberately simple and deliberately explainable. It is **not** a
 * fuzzy-matching library and makes no claim to be the final algorithm; a real
 * one is chosen with the first provider's data in hand (`D-11`). What it does
 * guarantee is that the comparison is ours, reproducible, and inspectable.
 */
export function compareNames(a: string, b: string): number {
  const left = normaliseName(a)
  const right = normaliseName(b)
  if (left.length === 0 || right.length === 0) return 0

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  const pool = [...longer]
  let matched = 0

  for (const token of shorter) {
    // Exact token first; it should not be consumed by a weaker initial match.
    const exact = pool.indexOf(token)
    if (exact !== -1) {
      pool.splice(exact, 1)
      matched += 1
      continue
    }
    if (token.length === 1) {
      const initial = pool.findIndex((p) => p.startsWith(token))
      if (initial !== -1) {
        pool.splice(initial, 1)
        matched += 1
        continue
      }
    } else {
      const initial = pool.findIndex((p) => p.length === 1 && token.startsWith(p))
      if (initial !== -1) {
        pool.splice(initial, 1)
        matched += 1
      }
    }
  }

  return Math.round((matched / shorter.length) * 100)
}

/* ── Decision ──────────────────────────────────────────────────────────── */

export type NameMatchOutcome =
  /** The policy is satisfied, or there was nothing to satisfy. */
  | 'satisfied'
  /** The evidence contradicts the name. */
  | 'mismatch'
  /** The policy needs evidence the provider did not supply. Never a pass. */
  | 'insufficient_evidence'

export interface NameMatchDecision {
  readonly outcome: NameMatchOutcome
  /** Which policy decided, for the audit record. */
  readonly basis: NameMatchPolicy['kind'] | 'unregistered'
  /** The score actually used, where the policy uses one. Null otherwise. */
  readonly score: number | null
  /** Short machine-readable explanation. Never customer copy. */
  readonly detail: string
}

/**
 * Decide whether the name evidence satisfies the policy.
 *
 * Total, pure, and closed: every branch returns a decision, and no branch
 * treats absent evidence as a pass unless the policy says so explicitly.
 */
export function decideNameMatch(
  policy: NameMatchPolicy | undefined,
  evidence: NameMatchEvidence,
  expectedName: string,
): NameMatchDecision {
  if (policy === undefined) {
    return {
      outcome: 'insufficient_evidence',
      basis: 'unregistered',
      score: null,
      detail: 'no name-match policy is registered for this provider and method',
    }
  }
  switch (policy.kind) {
    case 'not_required':
      return {
        outcome: 'satisfied',
        basis: 'not_required',
        score: null,
        detail: `no name check for this method: ${policy.reason}`,
      }

    case 'provider_assertion':
      if (evidence.asserted === undefined) {
        return {
          outcome: 'insufficient_evidence',
          basis: 'provider_assertion',
          score: null,
          detail: 'policy relies on the provider assertion, and none was returned',
        }
      }
      return {
        outcome: evidence.asserted ? 'satisfied' : 'mismatch',
        basis: 'provider_assertion',
        score: null,
        detail: `provider asserted ${evidence.asserted ? 'match' : 'mismatch'}`,
      }

    case 'numeric_score': {
      if (evidence.score === undefined || Number.isNaN(evidence.score)) {
        return policy.allowMissingScore === true
          ? {
              outcome: 'satisfied',
              basis: 'numeric_score',
              score: null,
              detail: 'no score returned; the policy accepts a missing score',
            }
          : {
              outcome: 'insufficient_evidence',
              basis: 'numeric_score',
              score: null,
              detail: 'no score returned and the policy requires one',
            }
      }
      // A score outside the declared scale means the provider is not speaking
      // the scale the policy was written against. That is a configuration
      // error, and guessing would be the dangerous option.
      if (evidence.score < 0 || evidence.score > policy.scaleMax) {
        return {
          outcome: 'insufficient_evidence',
          basis: 'numeric_score',
          score: evidence.score,
          detail: `score outside the declared 0..${policy.scaleMax} scale`,
        }
      }
      return {
        outcome: evidence.score >= policy.minimumScore ? 'satisfied' : 'mismatch',
        basis: 'numeric_score',
        score: evidence.score,
        detail: `score ${evidence.score} against a minimum of ${policy.minimumScore} on 0..${policy.scaleMax}`,
      }
    }

    case 'registry_name': {
      if (evidence.registryName === undefined || evidence.registryName.trim() === '') {
        return {
          outcome: 'insufficient_evidence',
          basis: 'registry_name',
          score: null,
          detail: 'policy matches on the registry name, and none was returned',
        }
      }
      const similarity = compareNames(expectedName, evidence.registryName)
      return {
        outcome: similarity >= policy.minimumSimilarity ? 'satisfied' : 'mismatch',
        basis: 'registry_name',
        score: similarity,
        detail: `similarity ${similarity} against a minimum of ${policy.minimumSimilarity}`,
      }
    }
  }
}

/* ── Validation ────────────────────────────────────────────────────────── */

export type PolicyDefect =
  | { problem: 'missing_field'; field: string }
  | { problem: 'unknown_source'; value: string }
  | { problem: 'unknown_policy_kind'; providerId: string; value: string }
  | { problem: 'not_required_without_reason'; providerId: string }
  | { problem: 'score_outside_scale'; providerId: string }
  | { problem: 'similarity_outside_range'; providerId: string }
  | { problem: 'duplicate_entry'; providerId: string; method: string }

const SOURCES: readonly PolicySource[] = ['sandbox_fixture', 'provider_documented', 'ad_bank']

export function validateNameMatchPolicySet(set: NameMatchPolicySet): PolicyDefect[] {
  const defects: PolicyDefect[] = []
  for (const field of ['version', 'description'] as const) {
    if (typeof set[field] !== 'string' || set[field] === '') {
      defects.push({ problem: 'missing_field', field })
    }
  }
  if (!SOURCES.includes(set.source)) {
    defects.push({ problem: 'unknown_source', value: String(set.source) })
  }

  const seen = new Set<string>()
  for (const entry of set.entries) {
    const key = `${entry.providerId}:${entry.method}`
    if (seen.has(key)) {
      defects.push({ problem: 'duplicate_entry', providerId: entry.providerId, method: entry.method })
    }
    seen.add(key)
    defects.push(...inspectPolicy(entry.providerId, entry.policy))
  }
  return defects
}

function inspectPolicy(providerId: string, policy: NameMatchPolicy): PolicyDefect[] {
  const defects: PolicyDefect[] = []
  switch (policy?.kind) {
    case 'not_required':
      // A method that skips the name check has to say why, in the policy data,
      // so the decision is reviewable rather than inherited.
      if (typeof policy.reason !== 'string' || policy.reason.trim().length < 12) {
        defects.push({ problem: 'not_required_without_reason', providerId })
      }
      break
    case 'provider_assertion':
      break
    case 'numeric_score':
      if (
        !Number.isFinite(policy.scaleMax) ||
        policy.scaleMax <= 0 ||
        (Number.isFinite(policy.minimumScore) &&
          (policy.minimumScore < 0 || policy.minimumScore > policy.scaleMax))
      ) {
        defects.push({ problem: 'score_outside_scale', providerId })
      }
      break
    case 'registry_name':
      if (policy.minimumSimilarity < 0 || policy.minimumSimilarity > 100) {
        defects.push({ problem: 'similarity_outside_range', providerId })
      }
      break
    default:
      defects.push({
        problem: 'unknown_policy_kind',
        providerId,
        value: String((policy as { kind?: unknown } | undefined)?.kind),
      })
  }
  return defects
}

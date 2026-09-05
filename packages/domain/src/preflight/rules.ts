/**
 * The preflight rule language — `PRODUCT.md § 7`, `DOMAIN.md § 6.3`.
 *
 * Two kinds of rule exist, and the difference is not stylistic:
 *
 *   **Policy rules** are compiled in. They restate closed decisions and frozen
 *   invariants — a settlement needs a verified beneficiary (`INV-11`), a live
 *   workspace needs a facility (`D-10`, closed). They cannot be edited by
 *   configuration because changing them would change the domain.
 *
 *   **Reference rules** are data. Everything that depends on the RBI/AD-bank
 *   purpose-code taxonomy and its document rules (`D-06`, open) arrives as a
 *   versioned rule set loaded from the `preflight_rule_sets` table, carrying
 *   its own `source`. Nothing in this file asserts what the AD bank requires;
 *   the sandbox fixture says what the *sandbox* requires and says so on its face.
 *
 * The evaluator is pure and total: same subject + same rule set version ⇒ same
 * requirement list, in the same order, with the same fingerprint.
 */
import { formatMoney, type CurrencyCode } from '@inrsettle/money'
import {
  inspectRequirement,
  sortRequirements,
  type Requirement,
  type RequirementAction,
  type RequirementDefect,
  type RequirementSeverity,
} from './requirement.js'
import type { DestinationKind, VerificationStatus } from '../beneficiaries/destination.js'
import type { BeneficiaryStatus, BeneficiaryType } from '../beneficiaries/beneficiary.js'

/**
 * Bumped whenever evaluation semantics change in a way that could produce a
 * different requirement list from the same subject and rule set. It is part of
 * the fingerprint, so a re-run after an engine change is explainable rather
 * than mysterious.
 */
export const PREFLIGHT_ENGINE_VERSION = '1'

/* ── Facts ─────────────────────────────────────────────────────────────── */

/**
 * The complete set of facts preflight may examine. A rule cannot reach past
 * this into the database, the clock, or a provider, which is what makes
 * determinism a property of the type rather than a promise.
 */
export interface PreflightSubject {
  readonly beneficiary: {
    readonly id: string
    readonly displayName: string
    readonly legalName: string
    readonly type: BeneficiaryType
    readonly status: BeneficiaryStatus
    readonly country: string
    readonly hasTaxId: boolean
  }
  /** Absent when the beneficiary has no usable destination at all. */
  readonly destination?: {
    readonly id: string
    readonly versionId: string
    readonly kind: DestinationKind
    readonly verificationStatus: VerificationStatus
    readonly summary: string
    readonly nameMatchScore: number | null
  }
  readonly amount: { readonly currency: CurrencyCode; readonly minorUnits: bigint }
  readonly purpose: {
    readonly code: string | null
    readonly label: string | null
    /** Null while `D-06` is open for this purpose; a rule may require it. */
    readonly regulatoryCode: string | null
  }
  readonly workspace: {
    readonly hasActiveLiquidityFacility: boolean
    readonly environment: 'sandbox' | 'live'
  }
  /** Document types already attached, e.g. `commercial_invoice`. */
  readonly documents: readonly string[]
}

export type FactName =
  | 'beneficiary_type'
  | 'beneficiary_status'
  | 'beneficiary_country'
  | 'beneficiary_has_tax_id'
  | 'destination_present'
  | 'destination_kind'
  | 'destination_verification_status'
  | 'amount_minor_units'
  | 'amount_currency'
  | 'purpose_code'
  | 'purpose_regulatory_code'
  | 'documents'
  | 'environment'
  | 'has_active_liquidity_facility'

export const FACT_NAMES = [
  'beneficiary_type',
  'beneficiary_status',
  'beneficiary_country',
  'beneficiary_has_tax_id',
  'destination_present',
  'destination_kind',
  'destination_verification_status',
  'amount_minor_units',
  'amount_currency',
  'purpose_code',
  'purpose_regulatory_code',
  'documents',
  'environment',
  'has_active_liquidity_facility',
] as const satisfies readonly FactName[]

type FactValue = string | boolean | bigint | readonly string[] | null

function factOf(subject: PreflightSubject, name: FactName): FactValue {
  switch (name) {
    case 'beneficiary_type':
      return subject.beneficiary.type
    case 'beneficiary_status':
      return subject.beneficiary.status
    case 'beneficiary_country':
      return subject.beneficiary.country
    case 'beneficiary_has_tax_id':
      return subject.beneficiary.hasTaxId
    case 'destination_present':
      return subject.destination !== undefined
    case 'destination_kind':
      return subject.destination?.kind ?? null
    case 'destination_verification_status':
      return subject.destination?.verificationStatus ?? null
    case 'amount_minor_units':
      return subject.amount.minorUnits
    case 'amount_currency':
      return subject.amount.currency
    case 'purpose_code':
      return subject.purpose.code
    case 'purpose_regulatory_code':
      return subject.purpose.regulatoryCode
    case 'documents':
      return subject.documents
    case 'environment':
      return subject.workspace.environment
    case 'has_active_liquidity_facility':
      return subject.workspace.hasActiveLiquidityFacility
  }
}

/* ── Conditions ────────────────────────────────────────────────────────── */

export type Comparison =
  | { fact: FactName; op: 'eq' | 'neq'; value: string | boolean }
  | { fact: FactName; op: 'in' | 'not_in'; value: readonly string[] }
  /** Amount comparisons take a decimal string of minor units — never a number. */
  | { fact: FactName; op: 'gte' | 'gt' | 'lte' | 'lt'; value: string }
  | { fact: FactName; op: 'includes' | 'not_includes'; value: string }
  | { fact: FactName; op: 'is_null' | 'is_not_null' }

export type Condition =
  | Comparison
  | { all: readonly Condition[] }
  | { any: readonly Condition[] }
  | { not: Condition }

export const ALWAYS: Condition = { all: [] }

export function evaluateCondition(c: Condition, subject: PreflightSubject): boolean {
  if ('all' in c) return c.all.every((x) => evaluateCondition(x, subject))
  if ('any' in c) return c.any.some((x) => evaluateCondition(x, subject))
  if ('not' in c) return !evaluateCondition(c.not, subject)

  const actual = factOf(subject, c.fact)
  switch (c.op) {
    case 'eq':
      return actual === c.value
    case 'neq':
      return actual !== c.value
    case 'in':
      return typeof actual === 'string' && c.value.includes(actual)
    case 'not_in':
      return !(typeof actual === 'string' && c.value.includes(actual))
    case 'gte':
    case 'gt':
    case 'lte':
    case 'lt': {
      if (typeof actual !== 'bigint') return false
      const rhs = BigInt(c.value)
      return c.op === 'gte'
        ? actual >= rhs
        : c.op === 'gt'
          ? actual > rhs
          : c.op === 'lte'
            ? actual <= rhs
            : actual < rhs
    }
    case 'includes':
      return Array.isArray(actual) && (actual as readonly string[]).includes(c.value)
    case 'not_includes':
      return Array.isArray(actual) && !(actual as readonly string[]).includes(c.value)
    case 'is_null':
      return actual === null
    case 'is_not_null':
      return actual !== null
  }
}

/* ── Rules ─────────────────────────────────────────────────────────────── */

/**
 * The action as written in a rule. Ids are bound by the evaluator from the
 * subject, so a rule can never name a beneficiary that is not the one being
 * checked.
 */
export type RuleAction =
  | { type: 'verify_beneficiary' }
  | { type: 'edit_beneficiary'; field: string }
  | { type: 'add_payout_destination' }
  | { type: 'upload_document'; documentType: string }
  | { type: 'select_purpose' }
  | { type: 'contact_support'; topic: string }
  | { type: 'set_up_liquidity_facility' }

/** The closed set of tokens rule copy may interpolate. */
export const COPY_TOKENS = [
  'amount',
  'beneficiary_name',
  'destination_summary',
  'purpose_label',
] as const
export type CopyToken = (typeof COPY_TOKENS)[number]

const TOKEN_PATTERN = /\{\{([a-z_]+)\}\}/g

export interface PreflightRule {
  readonly id: string
  readonly when: Condition
  readonly code: string
  readonly severity: RequirementSeverity
  readonly title: string
  readonly detail: string
  readonly action: RuleAction
}

export type RuleSetSource = 'sandbox_fixture' | 'ad_bank' | 'provider'

/**
 * A purpose the customer can pick. `regulatoryCode` is the AD-bank / RBI code
 * for inward remittance and stays **null** until `D-06` is closed with evidence
 * from a real partner — a sandbox fixture never fills it in.
 */
export interface PurposeCode {
  readonly code: string
  readonly label: string
  readonly regulatoryCode: string | null
}

export interface PreflightRuleSet {
  readonly version: string
  /**
   * Where these rules came from. `sandbox_fixture` rules are deterministic test
   * data and are never presented as regulatory truth; only `ad_bank` or
   * `provider` sets carry that weight, and none exist until `D-06` is answered
   * with evidence from a real partner.
   */
  readonly source: RuleSetSource
  readonly description: string
  readonly purposeCodes: readonly PurposeCode[]
  readonly rules: readonly PreflightRule[]
}

/* ── Policy rules (compiled in) ────────────────────────────────────────── */

/**
 * Frozen policy. Each rule below restates a closed decision or an invariant
 * from the signed baseline, and is deliberately not configurable.
 */
export const POLICY_RULES: readonly PreflightRule[] = [
  {
    id: 'policy.destination_missing',
    when: { fact: 'destination_present', op: 'eq', value: false },
    code: 'payout_destination_required',
    severity: 'blocking',
    title: 'This beneficiary needs a payout destination',
    detail:
      'Add the bank account or UPI ID that {{beneficiary_name}} should receive funds in before you settle.',
    action: { type: 'add_payout_destination' },
  },
  {
    id: 'policy.destination_unverified',
    when: { fact: 'destination_verification_status', op: 'eq', value: 'unverified' },
    code: 'beneficiary_account_unverified',
    severity: 'blocking',
    title: 'Beneficiary payout details need verification',
    detail:
      'We confirm that {{destination_summary}} accepts payments and matches the beneficiary name. This takes about a minute.',
    action: { type: 'verify_beneficiary' },
  },
  {
    /**
     * A failed check is a *different* requirement from an unstarted one. The
     * customer has already tried; repeating "needs verification" tells them
     * nothing, so this one names the fix.
     */
    id: 'policy.destination_verification_failed',
    when: { fact: 'destination_verification_status', op: 'eq', value: 'failed' },
    code: 'beneficiary_account_verification_failed',
    severity: 'blocking',
    title: 'We could not confirm these payout details',
    detail:
      'The bank did not accept {{destination_summary}}. Check the account number, IFSC and name with {{beneficiary_name}}, then save the corrected details.',
    action: { type: 'edit_beneficiary', field: 'payout_destination' },
  },
  {
    id: 'policy.destination_verifying',
    when: { fact: 'destination_verification_status', op: 'eq', value: 'verifying' },
    code: 'beneficiary_verification_in_progress',
    severity: 'blocking',
    title: 'Beneficiary verification is still running',
    detail:
      'We are confirming {{destination_summary}} now. This usually finishes within a minute — no action is needed from you.',
    action: { type: 'verify_beneficiary' },
  },
  {
    id: 'policy.beneficiary_rejected',
    when: { fact: 'beneficiary_status', op: 'eq', value: 'rejected' },
    code: 'beneficiary_rejected',
    severity: 'blocking',
    title: 'This beneficiary cannot receive settlements',
    detail:
      'Verification of {{beneficiary_name}} did not pass and the beneficiary was rejected. Our team can explain what was found.',
    action: { type: 'contact_support', topic: 'beneficiary_rejected' },
  },
  {
    id: 'policy.beneficiary_disabled',
    when: { fact: 'beneficiary_status', op: 'eq', value: 'disabled' },
    code: 'beneficiary_disabled',
    severity: 'blocking',
    title: 'This beneficiary is disabled',
    detail:
      'Someone in your workspace disabled {{beneficiary_name}}. Re-enable the beneficiary to settle to it again.',
    action: { type: 'edit_beneficiary', field: 'status' },
  },
  {
    id: 'policy.purpose_missing',
    when: { fact: 'purpose_code', op: 'is_null' },
    code: 'purpose_required',
    severity: 'blocking',
    title: 'Choose what this payment is for',
    detail:
      'Inward remittances to India are reported under a purpose. Pick the one that describes this settlement.',
    action: { type: 'select_purpose' },
  },
  {
    /**
     * `D-10` is closed: live authorization and execution require an active
     * facility. The requirement is raised here; liquidity itself is Stage 4 and
     * nothing in this module models a facility beyond this boolean fact.
     */
    id: 'policy.liquidity_facility',
    when: {
      all: [
        { fact: 'environment', op: 'eq', value: 'live' },
        { fact: 'has_active_liquidity_facility', op: 'eq', value: false },
      ],
    },
    code: 'liquidity_facility_required',
    severity: 'blocking',
    title: 'Your workspace needs an active settlement facility',
    detail:
      'Live settlements are funded from your INR facility. We will walk you through setting one up before your first live payout.',
    action: { type: 'set_up_liquidity_facility' },
  },
]

/* ── Evaluation ────────────────────────────────────────────────────────── */

export interface PreflightOutcome {
  readonly status: 'ready' | 'action_required'
  readonly requirements: readonly Requirement[]
  readonly ruleSetVersion: string
  readonly ruleSetSource: RuleSetSource
  readonly engineVersion: string
  /** Stable over identical inputs; changes if any of the above changes. */
  readonly fingerprint: string
}

function materialiseAction(a: RuleAction, subject: PreflightSubject): RequirementAction | null {
  switch (a.type) {
    case 'verify_beneficiary':
      if (!subject.destination) return null
      return {
        type: 'verify_beneficiary',
        beneficiaryId: subject.beneficiary.id,
        destinationVersionId: subject.destination.versionId,
      }
    case 'edit_beneficiary':
      return { type: 'edit_beneficiary', beneficiaryId: subject.beneficiary.id, field: a.field }
    case 'add_payout_destination':
      return { type: 'add_payout_destination', beneficiaryId: subject.beneficiary.id }
    case 'upload_document':
      return { type: 'upload_document', documentType: a.documentType }
    case 'select_purpose':
      return { type: 'select_purpose' }
    case 'contact_support':
      return { type: 'contact_support', topic: a.topic }
    case 'set_up_liquidity_facility':
      return { type: 'set_up_liquidity_facility' }
  }
}

function tokenValues(subject: PreflightSubject): Record<CopyToken, string> {
  return {
    amount: formatMoney(
      { currency: subject.amount.currency, minorUnits: subject.amount.minorUnits },
      { format: subject.amount.currency === 'INR' ? 'indian' : 'international' },
    ),
    beneficiary_name: subject.beneficiary.displayName,
    destination_summary: subject.destination?.summary ?? 'the payout destination',
    purpose_label: subject.purpose.label ?? 'the selected purpose',
  }
}

function interpolate(text: string, values: Record<CopyToken, string>): string {
  return text.replace(TOKEN_PATTERN, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name as CopyToken] : whole,
  )
}

/**
 * FNV-1a over the canonical rendering of the outcome. A short hash is enough:
 * it identifies a run for support and for the UI's "nothing changed" check, and
 * carries no security weight.
 */
function fingerprintOf(parts: readonly string[]): string {
  let h = 0x811c9dc5
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    h ^= 0x1f
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Run preflight.
 *
 * Policy rules are evaluated first, then the versioned reference rules. Output
 * order is normalised by `sortRequirements`, so evaluation order can never leak
 * into the result.
 */
export function runPreflight(
  subject: PreflightSubject,
  ruleSet: PreflightRuleSet,
): PreflightOutcome {
  const values = tokenValues(subject)
  const requirements: Requirement[] = []
  const seen = new Set<string>()

  for (const rule of [...POLICY_RULES, ...ruleSet.rules]) {
    if (!evaluateCondition(rule.when, subject)) continue
    if (seen.has(rule.code)) continue
    const action = materialiseAction(rule.action, subject)
    if (!action) {
      // The only unmaterialisable action is `verify_beneficiary` with no
      // destination, which `validateRules` already rejects at build time. Even
      // if one slipped through, `policy.destination_missing` fires on exactly
      // that state, so preflight still blocks — it can never silently become
      // ready. `preflight.test.ts` asserts this.
      continue
    }
    seen.add(rule.code)
    requirements.push({
      code: rule.code,
      severity: rule.severity,
      title: interpolate(rule.title, values),
      detail: interpolate(rule.detail, values),
      action,
    })
  }

  const sorted = sortRequirements(requirements)
  const blocking = sorted.filter((r) => r.severity === 'blocking')

  return {
    status: blocking.length === 0 ? 'ready' : 'action_required',
    requirements: sorted,
    ruleSetVersion: ruleSet.version,
    ruleSetSource: ruleSet.source,
    engineVersion: PREFLIGHT_ENGINE_VERSION,
    fingerprint: fingerprintOf([
      PREFLIGHT_ENGINE_VERSION,
      ruleSet.version,
      ...sorted.map((r) => `${r.code}|${r.severity}|${r.title}|${r.detail}|${JSON.stringify(r.action)}`),
    ]),
  }
}

/* ── Rule-set validation ───────────────────────────────────────────────── */

export type RuleDefect =
  | { ruleId: string; problem: 'duplicate_id' }
  | { ruleId: string; problem: 'duplicate_code' }
  | { ruleId: string; problem: 'unknown_fact'; fact: string }
  | { ruleId: string; problem: 'unknown_operator'; op: string }
  | { ruleId: string; problem: 'amount_value_not_integer_string'; value: string }
  | { ruleId: string; problem: 'unknown_copy_token'; token: string }
  | { ruleId: string; problem: 'verify_action_without_destination_guard' }
  | { ruleId: string; problem: 'requirement'; defect: RequirementDefect }

const VALID_OPS = new Set([
  'eq',
  'neq',
  'in',
  'not_in',
  'gte',
  'gt',
  'lte',
  'lt',
  'includes',
  'not_includes',
  'is_null',
  'is_not_null',
])

function inspectCondition(c: Condition, ruleId: string, out: RuleDefect[]): void {
  // Total by construction: this is a CI gate over data-loaded rule sets, so a
  // malformed rule has to come back as a defect, never as a thrown error.
  if (typeof c !== 'object' || c === null) {
    return void out.push({ ruleId, problem: 'unknown_fact', fact: String(c) })
  }
  if ('all' in c) return c.all.forEach((x) => inspectCondition(x, ruleId, out))
  if ('any' in c) return c.any.forEach((x) => inspectCondition(x, ruleId, out))
  if ('not' in c) return inspectCondition(c.not, ruleId, out)

  if (!(FACT_NAMES as readonly string[]).includes(c.fact)) {
    out.push({ ruleId, problem: 'unknown_fact', fact: String(c.fact) })
  }
  if (!VALID_OPS.has(c.op)) out.push({ ruleId, problem: 'unknown_operator', op: String(c.op) })
  if (c.op === 'gte' || c.op === 'gt' || c.op === 'lte' || c.op === 'lt') {
    if (!/^-?\d+$/.test(c.value)) {
      out.push({ ruleId, problem: 'amount_value_not_integer_string', value: String(c.value) })
    }
  }
}

function inspectCopy(text: string, ruleId: string, out: RuleDefect[]): void {
  if (typeof text !== 'string') return
  for (const m of text.matchAll(TOKEN_PATTERN)) {
    const token = m[1] ?? ''
    if (!(COPY_TOKENS as readonly string[]).includes(token)) {
      out.push({ ruleId, problem: 'unknown_copy_token', token })
    }
  }
}

/**
 * A condition guards on destination presence when every branch that can be true
 * requires it — either `destination_present = true` directly, or a comparison
 * on a destination fact, which is null when there is no destination.
 */
function guardsOnDestination(c: Condition): boolean {
  if (typeof c !== 'object' || c === null) return false
  if ('all' in c) return c.all.some(guardsOnDestination)
  if ('any' in c) return c.any.length > 0 && c.any.every(guardsOnDestination)
  if ('not' in c) return false
  if (c.fact === 'destination_present') return c.op === 'eq' && c.value === true
  if (c.fact === 'destination_kind' || c.fact === 'destination_verification_status') {
    return c.op === 'eq' || c.op === 'in' || c.op === 'is_not_null'
  }
  return false
}

/**
 * Structural validation of a whole rule set, applied to every rule whether or
 * not it can fire. This is what CI runs: a rule missing a title, a detail or an
 * action fails the build rather than reaching a customer as an empty card.
 *
 * Copy is checked *before* interpolation, so a token that resolves to an empty
 * string cannot hide a missing sentence.
 */
export function validateRules(rules: readonly PreflightRule[]): RuleDefect[] {
  const out: RuleDefect[] = []
  const ids = new Set<string>()
  const codes = new Set<string>()

  for (const rule of rules) {
    if (ids.has(rule.id)) out.push({ ruleId: rule.id, problem: 'duplicate_id' })
    ids.add(rule.id)
    if (codes.has(rule.code)) out.push({ ruleId: rule.id, problem: 'duplicate_code' })
    codes.add(rule.code)

    inspectCondition(rule.when, rule.id, out)
    inspectCopy(rule.title, rule.id, out)
    inspectCopy(rule.detail, rule.id, out)

    // A `verify_beneficiary` action names a destination *version*, so the rule
    // must only be reachable when there is one. Without this guard the rule
    // would be silently unmaterialisable rather than wrong-but-visible.
    if (rule.action?.type === 'verify_beneficiary' && !guardsOnDestination(rule.when)) {
      out.push({ ruleId: rule.id, problem: 'verify_action_without_destination_guard' })
    }

    // Requirement shape is checked on the raw copy: the placeholders are longer
    // than what they expand to in the shortest case, so this cannot pass copy
    // that would be too thin once rendered.
    for (const defect of inspectRequirement({
      code: rule.code,
      severity: rule.severity,
      title: rule.title,
      detail: rule.detail,
      action: rule.action ? ({ type: rule.action.type } as RequirementAction) : undefined,
    })) {
      out.push({ ruleId: rule.id, problem: 'requirement', defect })
    }
  }
  return out
}

/**
 * Validate one rule set as it will actually be evaluated: the compiled policy
 * rules plus that set's own rules. Two *different versions* of a reference set
 * are allowed to share codes — they are never active together — so sets are
 * never validated against each other.
 */
export function validateRuleSet(ruleSet: PreflightRuleSet): RuleDefect[] {
  return validateRules([...POLICY_RULES, ...ruleSet.rules])
}

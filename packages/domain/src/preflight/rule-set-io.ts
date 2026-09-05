/**
 * Parsing and checksumming versioned rule sets.
 *
 * Rule sets are *data*: they live in `reference/preflight/*.json`, are loaded
 * into `preflight_rule_sets`, and are read at evaluation time. Nothing in the
 * domain compiles in a purpose code or a document rule, because those depend on
 * `D-06` and no AD-bank answer exists yet.
 *
 * Parsing is total — it returns defects, it does not throw — and it is strict:
 * an unknown fact, an unknown operator or an incomplete requirement is rejected
 * here rather than surfacing as a blank card later.
 */
import { createHash } from 'node:crypto'
import {
  validateRuleSet,
  type Condition,
  type PreflightRule,
  type PreflightRuleSet,
  type RuleAction,
  type PurposeCode,
  type RuleDefect,
  type RuleSetSource,
} from './rules.js'

export type RuleSetParseResult =
  | { ok: true; ruleSet: PreflightRuleSet; checksum: string }
  | { ok: false; defects: readonly RuleSetParseDefect[] }

export type RuleSetParseDefect =
  | { problem: 'not_an_object' }
  | { problem: 'missing_field'; field: string }
  | { problem: 'unknown_source'; value: string }
  | { problem: 'rules_not_an_array' }
  | { problem: 'purpose_codes_not_an_array' }
  | { problem: 'purpose_code_invalid'; index: number }
  | { problem: 'sandbox_fixture_claims_regulatory_code'; code: string }
  | { problem: 'rule_not_an_object'; index: number }
  | { problem: 'rule_missing_field'; index: number; field: string }
  | { problem: 'rule_invalid_condition'; index: number }
  | { problem: 'rule_invalid_action'; index: number }
  | { problem: 'invalid_rule'; defect: RuleDefect }

const SOURCES: readonly RuleSetSource[] = ['sandbox_fixture', 'ad_bank', 'provider']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseCondition(v: unknown): Condition | null {
  if (!isRecord(v)) return null
  if (Array.isArray(v['all'])) {
    const parts = v['all'].map(parseCondition)
    return parts.every((p): p is Condition => p !== null) ? { all: parts } : null
  }
  if (Array.isArray(v['any'])) {
    const parts = v['any'].map(parseCondition)
    return parts.every((p): p is Condition => p !== null) ? { any: parts } : null
  }
  if ('not' in v) {
    const inner = parseCondition(v['not'])
    return inner ? { not: inner } : null
  }
  if (typeof v['fact'] !== 'string' || typeof v['op'] !== 'string') return null
  // Field-level validity (fact names, operators, value shapes) is checked by
  // `validateRuleSet` below, which reports precisely which rule is at fault.
  return { fact: v['fact'], op: v['op'], value: v['value'] } as unknown as Condition
}

function parseAction(v: unknown): RuleAction | null {
  if (!isRecord(v) || typeof v['type'] !== 'string') return null
  switch (v['type']) {
    case 'verify_beneficiary':
    case 'add_payout_destination':
    case 'select_purpose':
    case 'set_up_liquidity_facility':
      return { type: v['type'] }
    case 'edit_beneficiary':
      return typeof v['field'] === 'string' ? { type: 'edit_beneficiary', field: v['field'] } : null
    case 'upload_document':
      return typeof v['document_type'] === 'string'
        ? { type: 'upload_document', documentType: v['document_type'] }
        : null
    case 'contact_support':
      return typeof v['topic'] === 'string' ? { type: 'contact_support', topic: v['topic'] } : null
    default:
      return null
  }
}

export function parseRuleSet(input: unknown): RuleSetParseResult {
  const defects: RuleSetParseDefect[] = []
  if (!isRecord(input)) return { ok: false, defects: [{ problem: 'not_an_object' }] }

  for (const field of ['version', 'source', 'description']) {
    if (typeof input[field] !== 'string') defects.push({ problem: 'missing_field', field })
  }
  const source = input['source']
  if (typeof source === 'string' && !SOURCES.includes(source as RuleSetSource)) {
    defects.push({ problem: 'unknown_source', value: source })
  }
  if (!Array.isArray(input['rules'])) {
    defects.push({ problem: 'rules_not_an_array' })
    return { ok: false, defects }
  }

  const purposeCodes: PurposeCode[] = []
  if (!Array.isArray(input['purpose_codes'])) {
    defects.push({ problem: 'purpose_codes_not_an_array' })
  } else {
    input['purpose_codes'].forEach((raw: unknown, index: number) => {
      if (!isRecord(raw) || typeof raw['code'] !== 'string' || typeof raw['label'] !== 'string') {
        return void defects.push({ problem: 'purpose_code_invalid', index })
      }
      const regulatoryCode = raw['regulatory_code']
      if (regulatoryCode !== null && typeof regulatoryCode !== 'string') {
        return void defects.push({ problem: 'purpose_code_invalid', index })
      }
      // A sandbox fixture must not carry a regulatory code: `D-06` is open, and
      // a code invented for a simulator becoming production truth by being
      // written down is exactly the failure this guard exists to prevent.
      if (regulatoryCode !== null && source === 'sandbox_fixture') {
        defects.push({ problem: 'sandbox_fixture_claims_regulatory_code', code: raw['code'] })
      }
      purposeCodes.push({ code: raw['code'], label: raw['label'], regulatoryCode })
    })
  }

  const rules: PreflightRule[] = []
  input['rules'].forEach((raw: unknown, index: number) => {
    if (!isRecord(raw)) return void defects.push({ problem: 'rule_not_an_object', index })
    for (const field of ['id', 'code', 'severity', 'title', 'detail']) {
      if (typeof raw[field] !== 'string') defects.push({ problem: 'rule_missing_field', index, field })
    }
    const when = parseCondition(raw['when'])
    if (!when) defects.push({ problem: 'rule_invalid_condition', index })
    const action = parseAction(raw['action'])
    if (!action) defects.push({ problem: 'rule_invalid_action', index })
    if (!when || !action) return
    rules.push({
      id: String(raw['id']),
      when,
      code: String(raw['code']),
      severity: raw['severity'] === 'advisory' ? 'advisory' : 'blocking',
      title: String(raw['title']),
      detail: String(raw['detail']),
      action,
    })
  })

  if (defects.length > 0) return { ok: false, defects }

  const ruleSet: PreflightRuleSet = {
    version: String(input['version']),
    source: source as RuleSetSource,
    description: String(input['description']),
    // Sorted, so a rule set is the same value whether it came from a file or
    // from a database that returned its rows in a different order. Without
    // this the checksum would depend on row order and a round trip would look
    // like tampering.
    purposeCodes: [...purposeCodes].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    rules,
  }

  for (const defect of validateRuleSet(ruleSet)) defects.push({ problem: 'invalid_rule', defect })
  if (defects.length > 0) return { ok: false, defects }

  return { ok: true, ruleSet, checksum: ruleSetChecksum(ruleSet) }
}

/**
 * Serialise back to the wire shape `parseRuleSet` reads.
 *
 * Storage and loading have to be symmetric: a rule set written to the database
 * in one shape and read back in another is a round trip that fails only in
 * production. `parseRuleSet(toRuleSetJson(x))` is required to return `x`, and a
 * test asserts it.
 */
export function toRuleSetJson(ruleSet: PreflightRuleSet): Record<string, unknown> {
  return {
    version: ruleSet.version,
    source: ruleSet.source,
    description: ruleSet.description,
    purpose_codes: ruleSet.purposeCodes.map((p) => ({
      code: p.code,
      label: p.label,
      regulatory_code: p.regulatoryCode,
    })),
    rules: ruleSet.rules.map(toRuleJson),
  }
}

export function toRuleJson(rule: PreflightRule): Record<string, unknown> {
  return {
    id: rule.id,
    when: rule.when,
    code: rule.code,
    severity: rule.severity,
    title: rule.title,
    detail: rule.detail,
    action: actionToJson(rule.action),
  }
}

function actionToJson(a: RuleAction): Record<string, unknown> {
  switch (a.type) {
    case 'upload_document':
      return { type: a.type, document_type: a.documentType }
    case 'edit_beneficiary':
      return { type: a.type, field: a.field }
    case 'contact_support':
      return { type: a.type, topic: a.topic }
    default:
      return { type: a.type }
  }
}

/**
 * Checksum over the canonical form of the rules, so a rule set loaded from the
 * database can be proved identical to the file it came from. Field order is
 * fixed here rather than inherited from JSON key order.
 */
export function ruleSetChecksum(ruleSet: PreflightRuleSet): string {
  const canonical = JSON.stringify({
    version: ruleSet.version,
    source: ruleSet.source,
    purposeCodes: ruleSet.purposeCodes.map((p) => ({
      code: p.code,
      label: p.label,
      regulatoryCode: p.regulatoryCode,
    })),
    rules: ruleSet.rules.map((r) => ({
      id: r.id,
      code: r.code,
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      action: r.action,
      when: r.when,
    })),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

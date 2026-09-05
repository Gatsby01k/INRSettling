import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  POLICY_RULES,
  PREFLIGHT_ENGINE_VERSION,
  inspectRequirement,
  parseRuleSet,
  runPreflight,
  ruleSetChecksum,
  toRuleSetJson,
  validateRuleSet,
  validateRules,
  type PreflightRuleSet,
  type PreflightSubject,
} from '../index.js'

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../reference/preflight/sandbox-2026-09-01.json', import.meta.url),
)

function loadSandboxRuleSet(): PreflightRuleSet {
  const parsed = parseRuleSet(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')))
  if (!parsed.ok) throw new Error(`sandbox fixture is invalid: ${JSON.stringify(parsed.defects)}`)
  return parsed.ruleSet
}

const SANDBOX = loadSandboxRuleSet()

const EMPTY_RULE_SET: PreflightRuleSet = {
  version: 'empty-1',
  source: 'sandbox_fixture',
  description: 'No reference rules — policy only.',
  purposeCodes: [],
  rules: [],
}

/**
 * `destination` is optional-and-absent in `PreflightSubject`, not
 * optional-and-undefined: "this beneficiary has no destination" is a real
 * state, and `exactOptionalPropertyTypes` keeps the two apart. The helper
 * therefore rebuilds the object rather than spreading an override that might
 * be `undefined` over a property whose type does not admit it.
 */
type SubjectOverrides = Partial<Omit<PreflightSubject, 'destination'>> & {
  destination?: PreflightSubject['destination'] | undefined
}

function subject(overrides: SubjectOverrides = {}): PreflightSubject {
  const merged = {
    beneficiary: {
      id: 'ben_test',
      displayName: 'Aarti Sharma',
      legalName: 'Aarti Sharma',
      type: 'individual' as const,
      status: 'verified' as const,
      country: 'IN',
      hasTaxId: true,
    },
    destination: {
      id: 'dst_test',
      versionId: 'dvr_test_1',
      kind: 'bank_account' as const,
      verificationStatus: 'verified' as const,
      summary: 'HDFC •••• 4321',
      nameMatchScore: 96,
    },
    amount: { currency: 'INR' as const, minorUnits: 500_000_00n },
    purpose: { code: 'SOFTWARE_SERVICES', label: 'Software services', regulatoryCode: null },
    workspace: { hasActiveLiquidityFacility: true, environment: 'live' as const },
    documents: [] as readonly string[],
    ...overrides,
  }
  const { destination, ...rest } = merged
  return destination === undefined ? rest : { ...rest, destination }
}

describe('requirement shape', () => {
  it('every rule the system can evaluate has a code, title, detail and action', () => {
    expect(validateRuleSet(SANDBOX)).toEqual([])
  })

  it('rejects a rule missing any of the four fields', () => {
    for (const field of ['code', 'title', 'detail', 'action'] as const) {
      const broken = { ...POLICY_RULES[0]!, id: 'broken', [field]: undefined }
      const defects = validateRules([broken as never])
      expect(defects.length, `omitting ${field} must be a defect`).toBeGreaterThan(0)
    }
  })

  it('rejects generic copy', () => {
    expect(
      inspectRequirement({
        code: 'x_required',
        severity: 'blocking',
        title: 'Payment validation failed', // copy-check:allow — the phrase under test
        detail: 'Payment validation failed for this settlement request.', // copy-check:allow
        action: { type: 'select_purpose' },
      }),
    ).toContainEqual({ code: 'x_required', problem: 'generic_copy', phrase: 'validation failed' }) // copy-check:allow
  })

  it('rejects a copy token nothing can fill', () => {
    const defects = validateRules([
      { ...POLICY_RULES[0]!, id: 'bad_token', detail: 'Contact {{account_manager}} to continue now.' },
    ])
    expect(defects).toContainEqual({
      ruleId: 'bad_token',
      problem: 'unknown_copy_token',
      token: 'account_manager',
    })
  })

  it('rejects a verify action that is not guarded on a destination', () => {
    const defects = validateRules([
      {
        id: 'unguarded',
        when: { fact: 'beneficiary_status', op: 'eq', value: 'draft' },
        code: 'unguarded_verify',
        severity: 'blocking',
        title: 'Verify the beneficiary payout details',
        detail: 'This rule names a destination version without checking that one exists.',
        action: { type: 'verify_beneficiary' },
      },
    ])
    expect(defects).toContainEqual({
      ruleId: 'unguarded',
      problem: 'verify_action_without_destination_guard',
    })
  })

  it('rejects an unknown fact and an unknown operator', () => {
    const defects = validateRules([
      {
        ...POLICY_RULES[0]!,
        id: 'bad_condition',
        when: { fact: 'credit_score', op: 'roughly', value: 'high' } as never,
      },
    ])
    expect(defects).toContainEqual({
      ruleId: 'bad_condition',
      problem: 'unknown_fact',
      fact: 'credit_score',
    })
    expect(defects).toContainEqual({
      ruleId: 'bad_condition',
      problem: 'unknown_operator',
      op: 'roughly',
    })
  })
})

describe('policy rules', () => {
  it('is ready when nothing is outstanding', () => {
    const out = runPreflight(subject(), EMPTY_RULE_SET)
    expect(out.status).toBe('ready')
    expect(out.requirements).toEqual([])
  })

  it('raises liquidity_facility_required for live with no facility', () => {
    const out = runPreflight(
      subject({ workspace: { hasActiveLiquidityFacility: false, environment: 'live' } }),
      EMPTY_RULE_SET,
    )
    expect(out.status).toBe('action_required')
    expect(out.requirements.map((r) => r.code)).toContain('liquidity_facility_required')
    expect(out.requirements.find((r) => r.code === 'liquidity_facility_required')?.action).toEqual({
      type: 'set_up_liquidity_facility',
    })
  })

  it('does not require a facility in sandbox', () => {
    const out = runPreflight(
      subject({ workspace: { hasActiveLiquidityFacility: false, environment: 'sandbox' } }),
      EMPTY_RULE_SET,
    )
    expect(out.requirements.map((r) => r.code)).not.toContain('liquidity_facility_required')
  })

  it('an unverified destination blocks, and the action names that exact version', () => {
    const out = runPreflight(
      subject({
        destination: {
          id: 'dst_test',
          versionId: 'dvr_test_2',
          kind: 'bank_account',
          verificationStatus: 'unverified',
          summary: 'HDFC •••• 4321',
          nameMatchScore: null,
        },
      }),
      EMPTY_RULE_SET,
    )
    expect(out.status).toBe('action_required')
    expect(out.requirements[0]?.action).toEqual({
      type: 'verify_beneficiary',
      beneficiaryId: 'ben_test',
      destinationVersionId: 'dvr_test_2',
    })
  })

  it('distinguishes a failed check from an unstarted one', () => {
    const failed = runPreflight(
      subject({
        destination: {
          id: 'dst_test',
          versionId: 'dvr_test_2',
          kind: 'bank_account',
          verificationStatus: 'failed',
          summary: 'HDFC •••• 4321',
          nameMatchScore: 12,
        },
      }),
      EMPTY_RULE_SET,
    )
    expect(failed.requirements.map((r) => r.code)).toEqual([
      'beneficiary_account_verification_failed',
    ])
    expect(failed.requirements[0]?.action).toEqual({
      type: 'edit_beneficiary',
      beneficiaryId: 'ben_test',
      field: 'payout_destination',
    })
  })

  it('blocks when there is no destination at all, whatever else is true', () => {
    const out = runPreflight(subject({ destination: undefined }), SANDBOX)
    expect(out.status).toBe('action_required')
    expect(out.requirements.map((r) => r.code)).toContain('payout_destination_required')
  })

  it('requires a purpose', () => {
    const out = runPreflight(
      subject({ purpose: { code: null, label: null, regulatoryCode: null } }),
      EMPTY_RULE_SET,
    )
    expect(out.requirements.map((r) => r.code)).toContain('purpose_required')
  })
})

describe('sandbox reference rules', () => {
  it('requires an invoice above the fixture threshold and not below it', () => {
    const below = runPreflight(subject({ amount: { currency: 'INR', minorUnits: 999_999_99n } }), SANDBOX)
    const at = runPreflight(subject({ amount: { currency: 'INR', minorUnits: 1_000_000_00n } }), SANDBOX)
    expect(below.requirements.map((r) => r.code)).not.toContain('invoice_required')
    expect(at.requirements.map((r) => r.code)).toContain('invoice_required')
  })

  it('is satisfied once the document is attached', () => {
    const out = runPreflight(
      subject({ amount: { currency: 'INR', minorUnits: 1_000_000_00n }, documents: ['commercial_invoice'] }),
      SANDBOX,
    )
    expect(out.requirements.map((r) => r.code)).not.toContain('invoice_required')
    expect(out.status).toBe('ready')
  })

  it('interpolates the amount into the detail using Indian grouping', () => {
    const out = runPreflight(subject({ amount: { currency: 'INR', minorUnits: 1_000_000_00n } }), SANDBOX)
    const invoice = out.requirements.find((r) => r.code === 'invoice_required')
    expect(invoice?.detail).toContain('₹10,00,000.00')
    expect(invoice?.detail).not.toContain('{{')
  })

  it('an advisory requirement does not block', () => {
    const out = runPreflight(
      subject({ amount: { currency: 'INR', minorUnits: 5_000_000_00n }, documents: ['commercial_invoice'] }),
      SANDBOX,
    )
    expect(out.requirements.map((r) => r.code)).toContain('large_settlement_review')
    expect(out.status).toBe('ready')
  })

  it('carries no regulatory purpose code, because D-06 is open', () => {
    expect(SANDBOX.source).toBe('sandbox_fixture')
    for (const p of SANDBOX.purposeCodes) expect(p.regulatoryCode).toBeNull()
  })

  it('refuses to load a sandbox fixture that claims a regulatory code', () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
      purpose_codes: { code: string; regulatory_code: string | null }[]
    }
    raw.purpose_codes[0]!.regulatory_code = 'P0802'
    const parsed = parseRuleSet(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.defects).toContainEqual({
        problem: 'sandbox_fixture_claims_regulatory_code',
        code: raw.purpose_codes[0]!.code,
      })
    }
  })
})

describe('determinism', () => {
  it('same subject and rule set produce an identical result and fingerprint', () => {
    const s = subject({
      amount: { currency: 'INR', minorUnits: 2_000_000_00n },
      destination: {
        id: 'dst_test',
        versionId: 'dvr_test_9',
        kind: 'bank_account',
        verificationStatus: 'unverified',
        summary: 'ICIC •••• 0099',
        nameMatchScore: null,
      },
      workspace: { hasActiveLiquidityFacility: false, environment: 'live' },
    })
    const a = runPreflight(s, SANDBOX)
    const b = runPreflight(s, SANDBOX)
    expect(a).toEqual(b)
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.requirements.length).toBeGreaterThan(2)
  })

  it('output order does not depend on rule order', () => {
    const s = subject({
      amount: { currency: 'INR', minorUnits: 2_000_000_00n },
      workspace: { hasActiveLiquidityFacility: false, environment: 'live' },
    })
    const reversed: PreflightRuleSet = { ...SANDBOX, rules: [...SANDBOX.rules].reverse() }
    expect(runPreflight(s, reversed).requirements).toEqual(runPreflight(s, SANDBOX).requirements)
  })

  it('blocking requirements sort before advisory ones', () => {
    const out = runPreflight(
      subject({
        amount: { currency: 'INR', minorUnits: 5_000_000_00n },
        workspace: { hasActiveLiquidityFacility: false, environment: 'live' },
      }),
      SANDBOX,
    )
    const firstAdvisory = out.requirements.findIndex((r) => r.severity === 'advisory')
    const lastBlocking = out.requirements.map((r) => r.severity).lastIndexOf('blocking')
    expect(lastBlocking).toBeLessThan(firstAdvisory)
  })

  it('the result records the rule set version, its source and the engine version', () => {
    const out = runPreflight(subject(), SANDBOX)
    expect(out.ruleSetVersion).toBe('sandbox-2026-09-01')
    expect(out.ruleSetSource).toBe('sandbox_fixture')
    expect(out.engineVersion).toBe(PREFLIGHT_ENGINE_VERSION)
  })

  it('a different rule set version yields a different fingerprint for the same subject', () => {
    const s = subject({ amount: { currency: 'INR', minorUnits: 1_000_000_00n } })
    const relabelled: PreflightRuleSet = { ...SANDBOX, version: 'sandbox-9999-99-99' }
    expect(runPreflight(s, relabelled).fingerprint).not.toBe(runPreflight(s, SANDBOX).fingerprint)
  })

  it('the fixture checksum is stable across a parse round trip', () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const first = parseRuleSet(raw)
    const second = parseRuleSet(JSON.parse(JSON.stringify(raw)))
    expect(first.ok && second.ok && first.checksum === second.checksum).toBe(true)
    if (first.ok) expect(ruleSetChecksum(first.ruleSet)).toBe(first.checksum)
  })
})

describe('wire round trip', () => {
  it('parse(serialise(x)) returns x', () => {
    const again = parseRuleSet(toRuleSetJson(SANDBOX))
    expect(again.ok).toBe(true)
    if (again.ok) {
      expect(again.ruleSet).toEqual(SANDBOX)
      expect(again.checksum).toBe(ruleSetChecksum(SANDBOX))
    }
  })

  it('the checksum does not depend on purpose-code order', () => {
    const shuffled = {
      ...toRuleSetJson(SANDBOX),
      purpose_codes: [...(toRuleSetJson(SANDBOX)['purpose_codes'] as unknown[])].reverse(),
    }
    const parsed = parseRuleSet(shuffled)
    expect(parsed.ok && parsed.checksum).toBe(ruleSetChecksum(SANDBOX))
  })
})

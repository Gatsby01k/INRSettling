/**
 * The name-match policy replaces the old `NAME_MATCH_THRESHOLD = 80`.
 *
 * The property that matters most is the one at the bottom of this file: the
 * decision **fails closed**. Every path where the policy cannot use the
 * evidence it was given returns `insufficient_evidence`, and nothing treats
 * that as a pass.
 */
import { describe, expect, it } from 'vitest'
import {
  compareNames,
  decideNameMatch,
  normaliseName,
  policyFor,
  validateNameMatchPolicySet,
  type NameMatchEvidence,
  type NameMatchPolicy,
  type NameMatchPolicySet,
} from '../index.js'

const EXPECTED = 'Aarti Sharma'

describe('the removed global threshold', () => {
  it('is gone from the domain surface', async () => {
    const domain = (await import('../index.js')) as Record<string, unknown>
    expect(domain['NAME_MATCH_THRESHOLD']).toBeUndefined()
    expect(domain['isAcceptableNameMatch']).toBeUndefined()
  })
})

describe('policy: not_required', () => {
  const policy: NameMatchPolicy = {
    kind: 'not_required',
    reason: 'a VPA lookup returns no account-holder name to compare against',
  }

  it('is satisfied with no evidence at all', () => {
    const d = decideNameMatch(policy, {}, EXPECTED)
    expect(d.outcome).toBe('satisfied')
    expect(d.basis).toBe('not_required')
    expect(d.score).toBeNull()
    // The reason travels with the decision, so an auditor can see *why* no name
    // was checked rather than inferring it from a null.
    expect(d.detail).toContain('no account-holder name')
  })

  it('stays satisfied even when unrelated evidence happens to be present', () => {
    expect(decideNameMatch(policy, { score: 3 }, EXPECTED).outcome).toBe('satisfied')
  })
})

describe('policy: provider_assertion', () => {
  const policy: NameMatchPolicy = { kind: 'provider_assertion' }

  it('takes the provider at its word, either way', () => {
    expect(decideNameMatch(policy, { asserted: true }, EXPECTED).outcome).toBe('satisfied')
    expect(decideNameMatch(policy, { asserted: false }, EXPECTED).outcome).toBe('mismatch')
  })

  it('does not pass when the provider asserted nothing', () => {
    const d = decideNameMatch(policy, { score: 100, registryName: EXPECTED }, EXPECTED)
    expect(d.outcome).toBe('insufficient_evidence')
    // Evidence of a different kind is not a substitute: the policy was written
    // against the assertion, and silently falling back would apply rules nobody
    // agreed to.
    expect(d.detail).toContain('none was returned')
  })
})

describe('policy: numeric_score', () => {
  const policy: NameMatchPolicy = { kind: 'numeric_score', minimumScore: 80, scaleMax: 100 }

  it('passes at the minimum and fails just below it', () => {
    expect(decideNameMatch(policy, { score: 80 }, EXPECTED).outcome).toBe('satisfied')
    expect(decideNameMatch(policy, { score: 79 }, EXPECTED).outcome).toBe('mismatch')
  })

  it('records the score and the scale it was judged on', () => {
    const d = decideNameMatch(policy, { score: 84 }, EXPECTED)
    expect(d.score).toBe(84)
    expect(d.detail).toContain('0..100')
  })

  it('refuses a score outside the declared scale rather than guessing', () => {
    // A provider returning 0.84 on a policy written for 0..100 is a
    // configuration error. Reading it as 0.84 >= 80 (false) would be luck;
    // reading it as 84 would be a fabrication.
    const d = decideNameMatch({ ...policy, scaleMax: 1 }, { score: 84 }, EXPECTED)
    expect(d.outcome).toBe('insufficient_evidence')
    expect(d.detail).toContain('outside the declared')
  })

  it('does not pass when no score was returned', () => {
    expect(decideNameMatch(policy, {}, EXPECTED).outcome).toBe('insufficient_evidence')
    expect(decideNameMatch(policy, { score: Number.NaN }, EXPECTED).outcome).toBe('insufficient_evidence')
  })

  it('accepts a missing score only when the policy says so explicitly', () => {
    const permissive: NameMatchPolicy = { ...policy, allowMissingScore: true }
    const d = decideNameMatch(permissive, {}, EXPECTED)
    expect(d.outcome).toBe('satisfied')
    expect(d.score).toBeNull()
  })

  it('works on a non-percentage scale', () => {
    const zeroToOne: NameMatchPolicy = { kind: 'numeric_score', minimumScore: 0.8, scaleMax: 1 }
    expect(decideNameMatch(zeroToOne, { score: 0.9 }, EXPECTED).outcome).toBe('satisfied')
    expect(decideNameMatch(zeroToOne, { score: 0.5 }, EXPECTED).outcome).toBe('mismatch')
  })
})

describe('policy: registry_name — INRSettle does the matching', () => {
  const policy: NameMatchPolicy = { kind: 'registry_name', minimumSimilarity: 80 }

  it('matches an exact name', () => {
    const d = decideNameMatch(policy, { registryName: 'AARTI SHARMA' }, EXPECTED)
    expect(d.outcome).toBe('satisfied')
    expect(d.score).toBe(100)
    expect(d.basis).toBe('registry_name')
  })

  it('tolerates a middle initial the bank holds and the customer omitted', () => {
    expect(decideNameMatch(policy, { registryName: 'AARTI R SHARMA' }, EXPECTED).outcome).toBe('satisfied')
  })

  it('tolerates honorifics and punctuation', () => {
    expect(decideNameMatch(policy, { registryName: 'Ms. Aarti Sharma' }, EXPECTED).outcome).toBe('satisfied')
    expect(
      decideNameMatch(
        policy,
        { registryName: 'VERTEX SOFTWARE PVT. LTD.' },
        'Vertex Software Private Limited',
      ).outcome,
    ).toBe('satisfied')
  })

  it('rejects a different person', () => {
    const d = decideNameMatch(policy, { registryName: 'RAJESH KUMAR' }, EXPECTED)
    expect(d.outcome).toBe('mismatch')
    expect(d.score).toBe(0)
  })

  it('rejects a half match', () => {
    expect(decideNameMatch(policy, { registryName: 'AARTI VERMA' }, EXPECTED).outcome).toBe('mismatch')
  })

  it('does not pass when the rail returned no name', () => {
    expect(decideNameMatch(policy, {}, EXPECTED).outcome).toBe('insufficient_evidence')
    expect(decideNameMatch(policy, { registryName: '   ' }, EXPECTED).outcome).toBe('insufficient_evidence')
  })

  it('does not accept a provider score in place of the name it was told to match', () => {
    expect(decideNameMatch(policy, { score: 100 }, EXPECTED).outcome).toBe('insufficient_evidence')
  })
})

describe('name comparison', () => {
  it('strips honorifics and corporate suffixes that carry no identity', () => {
    expect(normaliseName('Mr. Aarti Sharma')).toEqual(['AARTI', 'SHARMA'])
    expect(normaliseName('Vertex Software Pvt Ltd')).toEqual(['VERTEX', 'SOFTWARE'])
  })

  it('is symmetric', () => {
    expect(compareNames('AARTI SHARMA', 'AARTI R SHARMA')).toBe(
      compareNames('AARTI R SHARMA', 'AARTI SHARMA'),
    )
  })

  it('is deterministic', () => {
    expect(compareNames(EXPECTED, 'AARTI R SHARMA')).toBe(compareNames(EXPECTED, 'AARTI R SHARMA'))
  })

  it('scores an empty or noise-only name at zero rather than at 100', () => {
    // "MR" normalises to nothing. Scoring an empty token set as a perfect match
    // would let a blank registry name verify anything.
    expect(compareNames(EXPECTED, '')).toBe(0)
    expect(compareNames(EXPECTED, 'MR.')).toBe(0)
  })

  it('does not let one registry token satisfy two expected tokens', () => {
    expect(compareNames('AARTI AARTI', 'AARTI')).toBe(100) // shorter side is the single token
    expect(compareNames('AARTI', 'AARTI AARTI')).toBe(100)
    expect(compareNames('AARTI SHARMA', 'AARTI AARTI')).toBe(50)
  })
})

describe('policy resolution', () => {
  const set: NameMatchPolicySet = {
    version: 'test-1',
    source: 'sandbox_fixture',
    description: 'A test policy set used only by this suite.',
    entries: [
      { providerId: 'p1', method: 'penny_drop', policy: { kind: 'registry_name', minimumSimilarity: 80 } },
      { providerId: 'p1', method: 'provider_lookup', policy: { kind: 'provider_assertion' } },
    ],
  }

  it('resolves by provider and method together', () => {
    expect(policyFor(set, 'p1', 'penny_drop')?.kind).toBe('registry_name')
    expect(policyFor(set, 'p1', 'provider_lookup')?.kind).toBe('provider_assertion')
  })

  it('returns nothing for an unregistered pair', () => {
    expect(policyFor(set, 'p1', 'manual')).toBeUndefined()
    expect(policyFor(set, 'unknown-provider', 'penny_drop')).toBeUndefined()
  })

  it('an unregistered pair cannot verify — it fails closed', () => {
    // The important half: no policy is not "no requirement".
    const d = decideNameMatch(policyFor(set, 'unknown-provider', 'penny_drop'), {
      asserted: true,
      score: 100,
      registryName: EXPECTED,
    }, EXPECTED)
    expect(d.outcome).toBe('insufficient_evidence')
    expect(d.basis).toBe('unregistered')
  })
})

describe('policy-set validation', () => {
  const valid: NameMatchPolicySet = {
    version: 'test-1',
    source: 'sandbox_fixture',
    description: 'A test policy set used only by this suite.',
    entries: [
      { providerId: 'p1', method: 'penny_drop', policy: { kind: 'registry_name', minimumSimilarity: 80 } },
    ],
  }

  it('accepts a well-formed set', () => {
    expect(validateNameMatchPolicySet(valid)).toEqual([])
  })

  it('requires a not_required policy to say why', () => {
    const defects = validateNameMatchPolicySet({
      ...valid,
      entries: [
        { providerId: 'p1', method: 'manual', policy: { kind: 'not_required', reason: 'n/a' } },
      ],
    })
    expect(defects).toContainEqual({ problem: 'not_required_without_reason', providerId: 'p1' })
  })

  it('rejects a threshold outside its own declared scale', () => {
    const defects = validateNameMatchPolicySet({
      ...valid,
      entries: [
        {
          providerId: 'p1',
          method: 'penny_drop',
          policy: { kind: 'numeric_score', minimumScore: 500, scaleMax: 100 },
        },
      ],
    })
    expect(defects).toContainEqual({ problem: 'score_outside_scale', providerId: 'p1' })
  })

  it('rejects a duplicate provider/method pair', () => {
    const defects = validateNameMatchPolicySet({
      ...valid,
      entries: [...valid.entries, ...valid.entries],
    })
    expect(defects).toContainEqual({ problem: 'duplicate_entry', providerId: 'p1', method: 'penny_drop' })
  })

  it('rejects an unknown source', () => {
    const defects = validateNameMatchPolicySet({ ...valid, source: 'vibes' as never })
    expect(defects).toContainEqual({ problem: 'unknown_source', value: 'vibes' })
  })

  it('rejects an unknown policy kind', () => {
    const defects = validateNameMatchPolicySet({
      ...valid,
      entries: [{ providerId: 'p1', method: 'penny_drop', policy: { kind: 'vibes' } as never }],
    })
    expect(defects).toContainEqual({ problem: 'unknown_policy_kind', providerId: 'p1', value: 'vibes' })
  })
})

describe('the decision is total and fails closed', () => {
  const policies: NameMatchPolicy[] = [
    { kind: 'not_required', reason: 'this method returns no name evidence at all' },
    { kind: 'provider_assertion' },
    { kind: 'numeric_score', minimumScore: 80, scaleMax: 100 },
    { kind: 'registry_name', minimumSimilarity: 80 },
  ]
  const evidences: NameMatchEvidence[] = [
    {},
    { asserted: true },
    { asserted: false },
    { score: 0 },
    { score: 100 },
    { registryName: '' },
    { registryName: 'RAJESH KUMAR' },
    { registryName: 'AARTI SHARMA' },
  ]

  it('returns a decision for every policy and evidence combination', () => {
    for (const policy of policies) {
      for (const evidence of evidences) {
        const d = decideNameMatch(policy, evidence, EXPECTED)
        expect(['satisfied', 'mismatch', 'insufficient_evidence']).toContain(d.outcome)
        expect(d.detail.length).toBeGreaterThan(8)
      }
    }
  })

  it('never satisfies an evidence-requiring policy on empty evidence', () => {
    for (const policy of policies.filter((p) => p.kind !== 'not_required')) {
      expect(decideNameMatch(policy, {}, EXPECTED).outcome, policy.kind).toBe('insufficient_evidence')
    }
  })
})

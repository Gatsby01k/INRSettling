import { beforeEach, describe, expect, it } from 'vitest'
import type { VerificationRequest } from '@inrsettle/domain'
import { decideNameMatch, policyFor, validateNameMatchPolicySet } from '@inrsettle/domain'
import {
  NoVerificationProviderError,
  SANDBOX_NAME_MATCH_POLICIES,
  SANDBOX_PROVIDER_ID,
  SANDBOX_SCENARIOS,
  SANDBOX_UPI_NAME_MATCH_POLICIES,
  SANDBOX_UPI_PROVIDER_ID,
  createSandboxVerificationProvider,
  createSandboxVpaVerificationProvider,
  mapFailureCode,
  resetVerificationProviders,
  scenarioFor,
  verificationProviderFor,
} from '../index.js'

const provider = createSandboxVerificationProvider()
const lookup = createSandboxVerificationProvider({ method: 'provider_lookup' })
const vpaProvider = createSandboxVpaVerificationProvider()

const NAME = 'AARTI SHARMA'

function bankRequest(accountNumber: string, overrides: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    requestId: 'req_fixed_1',
    destinationVersionId: 'dvr_fixed_1',
    kind: 'bank_account',
    accountNumber,
    ifsc: 'HDFC0000123',
    beneficiaryName: NAME,
    ...overrides,
  }
}

function vpaRequest(vpa: string, overrides: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    requestId: 'req_fixed_v',
    destinationVersionId: 'dvr_fixed_v',
    kind: 'upi',
    vpa,
    beneficiaryName: NAME,
    ...overrides,
  }
}

/** What the app layer does: provider reports evidence, policy decides. */
function decide(
  providerId: string,
  method: 'penny_drop' | 'provider_lookup' | 'manual',
  evidence: Parameters<typeof decideNameMatch>[1],
  set = SANDBOX_NAME_MATCH_POLICIES,
) {
  return decideNameMatch(policyFor(set, providerId, method), evidence, NAME)
}

describe('sandbox policy configuration', () => {
  it('is labelled as simulator configuration, not a real provider policy', () => {
    for (const set of [SANDBOX_NAME_MATCH_POLICIES, SANDBOX_UPI_NAME_MATCH_POLICIES]) {
      expect(set.source).toBe('sandbox_fixture')
      expect(set.description).toMatch(/NOT A REAL PROVIDER POLICY|NOT a real/i)
      expect(set.description).toMatch(/D-11 is OPEN/)
    }
  })

  it('is itself valid', () => {
    expect(validateNameMatchPolicySet(SANDBOX_NAME_MATCH_POLICIES)).toEqual([])
    expect(validateNameMatchPolicySet(SANDBOX_UPI_NAME_MATCH_POLICIES)).toEqual([])
  })

  it('is the only place the number 80 survives', () => {
    const pennyDrop = policyFor(SANDBOX_NAME_MATCH_POLICIES, SANDBOX_PROVIDER_ID, 'penny_drop')
    expect(pennyDrop).toEqual({ kind: 'registry_name', minimumSimilarity: 80 })
  })

  it('models UPI as having no name to match, with a stated reason', () => {
    const upi = policyFor(SANDBOX_UPI_NAME_MATCH_POLICIES, SANDBOX_UPI_PROVIDER_ID, 'provider_lookup')
    expect(upi?.kind).toBe('not_required')
    if (upi?.kind === 'not_required') expect(upi.reason).toMatch(/no account-holder name/)
  })
})

describe('scenario selection', () => {
  it('is a pure function of the payout details', () => {
    expect(scenarioFor({ kind: 'bank_account', accountNumber: '50100123456702' })).toBe(
      'failed_account_closed',
    )
    expect(scenarioFor({ kind: 'upi', vpa: 'pending.user@okaxis' })).toBe('pending_async')
  })

  it('defaults to success for an account that matches no scenario', () => {
    expect(scenarioFor({ kind: 'bank_account', accountNumber: '50100123456789' })).toBe(
      'confirmed_exact_name',
    )
  })

  it('every published scenario is reachable through its documented trigger', async () => {
    for (const s of SANDBOX_SCENARIOS) {
      if (s.bankAccountSuffix !== null) {
        expect(scenarioFor({ kind: 'bank_account', accountNumber: `5010012345${s.bankAccountSuffix}` })).toBe(
          s.scenario,
        )
        const outcome = await provider.verify(bankRequest(`5010012345${s.bankAccountSuffix}`))
        expect(['account_confirmed', 'failed', 'verifying']).toContain(outcome.status)
      }
      if (s.vpaPrefix !== null) {
        expect(scenarioFor({ kind: 'upi', vpa: `${s.vpaPrefix}.x@okicici` })).toBe(s.scenario)
        const outcome = await vpaProvider.verify(vpaRequest(`${s.vpaPrefix}.x@okicici`))
        expect(['account_confirmed', 'failed', 'verifying']).toContain(outcome.status)
      }
    }
  })
})

describe('bank account: shape validation and verification', () => {
  it('rejects a malformed IFSC before doing any lookup', async () => {
    for (const ifsc of ['HDFC123', 'hdfc0000123'.toUpperCase().slice(0, 5), '', 'HDFC1000123']) {
      const outcome = await provider.verify(bankRequest('50100123456789', { ifsc }))
      expect(outcome, ifsc).toMatchObject({ status: 'failed', reasonCode: 'invalid_ifsc' })
    }
  })

  it('accepts a well-formed IFSC and confirms the account', async () => {
    const outcome = await provider.verify(bankRequest('50100123456789'))
    expect(outcome.status).toBe('account_confirmed')
  })

  it('a penny drop returns the registry name and the policy matches it here', async () => {
    const outcome = await provider.verify(bankRequest('50100123456789'))
    if (outcome.status !== 'account_confirmed') throw new Error('expected confirmation')
    expect(outcome.nameEvidence.registryName).toBe(NAME)
    // The provider supplies no score at all on this method — deliberately, so a
    // score-based policy cannot be satisfied by penny-drop evidence.
    expect(outcome.nameEvidence.score).toBeUndefined()
    expect(decide(SANDBOX_PROVIDER_ID, 'penny_drop', outcome.nameEvidence).outcome).toBe('satisfied')
  })

  it('a confirmed account with a wrong name is a policy mismatch, not a provider verdict', async () => {
    const outcome = await provider.verify(bankRequest('50100123456704'))
    // The provider says the *account* is fine…
    expect(outcome.status).toBe('account_confirmed')
    if (outcome.status !== 'account_confirmed') return
    expect(outcome.nameEvidence.registryName).toBe('RAJESH KUMAR')
    // …and the policy is what refuses it.
    expect(decide(SANDBOX_PROVIDER_ID, 'penny_drop', outcome.nameEvidence).outcome).toBe('mismatch')
  })

  it('a confirmed account with no name returned cannot satisfy a registry-name policy', async () => {
    const outcome = await provider.verify(bankRequest('50100123456710'))
    expect(outcome.status).toBe('account_confirmed')
    if (outcome.status !== 'account_confirmed') return
    expect(outcome.nameEvidence.registryName).toBeUndefined()
    expect(decide(SANDBOX_PROVIDER_ID, 'penny_drop', outcome.nameEvidence).outcome).toBe(
      'insufficient_evidence',
    )
  })

  it('a lookup reports a score, judged on the scale its own policy declares', async () => {
    const good = await lookup.verify(bankRequest('50100123456789'))
    const weak = await lookup.verify(bankRequest('50100123456704'))
    if (good.status !== 'account_confirmed' || weak.status !== 'account_confirmed') {
      throw new Error('expected confirmations')
    }
    expect(good.nameEvidence.score).toBe(100)
    expect(weak.nameEvidence.score).toBe(21)
    expect(decide(SANDBOX_PROVIDER_ID, 'provider_lookup', good.nameEvidence).outcome).toBe('satisfied')
    expect(decide(SANDBOX_PROVIDER_ID, 'provider_lookup', weak.nameEvidence).outcome).toBe('mismatch')
  })

  it('reports definite negatives with a specific reason', async () => {
    const cases: [string, string][] = [
      ['50100123456701', 'account_not_found'],
      ['50100123456702', 'account_closed'],
      ['50100123456703', 'account_frozen'],
      ['50100123456705', 'invalid_ifsc'],
      ['50100123456706', 'rejected_by_bank'],
    ]
    for (const [account, reasonCode] of cases) {
      expect(await provider.verify(bankRequest(account)), account).toMatchObject({
        status: 'failed',
        reasonCode,
      })
    }
  })
})

describe('UPI: shape validation and the verifyVpa path', () => {
  it('accepts only a well-formed VPA', async () => {
    for (const bad of ['not-a-vpa', 'aarti@', '@okhdfcbank', 'aarti okhdfcbank', '']) {
      expect(await vpaProvider.verify(vpaRequest(bad)), bad).toMatchObject({
        status: 'failed',
        reasonCode: 'vpa_not_found',
      })
    }
    expect((await vpaProvider.verify(vpaRequest('aarti@okhdfcbank'))).status).toBe('account_confirmed')
  })

  it('confirms a resolvable handle', async () => {
    const outcome = await vpaProvider.verify(vpaRequest('aarti.sharma@okhdfcbank'))
    expect(outcome.status).toBe('account_confirmed')
  })

  it('verifies without a name, because its policy does not require one', async () => {
    const outcome = await vpaProvider.verify(vpaRequest('aarti@okhdfcbank'))
    if (outcome.status !== 'account_confirmed') throw new Error('expected confirmation')
    // This is the case the old global threshold got wrong: a UPI lookup has no
    // name to compare, and the honest policy says so rather than passing a null
    // through a numeric floor.
    const decision = decide(
      SANDBOX_UPI_PROVIDER_ID,
      'provider_lookup',
      outcome.nameEvidence,
      SANDBOX_UPI_NAME_MATCH_POLICIES,
    )
    expect(decision.outcome).toBe('satisfied')
    expect(decision.basis).toBe('not_required')
  })

  it('reports an unregistered handle as a definite negative', async () => {
    expect(await vpaProvider.verify(vpaRequest('unknown.person@okaxis'))).toMatchObject({
      status: 'failed',
      reasonCode: 'vpa_not_found',
    })
  })

  it('supports the async path for UPI too', async () => {
    const outcome = await vpaProvider.verify(vpaRequest('pending.user@okaxis'))
    expect(outcome.status).toBe('verifying')
  })

  it('the UPI adapter refuses a bank account', () => {
    expect(vpaProvider.supports('upi')).toBe(true)
    expect(vpaProvider.supports('bank_account')).toBe(false)
  })
})

describe('reproducibility', () => {
  it('the same request always produces the same outcome, for both kinds', async () => {
    for (const account of ['50100123456701', '50100123456704', '50100123456707', '50100123456789']) {
      expect(await provider.verify(bankRequest(account))).toEqual(
        await provider.verify(bankRequest(account)),
      )
    }
    for (const vpa of ['aarti@okhdfcbank', 'unknown.x@okaxis', 'pending.x@okaxis']) {
      expect(await vpaProvider.verify(vpaRequest(vpa))).toEqual(
        await vpaProvider.verify(vpaRequest(vpa)),
      )
    }
  })

  it('two provider instances agree', async () => {
    const other = createSandboxVerificationProvider()
    expect(await provider.verify(bankRequest('50100123456704'))).toEqual(
      await other.verify(bankRequest('50100123456704')),
    )
  })

  it('the pending reference is derived from the request, so a retry correlates', async () => {
    const outcome = await provider.verify(bankRequest('50100123456707'))
    expect(outcome.status).toBe('verifying')
    if (outcome.status === 'verifying') expect(outcome.providerReference).toBe('sbx_req_fixed_1')
  })
})

describe('INV-43 — an unmapped provider code is absorbed, never thrown', () => {
  it('maps an unknown code to unavailable', () => {
    expect(mapFailureCode('BANK_SAYS_NO_9271')).toBe('unavailable')
    expect(mapFailureCode('')).toBe('unavailable')
    expect(mapFailureCode('ACCOUNT_CLOSED')).toBe('account_closed')
  })

  it('the unmapped scenario yields a usable failure rather than an error', async () => {
    expect(await provider.verify(bankRequest('50100123456708'))).toMatchObject({
      status: 'failed',
      reasonCode: 'unavailable',
    })
  })

  it('interpret returns null for junk instead of throwing', () => {
    for (const junk of [null, undefined, 42, 'a string', {}, { request_id: 1 }]) {
      expect(() => provider.interpret?.(junk)).not.toThrow()
      expect(provider.interpret?.(junk)).toBeNull()
    }
  })

  it('interpret absorbs an unrecognised reason code', () => {
    const cb = provider.interpret?.({
      request_id: 'req_1',
      destination_version_id: 'dvr_1',
      event_id: 'pev_1',
      result: 'failed',
      reason_code: 'SOMETHING_NEW',
    })
    expect(cb?.outcome).toMatchObject({ status: 'failed', reasonCode: 'unavailable' })
  })

  it('interpret carries the destination version through unchanged', () => {
    const cb = provider.interpret?.({
      request_id: 'req_1',
      destination_version_id: 'dvr_specific_9',
      event_id: 'pev_1',
      result: 'account_confirmed',
      registry_name: NAME,
    })
    expect(cb?.destinationVersionId).toBe('dvr_specific_9')
    expect(cb?.outcome).toMatchObject({ status: 'account_confirmed' })
  })

  it('interpret carries every evidence shape a callback may bring', () => {
    const cb = provider.interpret?.({
      request_id: 'req_1',
      destination_version_id: 'dvr_1',
      event_id: 'pev_1',
      result: 'account_confirmed',
      name_match_score: 91,
      registry_name: NAME,
      name_matched: true,
    })
    if (cb?.outcome.status !== 'account_confirmed') throw new Error('expected confirmation')
    expect(cb.outcome.nameEvidence).toEqual({ score: 91, registryName: NAME, asserted: true })
  })
})

describe('provider selection', () => {
  beforeEach(() => resetVerificationProviders())

  it('sandbox resolves to the simulator', () => {
    expect(verificationProviderFor('sandbox').id).toBe(SANDBOX_PROVIDER_ID)
  })

  it('live refuses rather than falling back to the simulator', () => {
    // D-11 is open; there is no live adapter, and pretending otherwise would
    // mean claiming a destination is payable when nothing checked it.
    expect(() => verificationProviderFor('live')).toThrow(NoVerificationProviderError)
  })
})

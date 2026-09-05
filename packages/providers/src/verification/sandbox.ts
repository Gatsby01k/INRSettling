/**
 * The deterministic sandbox verification provider.
 *
 * A **simulator**, not a partner integration. It exists so every branch of the
 * verification flow — success, name mismatch, closed account, asynchronous
 * result, an unrecognised provider code — can be exercised on demand and
 * reproduced exactly.
 *
 * Two things it deliberately does not do:
 *
 *   It does not model a real provider's API. `D-11` (penny drop vs provider
 *   lookup, and who bears the cost) is open, and nothing here should be read as
 *   having answered it. The scenarios cover the *shapes* a real adapter must
 *   handle, not any named partner's behaviour.
 *
 *   It does not decide whether a name matched. It reports the evidence it
 *   "found"; the versioned name-match policy decides. That separation is what
 *   lets a real provider be added without the domain learning its scoring.
 */
import type {
  BeneficiaryVerificationProvider,
  DestinationKind,
  NameMatchEvidence,
  NameMatchPolicySet,
  VerificationCallback,
  VerificationFailureCode,
  VerificationMethod,
  VerificationOutcome,
  VerificationRequest,
} from '@inrsettle/domain'
import { VERIFICATION_FAILURE_CODES, IFSC_PATTERN, VPA_PATTERN } from '@inrsettle/domain'

export const SANDBOX_PROVIDER_ID = 'sandbox'

/**
 * **Sandbox simulator configuration — not a statement about any real provider.**
 *
 * The `80` that used to be a domain constant lives here, where it belongs: it
 * is the threshold *this simulator* is configured with, on the 0..100 scale
 * *this simulator* invents. A real provider's policy is registered separately
 * when `D-11` is answered, with a `provider_documented` source.
 */
export const SANDBOX_NAME_MATCH_POLICIES: NameMatchPolicySet = {
  version: 'sandbox-name-match-1',
  source: 'sandbox_fixture',
  description:
    'DETERMINISTIC SANDBOX SIMULATOR CONFIGURATION — NOT A REAL PROVIDER POLICY. ' +
    'The thresholds and scales below are invented for the sandbox so every branch of ' +
    'the name-match decision can be exercised. They say nothing about what any real ' +
    'payout partner returns. D-11 is OPEN: a real policy is registered with source ' +
    "'provider_documented' once a partner's actual name-match behaviour is known.",
  entries: [
    {
      providerId: SANDBOX_PROVIDER_ID,
      method: 'penny_drop',
      // A penny drop returns the registry name, so INRSettle does the matching.
      policy: { kind: 'registry_name', minimumSimilarity: 80 },
    },
    {
      providerId: SANDBOX_PROVIDER_ID,
      method: 'provider_lookup',
      // A lookup is simulated as returning a score on an explicit 0..100 scale.
      policy: { kind: 'numeric_score', minimumScore: 80, scaleMax: 100 },
    },
    {
      providerId: SANDBOX_PROVIDER_ID,
      method: 'manual',
      policy: { kind: 'provider_assertion' },
    },
  ],
}

/**
 * The UPI policy is separate and deliberately different in kind.
 *
 * A VPA lookup proves the handle resolves and is payable. Depending on the PSP
 * it may return no name at all, so a policy demanding one would make every UPI
 * destination unverifiable. `not_required` is the honest model, and it is
 * *registered configuration* rather than a silent special case in code.
 */
export const SANDBOX_UPI_PROVIDER_ID = 'sandbox-upi'

export const SANDBOX_UPI_NAME_MATCH_POLICIES: NameMatchPolicySet = {
  version: 'sandbox-upi-name-match-1',
  source: 'sandbox_fixture',
  description:
    'DETERMINISTIC SANDBOX SIMULATOR CONFIGURATION for the UPI path — NOT a real ' +
    'provider policy. Models a VPA lookup that confirms the handle resolves but ' +
    'returns no account-holder name. D-11 is OPEN.',
  entries: [
    {
      providerId: SANDBOX_UPI_PROVIDER_ID,
      method: 'provider_lookup',
      policy: {
        kind: 'not_required',
        reason:
          'a VPA lookup confirms the handle resolves and is payable but returns no ' +
          'account-holder name to compare against',
      },
    },
  ],
}

/* ── Scenarios ─────────────────────────────────────────────────────────── */

/**
 * How a scenario is chosen: the **last two digits** of a bank account number,
 * or the handle prefix of a VPA. A suffix rather than a magic account number
 * means a tester can steer any realistic-looking account, and the mapping fits
 * in one printable table.
 */
export type SandboxScenario =
  | 'confirmed_exact_name'
  | 'confirmed_partial_name'
  | 'confirmed_no_name_returned'
  | 'confirmed_weak_name'
  | 'failed_account_not_found'
  | 'failed_account_closed'
  | 'failed_account_frozen'
  | 'failed_invalid_ifsc'
  | 'failed_vpa_not_found'
  | 'failed_rejected_by_bank'
  | 'pending_async'
  | 'unmapped_provider_code'

export const SANDBOX_SCENARIOS: readonly {
  scenario: SandboxScenario
  bankAccountSuffix: string | null
  vpaPrefix: string | null
  description: string
}[] = [
  {
    scenario: 'failed_account_not_found',
    bankAccountSuffix: '01',
    vpaPrefix: 'notfound',
    description: 'The account does not exist at that IFSC.',
  },
  {
    scenario: 'failed_account_closed',
    bankAccountSuffix: '02',
    vpaPrefix: null,
    description: 'The account exists but is closed.',
  },
  {
    scenario: 'failed_account_frozen',
    bankAccountSuffix: '03',
    vpaPrefix: null,
    description: 'The account is frozen and cannot receive credits.',
  },
  {
    scenario: 'confirmed_weak_name',
    bankAccountSuffix: '04',
    vpaPrefix: 'mismatch',
    description: 'The account is real but the registry name does not match.',
  },
  {
    scenario: 'failed_invalid_ifsc',
    bankAccountSuffix: '05',
    vpaPrefix: null,
    description: 'The IFSC is well formed but no such branch exists.',
  },
  {
    scenario: 'failed_rejected_by_bank',
    bankAccountSuffix: '06',
    vpaPrefix: null,
    description: 'The bank refused the check without giving a reason.',
  },
  {
    scenario: 'pending_async',
    bankAccountSuffix: '07',
    vpaPrefix: 'pending',
    description: 'Accepted and still running; the result arrives as a callback.',
  },
  {
    scenario: 'unmapped_provider_code',
    bankAccountSuffix: '08',
    vpaPrefix: null,
    description: 'The provider returns a code we have never seen (INV-43).',
  },
  {
    scenario: 'confirmed_partial_name',
    bankAccountSuffix: '09',
    vpaPrefix: null,
    description: 'Confirmed with a partial but acceptable name match.',
  },
  {
    scenario: 'confirmed_no_name_returned',
    bankAccountSuffix: '10',
    vpaPrefix: null,
    description: 'Confirmed; the rail returned no name to compare.',
  },
  {
    scenario: 'failed_vpa_not_found',
    bankAccountSuffix: null,
    vpaPrefix: 'unknown',
    description: 'The VPA is not registered with any PSP.',
  },
  {
    scenario: 'confirmed_exact_name',
    bankAccountSuffix: null,
    vpaPrefix: null,
    description: 'Default — confirmed with an exact name match.',
  },
]

/**
 * The frozen four-digit scenario table takes precedence over this file's own
 * two-digit one — `ARCHITECTURE.md § 5.1`.
 *
 * Both tables read the *same field*, the sandbox account number, and they claim
 * different widths of it: this simulator was built first and took the last two
 * digits, while the frozen table takes the last four. So `…0002` is
 * simultaneously "payout rejected: account closed" in the frozen document and
 * `failed_account_closed` here — and a beneficiary that cannot be verified
 * never reaches a payout at all, which makes every four-digit payout scenario
 * unreachable.
 *
 * The frozen document is the authority, so it is consulted first:
 *
 * - `…0006` is the one row the frozen table assigns to *this* stage — "name
 *   mismatch at verification" — and it maps to `confirmed_weak_name`, which is
 *   the name-mismatch scenario. Note that this simulator's own `06` means
 *   something else entirely ("the bank refused the check"); where the two
 *   disagree, the signed baseline wins.
 * - every other four-digit frozen suffix verifies cleanly, because those
 *   scenarios are about a *later* leg — funding, payout, reconciliation — and
 *   failing them here would test the wrong thing.
 *
 * An account number that is not in the frozen table falls through to this
 * file's two-digit scenarios, which remain the richer set for exercising
 * verification itself.
 */
const FROZEN_SUFFIXES = [
  '0000', '0001', '0002', '0003', '0004', '0005', '0006', '0007',
  '0008', '0009', '0010', '0011', '0012', '0013', '0014',
] as const

export function scenarioFor(req: {
  kind: DestinationKind
  accountNumber?: string | undefined
  vpa?: string | undefined
}): SandboxScenario {
  if (req.kind === 'upi') {
    const handle = (req.vpa ?? '').split('@')[0]?.toLowerCase() ?? ''
    const match = SANDBOX_SCENARIOS.find((s) => s.vpaPrefix !== null && handle.startsWith(s.vpaPrefix))
    return match?.scenario ?? 'confirmed_exact_name'
  }

  const account = req.accountNumber ?? ''
  const frozen = FROZEN_SUFFIXES.find((suffix) => account.endsWith(suffix))
  if (frozen) {
    return frozen === '0006' ? 'confirmed_weak_name' : 'confirmed_exact_name'
  }

  const suffix = account.slice(-2)
  const match = SANDBOX_SCENARIOS.find((s) => s.bankAccountSuffix === suffix)
  return match?.scenario ?? 'confirmed_exact_name'
}

/**
 * The evidence the simulator "finds". Deliberately *not* a verdict — the policy
 * turns evidence into a decision.
 */
function simulatedEvidence(
  scenario: SandboxScenario,
  requested: string,
  method: VerificationMethod,
): NameMatchEvidence {
  const registryName =
    scenario === 'confirmed_exact_name'
      ? requested
      : scenario === 'confirmed_partial_name'
        ? `${requested.split(/\s+/)[0] ?? requested} ${requested.split(/\s+/).slice(-1)[0] ?? ''}`.trim()
        : scenario === 'confirmed_weak_name'
          ? 'RAJESH KUMAR'
          : null

  const score =
    scenario === 'confirmed_exact_name'
      ? 100
      : scenario === 'confirmed_partial_name'
        ? 84
        : scenario === 'confirmed_weak_name'
          ? 21
          : null

  const evidence: { asserted?: boolean; score?: number; registryName?: string } = {}
  // Each simulated method reports only what that method plausibly returns, so a
  // policy written for one cannot accidentally be satisfied by another's data.
  if (method === 'penny_drop' && registryName !== null) evidence.registryName = registryName
  if (method === 'provider_lookup' && score !== null) evidence.score = score
  if (method === 'manual') evidence.asserted = scenario.startsWith('confirmed_')
  return evidence
}

/**
 * Map a raw provider code onto the closed failure taxonomy. `INV-43`: an
 * unrecognised code becomes `unavailable`; it never throws and never invents a
 * new code.
 */
export function mapFailureCode(raw: string): VerificationFailureCode {
  const normalised = raw.trim().toLowerCase()
  return (VERIFICATION_FAILURE_CODES as readonly string[]).includes(normalised)
    ? (normalised as VerificationFailureCode)
    : 'unavailable'
}

export interface SandboxProviderOptions {
  readonly method?: VerificationMethod
  /** Override the provider id — used by the UPI adapter below. */
  readonly id?: string
  /** Which destination kinds this adapter accepts. Default: both. */
  readonly kinds?: readonly DestinationKind[]
}

/**
 * `verify` is pure with respect to its request: no clock, no randomness, no
 * network. Idempotency is therefore free.
 */
export function createSandboxVerificationProvider(
  options: SandboxProviderOptions = {},
): BeneficiaryVerificationProvider {
  const method = options.method ?? 'penny_drop'
  const id = options.id ?? SANDBOX_PROVIDER_ID
  const kinds = options.kinds ?? (['bank_account', 'upi'] as const)

  return {
    id,
    method,
    supports: (kind) => kinds.includes(kind),

    verify(request: VerificationRequest): Promise<VerificationOutcome> {
      return Promise.resolve(resolveScenario(request, method))
    },

    interpret(raw: unknown): VerificationCallback | null {
      if (typeof raw !== 'object' || raw === null) return null
      const r = raw as Record<string, unknown>
      if (
        typeof r['request_id'] !== 'string' ||
        typeof r['destination_version_id'] !== 'string' ||
        typeof r['event_id'] !== 'string' ||
        typeof r['result'] !== 'string'
      ) {
        return null
      }

      const nameEvidence: { asserted?: boolean; score?: number; registryName?: string } = {}
      if (typeof r['name_match_score'] === 'number') nameEvidence.score = r['name_match_score']
      if (typeof r['registry_name'] === 'string') nameEvidence.registryName = r['registry_name']
      if (typeof r['name_matched'] === 'boolean') nameEvidence.asserted = r['name_matched']

      const outcome: VerificationOutcome =
        r['result'] === 'account_confirmed' || r['result'] === 'verified'
          ? { status: 'account_confirmed', method, nameEvidence }
          : {
              status: 'failed',
              method,
              // An unknown code arrives here as a string we have never seen; it
              // is mapped, not rejected (INV-43).
              reasonCode: mapFailureCode(String(r['reason_code'] ?? '')),
              nameEvidence,
            }
      return {
        requestId: r['request_id'],
        destinationVersionId: r['destination_version_id'],
        providerEventId: r['event_id'],
        outcome,
      }
    },
  }
}

/**
 * A second simulator standing in for a UPI handle lookup.
 *
 * Separate from the bank adapter because it is a different method with a
 * different name-match policy — modelling both through one adapter would hide
 * exactly the difference `D-11` has to resolve.
 */
export function createSandboxVpaVerificationProvider(): BeneficiaryVerificationProvider {
  return createSandboxVerificationProvider({
    id: SANDBOX_UPI_PROVIDER_ID,
    method: 'provider_lookup',
    kinds: ['upi'],
  })
}

function resolveScenario(
  request: VerificationRequest,
  method: VerificationMethod,
): VerificationOutcome {
  // Shape validation the rail would do before looking anything up. A malformed
  // IFSC or VPA is a definite negative, not a lookup.
  if (request.kind === 'bank_account' && !IFSC_PATTERN.test(request.ifsc ?? '')) {
    return { status: 'failed', method, reasonCode: 'invalid_ifsc', nameEvidence: {} }
  }
  if (request.kind === 'upi' && !VPA_PATTERN.test(request.vpa ?? '')) {
    return { status: 'failed', method, reasonCode: 'vpa_not_found', nameEvidence: {} }
  }

  const scenario = scenarioFor(request)
  const nameEvidence = simulatedEvidence(scenario, request.beneficiaryName, method)

  switch (scenario) {
    case 'confirmed_exact_name':
    case 'confirmed_partial_name':
    case 'confirmed_no_name_returned':
    case 'confirmed_weak_name':
      // Note what this does *not* do: it does not decide whether the weak name
      // is acceptable. It reports the evidence and lets the policy rule.
      return { status: 'account_confirmed', method, nameEvidence }

    case 'pending_async':
      return {
        status: 'verifying',
        method,
        // Derived from the request, so a retry correlates to the same check.
        providerReference: `sbx_${request.requestId}`,
      }

    case 'unmapped_provider_code':
      return {
        status: 'failed',
        method,
        reasonCode: mapFailureCode('BANK_SAYS_NO_9271'),
        nameEvidence,
      }

    case 'failed_account_not_found':
      return { status: 'failed', method, reasonCode: 'account_not_found', nameEvidence }
    case 'failed_account_closed':
      return { status: 'failed', method, reasonCode: 'account_closed', nameEvidence }
    case 'failed_account_frozen':
      return { status: 'failed', method, reasonCode: 'account_frozen', nameEvidence }
    case 'failed_invalid_ifsc':
      return { status: 'failed', method, reasonCode: 'invalid_ifsc', nameEvidence }
    case 'failed_vpa_not_found':
      return { status: 'failed', method, reasonCode: 'vpa_not_found', nameEvidence }
    case 'failed_rejected_by_bank':
      return { status: 'failed', method, reasonCode: 'rejected_by_bank', nameEvidence }
  }
}

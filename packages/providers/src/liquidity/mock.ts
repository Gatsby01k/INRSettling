/**
 * `MockLiquidityProvider` — `ARCHITECTURE.md § 5.1`.
 *
 * *"`MockLiquidityProvider` and `MockIndiaPayoutProvider` are first-class code
 * with tests, not throwaway stubs."* And: *"Deterministic, not random.
 * Behaviour is selected by input, so every scenario is reproducible and every
 * test is stable."*
 *
 * Selection here is by a magic segment of the **reference** the caller supplies,
 * which is the liquidity analogue of the payout simulator's account-number
 * suffix. A random mock would make the `UNKNOWN` paths untestable in exactly the
 * way that matters: the interesting cases are the ones that happen rarely, and a
 * test that only sometimes exercises them is a test that will pass on the day
 * the bug ships.
 *
 * The scenarios below are chosen to cover every transition the frozen tables
 * name, including the ones nobody wants: a timeout whose money did move, and a
 * timeout whose money did not.
 */
import type {
  DrawdownAck,
  DrawdownCommand,
  DrawdownStatus,
  FacilitySnapshot,
  LiquidityProvider,
  ProviderQuery,
  RepaymentAck,
  RepaymentCommand,
  RepaymentStatus,
} from '@inrsettle/domain'
import { ProviderTimeout } from '@inrsettle/domain'
import type { CurrencyCode } from '@inrsettle/money'

/**
 * The scenario table. Selected by a suffix on the caller's reference, exactly
 * as the payout simulator selects on an account-number suffix.
 */
export const LIQUIDITY_SCENARIOS = {
  /** Happy path: the drawdown and any repayment confirm immediately. */
  '0000': 'confirm',
  /** The provider declines. A real answer, and the settlement fails cleanly. */
  '0001': 'reject',
  /**
   * The call times out and the money **did not** move. A later pull says
   * `not_found`, which is what lets `UNKNOWN` resolve in the safe direction.
   */
  '0002': 'timeout_not_performed',
  /**
   * The call times out and the money **did** move. This is the scenario that
   * justifies the whole `UNKNOWN` design: resubmitting here would draw down
   * twice, and only a pull can tell the two timeouts apart.
   */
  '0003': 'timeout_performed',
  /** Accepted but still in flight, so the SLA watcher has something to watch. */
  '0004': 'pending',
} as const

export type LiquidityScenario = (typeof LIQUIDITY_SCENARIOS)[keyof typeof LIQUIDITY_SCENARIOS]

export function liquidityScenarioFor(reference: string): LiquidityScenario {
  for (const [suffix, scenario] of Object.entries(LIQUIDITY_SCENARIOS)) {
    if (reference.endsWith(suffix)) return scenario
  }
  // The default is the happy path, so a test that does not care about provider
  // behaviour does not have to encode one.
  return 'confirm'
}

interface Submission {
  readonly kind: 'drawdown' | 'repayment'
  readonly scenario: LiquidityScenario
  readonly providerReference: string
}

export interface MockLiquidityProviderOptions {
  readonly id?: string
  readonly currency?: CurrencyCode
  readonly limitMinor?: bigint
}

/**
 * A liquidity provider that behaves the same way every time.
 *
 * It keeps a record of what it was asked to do, keyed by `requestFingerprint`,
 * because that is what a real provider's idempotency store does and it is what
 * makes `getDrawdown`/`getRepayment` answerable. A submission that "timed out"
 * but was performed is recorded; one that was not performed is not — and the
 * pull is the only thing that can tell the caller which happened.
 */
export function createMockLiquidityProvider(
  options: MockLiquidityProviderOptions = {},
): LiquidityProvider & { readonly submissions: ReadonlyMap<string, Submission> } {
  const id = options.id ?? 'mock_liquidity'
  const currency: CurrencyCode = options.currency ?? 'USDT'
  const limitMinor = options.limitMinor ?? 100_000_000_000n
  const submissions = new Map<string, Submission>()
  let drawnMinor = 0n
  let sequence = 0

  const nextReference = (prefix: string): string => {
    sequence += 1
    // Deterministic, so a snapshot test can assert on it.
    return `${prefix}_${String(sequence).padStart(6, '0')}`
  }

  function perform(
    kind: 'drawdown' | 'repayment',
    fingerprint: string,
    reference: string,
    amountMinor: bigint,
  ): { providerReference: string; scenario: LiquidityScenario } {
    // Idempotency, the way a provider actually implements it: the same key
    // returns the same answer rather than doing the thing again.
    const seen = submissions.get(fingerprint)
    if (seen) return { providerReference: seen.providerReference, scenario: seen.scenario }

    const scenario = liquidityScenarioFor(reference)
    const providerReference = nextReference(kind === 'drawdown' ? 'pdrw' : 'prpy')

    if (scenario === 'timeout_not_performed') {
      // Nothing is recorded, so a later pull answers `not_found`.
      throw new ProviderTimeout(fingerprint)
    }

    submissions.set(fingerprint, { kind, scenario, providerReference })
    if (scenario === 'confirm') {
      drawnMinor += kind === 'drawdown' ? amountMinor : -amountMinor
    }
    if (scenario === 'timeout_performed') {
      // Recorded *before* throwing, which is the whole point: the provider did
      // the work and the caller will never hear about it from this call.
      if (kind === 'drawdown') drawnMinor += amountMinor
      else drawnMinor -= amountMinor
      throw new ProviderTimeout(fingerprint)
    }
    return { providerReference, scenario }
  }

  /**
   * The settled outcome of a scenario, in the vocabulary both machines share.
   * `REQUESTED` here means "accepted, not yet terminal"; each caller maps it to
   * its own in-flight state, which for a repayment is `SUBMITTED`.
   */
  function statusOf(scenario: LiquidityScenario): 'CONFIRMED' | 'FAILED' | 'REQUESTED' {
    switch (scenario) {
      case 'confirm':
      case 'timeout_performed':
        return 'CONFIRMED'
      case 'reject':
        return 'FAILED'
      case 'pending':
      case 'timeout_not_performed':
        return 'REQUESTED'
    }
  }

  return {
    id,
    submissions,

    async getFacility(providerFacilityId: string): Promise<FacilitySnapshot> {
      return {
        providerFacilityId,
        status: 'ACTIVE',
        currency,
        limitMinor,
        drawnMinor,
        // Fixed rather than `new Date()`: a snapshot with a moving timestamp
        // makes every test that compares two snapshots flaky.
        asOf: new Date('2026-01-01T00:00:00.000Z'),
      }
    },

    async requestDrawdown(cmd: DrawdownCommand): Promise<DrawdownAck> {
      const { providerReference, scenario } = perform(
        'drawdown', cmd.requestFingerprint, cmd.reference, cmd.amountMinor,
      )
      const status = statusOf(scenario)
      return { providerReference, status: status === 'FAILED' ? 'FAILED' : status }
    },

    async getDrawdown(requestFingerprint: string): Promise<ProviderQuery<DrawdownStatus>> {
      const seen = submissions.get(requestFingerprint)
      if (!seen) return { ok: true, status: 'not_found' }
      return { ok: true, status: statusOf(seen.scenario), providerReference: seen.providerReference }
    },

    async submitRepayment(cmd: RepaymentCommand): Promise<RepaymentAck> {
      const { providerReference, scenario } = perform(
        'repayment', cmd.requestFingerprint, cmd.reference, cmd.amountMinor,
      )
      const status = statusOf(scenario)
      return {
        providerReference,
        status: status === 'REQUESTED' ? 'SUBMITTED' : status,
      }
    },

    async getRepayment(requestFingerprint: string): Promise<ProviderQuery<RepaymentStatus>> {
      const seen = submissions.get(requestFingerprint)
      if (!seen) return { ok: true, status: 'not_found' }
      const status = statusOf(seen.scenario)
      return {
        ok: true,
        status: status === 'REQUESTED' ? 'SUBMITTED' : status,
        providerReference: seen.providerReference,
      }
    },
  }
}

/**
 * `MockIndiaPayoutProvider` — `ARCHITECTURE.md § 5.1`.
 *
 * *"First-class code with tests, not throwaway stubs."* Deterministic:
 * behaviour is selected by the destination, never by chance, so every scenario
 * is reproducible and every test is stable.
 *
 * The simulator keeps an idempotency store keyed by the submission's
 * `idempotencyKey`, because that is what a real provider does and it is what
 * makes `getPayout` answerable. A submission that "timed out" but was performed
 * is recorded before the throw; one that was not performed is not recorded at
 * all — and the status pull is the only thing that can tell a caller which of
 * those happened. A simulator that could not represent both would make the
 * `UNKNOWN` paths untestable, which is to say untested.
 *
 * The clock is injected. `ARCHITECTURE.md § 5.1` requires *"a controllable
 * clock so return observation windows, expiries and SLA breaches can be
 * exercised in seconds"*, and an SLA test that really waited would either be
 * slow or be a lie about what it proved.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  PayoutAck,
  PayoutCapabilities,
  PayoutCommand,
  PayoutProvider,
  PayoutQuery,
  SignatureVerdict,
} from '@inrsettle/domain'
import { PayoutTimeout } from '@inrsettle/domain'
import { payoutScenarioFor, type PayoutBehaviour } from './scenarios.js'

/**
 * Rail capabilities the simulator declares.
 *
 * **These are sandbox fixture values, not Indian banking rules.** The RTGS
 * minimum is the one figure here with a real-world referent, and even that is
 * declared by the provider rather than asserted by us — `D-13` is open, and a
 * codebase that hard-codes a partner's limits has answered it by accident.
 */
export const SANDBOX_RAIL_CAPABILITIES: PayoutCapabilities['rails'] = [
  {
    rail: 'UPI',
    minMinor: 1n,
    maxMinor: 10_000_000n, // ₹1,00,000 — sandbox fixture
    destinationKinds: ['vpa'],
    open: true,
    terminalStatusSlaSeconds: 300,
  },
  {
    rail: 'IMPS',
    minMinor: 1n,
    maxMinor: 50_000_000n, // ₹5,00,000 — sandbox fixture
    destinationKinds: ['bank_account'],
    open: true,
    terminalStatusSlaSeconds: 900,
  },
  {
    rail: 'RTGS',
    minMinor: 20_000_000n, // ₹2,00,000 — the real RTGS floor
    maxMinor: null,
    destinationKinds: ['bank_account'],
    open: true,
    terminalStatusSlaSeconds: 3600,
  },
  {
    rail: 'NEFT',
    minMinor: 1n,
    maxMinor: null,
    destinationKinds: ['bank_account'],
    open: true,
    terminalStatusSlaSeconds: 7200,
  },
]

interface Submission {
  readonly idempotencyKey: string
  readonly providerReference: string
  readonly behaviour: PayoutBehaviour
  readonly amountMinor: bigint
  readonly submittedAt: Date
  /** Set once the simulated rail has produced a terminal answer. */
  terminal: 'CREDITED' | 'REJECTED' | null
  utr: string | null
  /**
   * What the rail actually credited, which is not always what was instructed.
   * `…0001` is the whole reason this is a separate field.
   */
  creditedMinor: bigint
  creditedAt: Date | null
  returnedMinor: bigint
  /** Every return the rail has reported, in arrival order. */
  returns: ReportedReturn[]
}

/**
 * One return notification as the rail issues it.
 *
 * Kept as a list rather than a running total because the individual
 * notifications are the facts and the total is an interpretation. `…0011`
 * needs three distinguishable arrivals, and `…0014` needs one whose *arrival
 * time* is the point — neither survives being summed into a counter.
 */
export interface ReportedReturn {
  readonly returnId: string
  readonly amountMinor: bigint
  readonly at: Date
  readonly rawCode: string
}

export interface MockPayoutOptions {
  readonly id?: string
  /** Shared secret for `verifySignature`. */
  readonly webhookSecret?: string
  /** Injected so SLA breaches can be exercised without waiting. */
  readonly now?: () => Date
  /** Timestamp tolerance, `SECURITY.md § 4.2`. Symmetric, in seconds. */
  readonly toleranceSeconds?: number
  readonly rails?: PayoutCapabilities['rails']
}

export interface MockIndiaPayoutProvider extends PayoutProvider {
  readonly submissions: ReadonlyMap<string, Submission>
  /** Sign a payload the way the simulated provider would, for webhook tests. */
  sign(payload: Record<string, unknown>, at?: Date): { raw: string; headers: Record<string, string> }
  /** Advance a pending submission to its terminal answer, as a rail would. */
  settlePending(idempotencyKey: string): void
  /**
   * Have the rail send some or all of a credit back — `P08`.
   *
   * Drives the scenario's declared `returns` by default, one notification per
   * call, so a test that wants the frozen table's shape does not have to
   * restate it. `amountMinor` and `at` override that for the cases where the
   * amount or the timing *is* the scenario: `…0011` needs a third return that
   * breaches the delivered total, and `…0014` needs one that arrives far too
   * late.
   *
   * The simulator reports; it does not judge. A return larger than the credit
   * is accepted here and reported faithfully, because refusing it would mean
   * the cap could never be tested — `INV-49` is a rule about what *we* do with
   * what a rail tells us, and a rail that could not misbehave would prove
   * nothing about it.
   */
  reportReturn(
    idempotencyKey: string,
    override?: { amountMinor?: bigint; at?: Date; rawCode?: string },
  ): ReportedReturn | null
  /** Every return the rail has reported for a submission, in arrival order. */
  reportedReturns(idempotencyKey: string): readonly ReportedReturn[]
}

export function createMockIndiaPayoutProvider(
  options: MockPayoutOptions = {},
): MockIndiaPayoutProvider {
  const id = options.id ?? 'mock_india_payout'
  const secret = options.webhookSecret ?? 'whsec_sandbox'
  const now = options.now ?? (() => new Date())
  const toleranceSeconds = options.toleranceSeconds ?? 300
  const rails = options.rails ?? SANDBOX_RAIL_CAPABILITIES
  const submissions = new Map<string, Submission>()
  let sequence = 0

  const nextReference = (): string => {
    sequence += 1
    return `pmt_${String(sequence).padStart(6, '0')}`
  }
  const utrFor = (n: number): string => `UTR${String(n).padStart(9, '0')}`

  function destinationKey(cmd: PayoutCommand): string {
    return cmd.destination.kind === 'vpa'
      ? (cmd.destination.vpa ?? '')
      : (cmd.destination.accountNumber ?? '')
  }

  function record(cmd: PayoutCommand, behaviour: PayoutBehaviour): Submission {
    sequence += 1
    const submission: Submission = {
      idempotencyKey: cmd.idempotencyKey,
      providerReference: nextReference(),
      behaviour,
      amountMinor: cmd.amountMinor,
      submittedAt: now(),
      terminal: null,
      utr: null,
      creditedMinor: 0n,
      creditedAt: null,
      returnedMinor: 0n,
      returns: [],
    }
    submissions.set(cmd.idempotencyKey, submission)
    return submission
  }

  function credit(submission: Submission): void {
    submission.terminal = 'CREDITED'
    sequence += 1
    submission.utr = utrFor(sequence)
    // The shortfall is applied here, once, so every path that credits — the
    // submit call, a later `settlePending`, a status pull — reports the same
    // figure. A shortfall that only appeared on one of them would be a bug in
    // the simulator masquerading as a reconciliation finding.
    const shortfall =
      submission.behaviour.kind === 'credit' ? (submission.behaviour.shortfallMinor ?? 0n) : 0n
    submission.creditedMinor = submission.amountMinor - shortfall
    submission.creditedAt = now()
  }

  const ackOf = (s: Submission): PayoutAck => ({
    providerReference: s.providerReference,
    status: 'CREDITED',
    utr: s.utr!,
    creditedMinor: s.creditedMinor,
  })

  return {
    id,
    submissions,

    async capabilities(): Promise<PayoutCapabilities> {
      return { providerId: id, currency: 'INR', rails }
    },

    async submitPayout(cmd: PayoutCommand): Promise<PayoutAck> {
      // Idempotency, the way a provider actually implements it: the same key
      // returns the same answer rather than paying a second time. This is the
      // property INV-25 exists to rely on, so the simulator must have it or the
      // tests prove nothing.
      const seen = submissions.get(cmd.idempotencyKey)
      if (seen) {
        return {
          providerReference: seen.providerReference,
          status: seen.terminal ?? 'ACCEPTED',
          ...(seen.utr ? { utr: seen.utr } : {}),
          ...(seen.terminal === 'CREDITED' ? { creditedMinor: seen.creditedMinor } : {}),
        }
      }

      const scenario = payoutScenarioFor(destinationKey(cmd))
      const behaviour = scenario.payoutBehaviour ?? { kind: 'credit' as const }

      if (behaviour.kind === 'timeout_not_created') {
        // Nothing recorded, so a later pull answers `not_found` and the caller
        // can safely conclude no payout exists.
        throw new PayoutTimeout(cmd.idempotencyKey)
      }

      const submission = record(cmd, behaviour)

      switch (behaviour.kind) {
        case 'credit':
        case 'credit_then_return':
          credit(submission)
          return ackOf(submission)
        case 'reject':
          submission.terminal = 'REJECTED'
          return {
            providerReference: submission.providerReference,
            status: 'REJECTED',
            rawCode: behaviour.rawCode,
          }
        case 'pending':
          return { providerReference: submission.providerReference, status: 'ACCEPTED' }
        case 'timeout_created':
          // Recorded *before* throwing, which is the whole point: the provider
          // did the work and the caller will never hear about it from this call.
          credit(submission)
          throw new PayoutTimeout(cmd.idempotencyKey)
      }
    },

    async getPayout(idempotencyKey: string): Promise<PayoutQuery> {
      const seen = submissions.get(idempotencyKey)
      if (!seen) return { ok: true, status: 'not_found' }

      if (seen.returnedMinor > 0n) {
        // The pull is a second channel carrying the same fact the webhook
        // carried, which is exactly what `…0012` is about: two arrivals of one
        // return. It reports the total the *rail* has counted; deduplicating
        // the two channels against each other is INV-50, and ours.
        return {
          ok: true,
          status: 'RETURNED',
          providerReference: seen.providerReference,
          ...(seen.utr ? { utr: seen.utr } : {}),
          creditedMinor: seen.creditedMinor,
          returnedMinor: seen.returnedMinor,
        }
      }
      if (seen.terminal === null) {
        return { ok: true, status: 'ACCEPTED', providerReference: seen.providerReference }
      }
      return {
        ok: true,
        status: seen.terminal,
        providerReference: seen.providerReference,
        ...(seen.utr ? { utr: seen.utr } : {}),
        ...(seen.terminal === 'CREDITED' ? { creditedMinor: seen.creditedMinor } : {}),
        ...(seen.behaviour.kind === 'reject' ? { rawCode: seen.behaviour.rawCode } : {}),
      }
    },

    verifySignature(raw: string, headers: Readonly<Record<string, string>>): SignatureVerdict {
      const header = headers['inrsettle-signature'] ?? headers['INRSettle-Signature'] ?? ''
      const parts = Object.fromEntries(
        header.split(',').map((p) => {
          const [k, v] = p.split('=')
          return [k?.trim() ?? '', v?.trim() ?? '']
        }),
      )
      const t = Number(parts['t'])
      const v1 = parts['v1'] ?? ''
      if (!Number.isFinite(t) || v1.length === 0) return { valid: false, reason: 'malformed' }

      // `SECURITY.md § 4.2`: reject any timestamp outside tolerance in **either**
      // direction. Stale is the common case and is what a replay looks like; a
      // check written as `t > now + tolerance` would catch only the rare one.
      const skewSeconds = (now().getTime() - t * 1000) / 1000
      if (skewSeconds > toleranceSeconds) return { valid: false, reason: 'stale_timestamp' }
      if (skewSeconds < -toleranceSeconds) return { valid: false, reason: 'future_timestamp' }

      const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest()
      let provided: Buffer
      try {
        provided = Buffer.from(v1, 'hex')
      } catch {
        return { valid: false, reason: 'malformed' }
      }
      // Constant-time, and length-checked first because `timingSafeEqual`
      // throws on a length mismatch rather than returning false.
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return { valid: false, reason: 'bad_signature' }
      }

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return { valid: false, reason: 'malformed' }
      }
      const providerEventId = String(payload['id'] ?? '')
      const eventType = String(payload['type'] ?? '')
      if (providerEventId.length === 0 || eventType.length === 0) {
        return { valid: false, reason: 'malformed' }
      }
      return { valid: true, providerEventId, eventType, payload }
    },

    sign(payload: Record<string, unknown>, at?: Date) {
      const raw = JSON.stringify(payload)
      const t = Math.floor((at ?? now()).getTime() / 1000)
      const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
      return { raw, headers: { 'inrsettle-signature': `t=${t},v1=${v1}` } }
    },

    settlePending(idempotencyKey: string): void {
      const seen = submissions.get(idempotencyKey)
      if (!seen || seen.terminal !== null) return
      credit(seen)
    },

    reportReturn(
      idempotencyKey: string,
      override: { amountMinor?: bigint; at?: Date; rawCode?: string } = {},
    ): ReportedReturn | null {
      const seen = submissions.get(idempotencyKey)
      // A rail cannot return money it never credited, and this is the one rule
      // the simulator does enforce, because it is a fact about the world rather
      // than a policy of ours. P08 runs from CREDITED and from nowhere else.
      if (!seen || seen.terminal !== 'CREDITED') return null

      const declared =
        seen.behaviour.kind === 'credit_then_return' ? (seen.behaviour.returns ?? []) : []
      const amountMinor =
        override.amountMinor ?? declared[seen.returns.length] ?? seen.creditedMinor

      sequence += 1
      const reported: ReportedReturn = {
        returnId: `ret_${String(sequence).padStart(6, '0')}`,
        amountMinor,
        at: override.at ?? now(),
        // A code the sandbox mapping table actually carries, so a return
        // travels the mapped path by default. A test that wants the *unmapped*
        // path asks for it, rather than getting it by a typo here.
        rawCode: override.rawCode ?? 'RETURNED_BY_BENEFICIARY_BANK',
      }
      seen.returns.push(reported)
      seen.returnedMinor += amountMinor
      return reported
    },

    reportedReturns(idempotencyKey: string): readonly ReportedReturn[] {
      return submissions.get(idempotencyKey)?.returns ?? []
    },
  }
}

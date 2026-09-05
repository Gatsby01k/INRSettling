/**
 * The frozen simulator scenario table — `ARCHITECTURE.md § 5.1`.
 *
 * Fifteen rows, `…0000` to `…0014`, selected by a magic suffix on the sandbox
 * beneficiary account number. This file is the table itself, reproduced as data
 * so it can be checked row-by-row against the document.
 *
 * **Every row is an executable test.** Stage 5's exit criterion is *"every
 * scenario in the simulator table is a passing, replayable test"*, and a third
 * of the rows describe reconciliation, returns and repayment — Stages 2, 4 and
 * 6. Declaring those as out of scope does not satisfy the criterion, so each
 * row runs, and what it runs depends on who owns it:
 *
 * - a row owned by **Stage 5** runs end to end here;
 * - a row owned by an **already-built stage** (2, 3, 4) runs that stage's real
 *   behaviour — those stages are closed, so exercising them is replay, not
 *   early implementation;
 * - a row owned by **Stage 6** runs the part Stage 5 owns — what the rail did,
 *   recorded on the payout attempt — and then asserts the **typed handoff**:
 *   what Stage 5 produced, who consumes it, what they must do with it, and
 *   under which invariants.
 *
 * The handoff is a structure rather than a sentence for the same reason the
 * `DeferredCompanion` on T30 is: a prose note is something a later reader has
 * to find and believe, and a typed field is something a test can assert and a
 * build can fail on.
 */

export const SCENARIO_SUFFIXES = [
  '0000', '0001', '0002', '0003', '0004', '0005', '0006', '0007',
  '0008', '0009', '0010', '0011', '0012', '0013', '0014',
] as const
export type ScenarioSuffix = (typeof SCENARIO_SUFFIXES)[number]

export type ScenarioStage = 'Stage 2' | 'Stage 3' | 'Stage 4' | 'Stage 5' | 'Stage 6'

/**
 * What Stage 5 hands to the stage that finishes a scenario.
 *
 * `produces` is a fact that exists *now* and that this row's test asserts now.
 * `obligation` is what the owning stage must do with it. Keeping both in one
 * structure is what makes a partial implementation honest: a reader can see
 * exactly where the line falls, and the test proves Stage 5's side of it is
 * really there rather than promised.
 */
export interface ScenarioHandoff {
  /** The fact Stage 5 records, asserted by this row's test. */
  readonly produces: string
  readonly consumedBy: ScenarioStage
  /** What the owning stage must do. Deliberately not done here. */
  readonly obligation: string
  /** The invariants that govern the obligation, so it stays findable. */
  readonly invariants: readonly string[]
}

export interface Scenario {
  readonly suffix: ScenarioSuffix
  /** The frozen document's own wording, so drift is visible. */
  readonly outcome: string
  /** Which stage owns finishing it. */
  readonly ownedBy: ScenarioStage
  /**
   * What the *payout provider* does. `null` where the scenario never reaches
   * this adapter — a verification name mismatch is not a payout event.
   */
  readonly payoutBehaviour: PayoutBehaviour | null
  /**
   * Required on every row Stage 5 does not own. A row owned elsewhere with no
   * handoff is a gap nobody has written down.
   */
  readonly handoff?: ScenarioHandoff
  readonly why?: string
}

/**
 * What the adapter does when it sees this suffix. Deliberately a small closed
 * set: a simulator with an open-ended behaviour space is a second
 * implementation of the provider, and it will disagree with the first one.
 */
export type PayoutBehaviour =
  /** Accepted, then credited. `shortfallMinor` credits *less* than instructed. */
  | { readonly kind: 'credit'; readonly shortfallMinor?: bigint }
  /** A trusted rejection carrying a provider code. */
  | { readonly kind: 'reject'; readonly rawCode: string }
  /** Accepted and left in flight, so the SLA sweeper has something to sweep. */
  | { readonly kind: 'pending' }
  /** The submit call does not answer, and the payout **was not** created. */
  | { readonly kind: 'timeout_not_created' }
  /** The submit call does not answer, and the payout **was** created. */
  | { readonly kind: 'timeout_created' }
  /** Credited, and the rail will later send some or all of it back. */
  | { readonly kind: 'credit_then_return'; readonly returns?: readonly bigint[] }

export const SCENARIOS: readonly Scenario[] = [
  {
    suffix: '0000',
    outcome: 'Happy path: accepted → credited with UTR → reconciles MATCHED',
    ownedBy: 'Stage 5',
    payoutBehaviour: { kind: 'credit' },
  },
  {
    suffix: '0001',
    outcome: 'Credited with a ₹5,000 shortfall → reconciliation MISMATCH',
    ownedBy: 'Stage 6',
    payoutBehaviour: { kind: 'credit', shortfallMinor: 500_000n },
    handoff: {
      produces:
        'a CREDITED attempt whose credited_minor is ₹5,000 below the instructed amount, recorded faithfully rather than rounded away',
      consumedBy: 'Stage 6',
      obligation:
        'compare credited_minor against the expected amount and open a MISMATCH reconciliation on a non-zero delta',
      invariants: ['INV-26'],
    },
  },
  {
    suffix: '0002',
    outcome: 'Rejected by beneficiary bank: account closed',
    ownedBy: 'Stage 5',
    payoutBehaviour: { kind: 'reject', rawCode: 'BENE_ACCOUNT_CLOSED' },
  },
  {
    suffix: '0003',
    outcome: 'No terminal status within SLA → UNKNOWN → exception',
    ownedBy: 'Stage 5',
    payoutBehaviour: { kind: 'pending' },
  },
  {
    suffix: '0004',
    outcome:
      'Credited and settled, then returned — opens a SettlementReturn, leaves the settlement SETTLED and its receipt hash unchanged',
    ownedBy: 'Stage 6',
    payoutBehaviour: { kind: 'credit_then_return' },
    handoff: {
      produces:
        'a payout attempt moved CREDITED → RETURNED (P08) with its UTR and credit timestamp intact',
      consumedBy: 'Stage 6',
      obligation:
        'open a SettlementReturn from the returned attempt, leaving the settlement SETTLED and its receipt bytes unchanged',
      invariants: ['INV-42', 'INV-48'],
    },
  },
  {
    suffix: '0005',
    outcome: 'Provider timeout on submit; status pull shows the payout *did* exist',
    ownedBy: 'Stage 5',
    payoutBehaviour: { kind: 'timeout_created' },
  },
  {
    suffix: '0006',
    outcome: 'Name mismatch at verification',
    ownedBy: 'Stage 2',
    payoutBehaviour: null,
    handoff: {
      produces: 'nothing at the payout layer — this scenario never reaches the payout adapter',
      consumedBy: 'Stage 2',
      obligation:
        'the sandbox verification provider returns a weak name match, and the versioned name-match policy decides the verdict',
      invariants: ['INV-45'],
    },
    why: 'Stage 2 is closed, so the row runs that stage’s real behaviour rather than a stand-in.',
  },
  {
    suffix: '0007',
    outcome:
      'Slow drawdown, so a cancellation request lands mid-flight and must be held to the next checkpoint',
    ownedBy: 'Stage 4',
    payoutBehaviour: null,
    handoff: {
      produces: 'nothing at the payout layer — the settlement never reaches dispatch',
      consumedBy: 'Stage 4',
      obligation:
        'T26 records the request without moving the machine; T27 honours it at the next checkpoint with the right compensation',
      invariants: ['INV-22', 'INV-35'],
    },
    why: 'Stage 4 is closed, so the row runs the real funding-leg behaviour.',
  },
  {
    suffix: '0008',
    outcome:
      'Cancellation requested microseconds after the dispatch commit — must be refused with past_point_of_no_return',
    ownedBy: 'Stage 3',
    payoutBehaviour: null,
    handoff: {
      produces: 'a stamped point_of_no_return_at and a durable attempt, both committed',
      consumedBy: 'Stage 3',
      obligation: 'refuse the cancellation with past_point_of_no_return',
      invariants: ['INV-36'],
    },
    why: 'Stage 3 is closed, so the row runs the real contention behaviour.',
  },
  {
    suffix: '0009',
    outcome:
      'Provider returns an error code, a return reason and an event type that no mapping table has ever seen — must ingest, persist, route to a non-customer-actionable default, alarm, and keep the queue draining (INV-43)',
    ownedBy: 'Stage 5',
    payoutBehaviour: { kind: 'reject', rawCode: 'XX_NOVEL_CODE_NOBODY_HAS_SEEN' },
  },
  {
    suffix: '0010',
    outcome:
      'Dispatch commits, then the outbound call fails; the status pull later shows the payout was created — must resolve without a second dispatch',
    ownedBy: 'Stage 5',
    payoutBehaviour: { kind: 'timeout_created' },
  },
  {
    suffix: '0011',
    outcome:
      'Two partial returns totalling exactly the delivered amount, then a third — the third must breach the cap and go to MANUAL_REVIEW (INV-49)',
    ownedBy: 'Stage 6',
    payoutBehaviour: {
      kind: 'credit_then_return',
      returns: [200_000_000n, 300_000_000n, 100_000_000n],
    },
    handoff: {
      produces:
        'three rail-level return notifications against one credited attempt, the third taking the cumulative total past the delivered amount',
      consumedBy: 'Stage 6',
      obligation:
        'cap cumulative confirmed returns at the delivered amount under a row lock, and route the breaching one to MANUAL_REVIEW',
      invariants: ['INV-49'],
    },
  },
  {
    suffix: '0012',
    outcome:
      'The same return delivered twice, once by webhook and once by status pull — must produce exactly one SettlementReturn (INV-50)',
    ownedBy: 'Stage 6',
    payoutBehaviour: { kind: 'credit_then_return' },
    handoff: {
      produces:
        'one stored provider event for the webhook delivery (INV-33 dedupe) plus a status pull reporting the same return — two arrivals of one fact, both visible',
      consumedBy: 'Stage 6',
      obligation:
        'deduplicate on the second key, the return itself, so exactly one SettlementReturn exists however many channels report it',
      invariants: ['INV-50'],
    },
  },
  {
    suffix: '0013',
    outcome:
      'Repayment submitted, no terminal status within SLA, then the pull shows it confirmed — availability must move only at that point (INV-46, INV-47)',
    ownedBy: 'Stage 4',
    payoutBehaviour: null,
    handoff: {
      produces: 'nothing at the payout layer — this is a liquidity-provider scenario',
      consumedBy: 'Stage 4',
      obligation:
        'a repayment reaching UNKNOWN restores no capacity; only a pull-resolved confirmation moves drawn',
      invariants: ['INV-46', 'INV-47'],
    },
    why: 'Stage 4 is closed, so the row runs the real repayment behaviour.',
  },
  {
    suffix: '0014',
    outcome:
      "Return arriving outside the rail's return_observation_window — must open in MANUAL_REVIEW, not on the normal path",
    ownedBy: 'Stage 6',
    payoutBehaviour: { kind: 'credit_then_return' },
    handoff: {
      produces:
        'a rail-level return carrying its own arrival time, far enough after the credit that any window would have closed',
      consumedBy: 'Stage 6',
      obligation:
        'route a return arriving outside the rail return_observation_window straight to MANUAL_REVIEW rather than the normal OBSERVED → CONFIRMED path',
      invariants: ['INV-40'],
    },
    why: 'D-04 is open on the window duration; the routing rule is Stage 6’s.',
  },
]

export function payoutScenarioFor(accountNumberOrVpa: string): Scenario {
  for (const scenario of SCENARIOS) {
    if (accountNumberOrVpa.endsWith(scenario.suffix)) return scenario
  }
  // The default is the happy path, so a test that does not care about provider
  // behaviour does not have to encode one.
  return SCENARIOS[0]!
}

/** The scenarios a given stage owns finishing. */
export function scenariosOwnedBy(stage: ScenarioStage): readonly Scenario[] {
  return SCENARIOS.filter((s) => s.ownedBy === stage)
}

/**
 * Every handoff owed to a stage, enumerable rather than remembered.
 *
 * Stage 6 does not have to read this file to find out what is waiting for it;
 * it can ask, and get back what exists now and what it must do with it.
 */
export function handoffsTo(
  stage: ScenarioStage,
): readonly { suffix: ScenarioSuffix; handoff: ScenarioHandoff }[] {
  return SCENARIOS.filter((s) => s.handoff?.consumedBy === stage).map((s) => ({
    suffix: s.suffix,
    handoff: s.handoff!,
  }))
}

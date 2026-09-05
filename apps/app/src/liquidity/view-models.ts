/**
 * View models for the Stage 4 liquidity surface.
 *
 * The customer never sees a facility. They see **Available to settle** — one
 * figure, shown only when a facility is actually enabled — and, on an affected
 * settlement, one line explaining that liquidity returns once a repayment
 * confirms. That is the whole customer-facing surface of this stage.
 *
 * `PRODUCT.md § 12` forbids the words this feature would most naturally reach
 * for: balance, wallet, credit, limit remaining. They are forbidden because
 * each one implies a product INRSettle is not — a place the customer's money
 * sits, or money INRSettle has lent them. Neither is true: a facility is
 * INRSettle's arrangement with a liquidity provider, and what the customer has
 * is a capacity to settle. `check-liquidity-copy.mjs` fails the build over it,
 * because a vocabulary rule nobody checks is a vocabulary rule nobody follows.
 */
import type { Money } from '@inrsettle/money'
import { formatMoney } from '@inrsettle/money'

export interface AvailabilityInput {
  /**
   * Null when the workspace has no enabled facility. Deliberately not `0` —
   * "you can settle nothing" and "we have not set this up yet" are different
   * things to tell someone, and a zero would say the wrong one during
   * onboarding.
   */
  readonly availableToSettle: Money | null
  /**
   * Value on its way back to the facility from a cancellation after funding or
   * a confirmed return. Not shown as a metric (`PRODUCT.md` Revision 5 removed
   * that); carried here only so an affected settlement can explain itself.
   */
  readonly returningToFacility?: Money | null
}

export interface AvailabilityPresentation {
  /** False during onboarding, before a facility exists. */
  readonly shown: boolean
  readonly label: 'Available to settle'
  readonly amount: string | null
  /** Shown when there is no facility yet, in place of a figure. */
  readonly setupNote: string | null
}

export function presentAvailability(input: AvailabilityInput): AvailabilityPresentation {
  if (input.availableToSettle === null) {
    return {
      shown: false,
      label: 'Available to settle',
      amount: null,
      // Says what is true and what happens next, without naming the mechanism.
      setupNote: 'You can settle once your account is set up for it.',
    }
  }
  return {
    shown: true,
    label: 'Available to settle',
    // International grouping: a facility is denominated in the funding
    // currency, which is not INR, so Indian grouping would be the wrong
    // convention for the number being shown.
    amount: formatMoney(input.availableToSettle, { format: 'international' }),
    setupNote: null,
  }
}

/**
 * The one line an affected settlement carries after a cancellation that came
 * too late to stop the funding, or after a confirmed return.
 *
 * `INV-46` is the reason this sentence exists at all: the capacity is genuinely
 * not back yet, so telling the customer it is would be showing them a figure
 * they cannot spend. The sentence explains a reduced *Available to settle*
 * where the customer will look for the explanation — on the settlement — rather
 * than as a fifth number on Overview.
 */
export function returningLiquidityNote(): string {
  return 'The amount reserved for this settlement becomes available again once the funds are confirmed back with us.'
}

/**
 * Whether a workspace may authorize a live settlement — `D-10`, closed.
 *
 * Preflight raises this as a blocking requirement rather than letting the
 * settlement fail at execution, so the customer finds out while they can still
 * do something about it.
 */
export function liquidityRequirementCopy(): {
  code: string
  title: string
  detail: string
  action: string
} {
  return {
    code: 'liquidity_facility_required',
    title: 'Your account is not set up to settle yet',
    detail:
      'Live settlements need your account to be enabled for settling. Sandbox settlements work without it, so you can keep building and testing.',
    action: 'Talk to us about going live',
  }
}

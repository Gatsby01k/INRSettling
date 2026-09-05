/**
 * Terminal resolution — `D-03`, closed for V1.
 *
 * **The decision.** `FAILED` and `CANCELLED` both project to the customer-facing
 * state `CANCELLED`, and the difference between them is carried by a precise
 * *resolution reason* rather than by a separate customer state. There is no
 * `NOT_COMPLETED`, and there is no sixth customer-facing settlement state.
 *
 * Why this is the right shape rather than a compromise. The five customer states
 * answer "what is happening to my money". `FAILED` and `CANCELLED` have the same
 * answer to that question — nothing was delivered, and your liquidity is
 * released — so they are the same state. What genuinely differs is *why*, and a
 * reason line says that far better than a state name: "Cancelled" plus "the bank
 * declined the transfer" is information; a state called `NOT_COMPLETED` next to
 * a state called `CANCELLED` is a puzzle the customer has to solve.
 *
 * `API_CONTRACT.md § 7.4` already carries this shape — `resolution: { code,
 * message }` — so closing `D-03` this way changes no wire contract.
 */
import type { SettlementStatus } from './status.js'

export const RESOLUTION_CODES = [
  'cancelled_by_customer',
  'cancelled_before_authorization',
  'cancellation_honoured',
  'destination_rejected',
  'compliance_rejected',
  'provider_rejected',
  'funding_failed',
  'expired_unfunded',
  'operator_failed',
] as const

export type ResolutionCode = (typeof RESOLUTION_CODES)[number]

export interface ResolutionDefinition {
  readonly code: ResolutionCode
  /** Which terminal status this reason belongs to. */
  readonly terminal: Extract<SettlementStatus, 'FAILED' | 'CANCELLED'>
  /**
   * One sentence, customer-facing. Every one of them says what happened to the
   * money, because that is the only question a terminal settlement raises.
   */
  readonly message: string
}

export const RESOLUTIONS: readonly ResolutionDefinition[] = [
  {
    code: 'cancelled_by_customer',
    terminal: 'CANCELLED',
    message: 'You cancelled this settlement. No funds were sent.',
  },
  {
    code: 'cancelled_before_authorization',
    terminal: 'CANCELLED',
    message: 'This settlement was cancelled before it was authorized. No funds were sent.',
  },
  {
    code: 'cancellation_honoured',
    terminal: 'CANCELLED',
    message:
      'We stopped this settlement at the last safe point after you asked us to. No funds were sent and your facility was released.',
  },
  {
    code: 'destination_rejected',
    terminal: 'FAILED',
    message:
      'The bank could not accept the payout details, so this settlement was not completed. No funds were sent.',
  },
  {
    code: 'compliance_rejected',
    terminal: 'FAILED',
    message:
      'This settlement could not be completed because the required documentation was not accepted. No funds were sent.',
  },
  {
    code: 'provider_rejected',
    terminal: 'FAILED',
    message:
      'Our payout partner declined this transfer and we could not complete it. No funds were sent.',
  },
  {
    code: 'funding_failed',
    terminal: 'FAILED',
    message: 'We could not fund this settlement, so it was not completed. No funds were sent.',
  },
  {
    code: 'expired_unfunded',
    terminal: 'FAILED',
    message: 'This settlement expired before it could be funded. No funds were sent.',
  },
  {
    code: 'operator_failed',
    terminal: 'FAILED',
    message: 'We were not able to complete this settlement. No funds were sent.',
  },
]

export function isResolutionCode(value: string): value is ResolutionCode {
  return (RESOLUTION_CODES as readonly string[]).includes(value)
}

export function resolutionDefinition(code: ResolutionCode): ResolutionDefinition {
  const found = RESOLUTIONS.find((r) => r.code === code)
  // Unreachable while the type holds. Thrown rather than defaulted: a default
  // here would be a settlement told it ended for a reason nobody chose.
  if (!found) throw new Error(`resolution code ${code} is not in the closed set`)
  return found
}

/** Which terminal status a reason belongs to, so the two cannot be mismatched. */
export function resolutionMatchesTerminal(
  code: ResolutionCode,
  terminal: 'FAILED' | 'CANCELLED',
): boolean {
  return resolutionDefinition(code).terminal === terminal
}

/**
 * Overview — `PRODUCT.md § 12.1`.
 *
 * *"Overview answers four questions and nothing else."* This file is where that
 * sentence is enforced rather than merely quoted: the presentation type has
 * exactly four metric slots, named, in order, and there is no array to push a
 * fifth into. A future metric is a type change and a conversation, which is the
 * point — Revision 5 of the frozen document exists because a fifth one was
 * proposed once already.
 *
 * The four questions, and the metric that answers each:
 *
 * | Question | Metric |
 * |---|---|
 * | How much can I settle now? | **Available to settle** — only when a facility is enabled |
 * | What is moving? | **In flight** |
 * | What is settled? | **Settled today** |
 * | What needs my attention? | **Needs attention** |
 *
 * And what is deliberately absent: *"No decorative charts. No vanity metrics.
 * No 'welcome back' hero."* There is no `chartData`, no comparison against
 * yesterday, and no greeting, because none of them is a field here to fill.
 */
import type { Money } from '@inrsettle/money'
import { formatMoney } from '@inrsettle/money'
import type { CustomerStatus } from '@inrsettle/domain/browser'
import type { SettlementRow } from '../settlements/view-models.js'

/** One metric, as `MetricTile` consumes it. */
export interface MetricView {
  readonly label: string
  /**
   * `Money` and counts stay in their own types all the way to the tile.
   *
   * `null` means *"this workspace has no such figure"* — the onboarding case in
   * § 12.1, where a workspace exists before a facility does. It is not zero,
   * and the difference matters: zero says *you can settle nothing*, absent says
   * *we have not set this up for you yet*, and only one of those is alarming
   * to read on your first morning.
   */
  readonly value: Money | number | null
  /** One line. § 5: *"Label, value, and one line of context."* */
  readonly context: string
  /** Present only where acting on the number is the point. */
  readonly action?: { readonly label: string; readonly href: string }
}

export interface OverviewInput {
  /**
   * Null when no liquidity facility is enabled for the workspace.
   *
   * § 12.1: *"shown only when a liquidity facility is actually enabled"*, and
   * separately: a workspace *"cannot authorize a live settlement until a
   * facility is active, and preflight says so in those words rather than
   * letting it fail at execution"*. So Overview's job here is only to be honest
   * about the figure; the blocking message is preflight's, on the screen where
   * someone is actually trying to settle.
   */
  readonly availableToSettle: Money | null
  /** Settlements the customer currently sees as moving. */
  readonly inFlightCount: number
  /** Settled today, in INR, by the workspace's own day boundary. */
  readonly settledToday: Money
  readonly settledTodayCount: number
  /** Settlements showing an actionable requirement right now. */
  readonly needsAttentionCount: number
  /**
   * Active settlements, already presented. Overview lists them; it does not
   * project them a second time (`INV-18` — one projection, in the domain).
   */
  readonly activeSettlements: readonly SettlementRow[]
  /** Settlements whose exception the customer can act on. */
  readonly openExceptions: readonly SettlementRow[]
}

export interface OverviewPresentation {
  /**
   * Four named slots, not a list.
   *
   * A `readonly MetricView[]` would make a fifth metric a one-line change that
   * no reviewer would question. Naming them makes adding one a decision.
   * `availableToSettle` is nullable because the *tile* is absent during
   * onboarding — distinct from a present tile whose *value* is null.
   */
  readonly metrics: {
    readonly availableToSettle: MetricView | null
    readonly inFlight: MetricView
    readonly settledToday: MetricView
    readonly needsAttention: MetricView
  }
  readonly activeSettlements: readonly SettlementRow[]
  readonly openExceptions: readonly SettlementRow[]
  /**
   * Shown in place of the whole body when a new workspace has nothing at all.
   * Not a hero: one sentence and the one action that makes it untrue.
   */
  readonly emptyMessage: string | null
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export function presentOverview(input: OverviewInput): OverviewPresentation {
  const {
    availableToSettle, inFlightCount, settledToday, settledTodayCount,
    needsAttentionCount, activeSettlements, openExceptions,
  } = input

  const nothingAtAll =
    activeSettlements.length === 0 &&
    openExceptions.length === 0 &&
    settledTodayCount === 0 &&
    inFlightCount === 0

  return {
    metrics: {
      // Absent, not zero, and absent as a *tile* — § 12.1 says shown only when
      // a facility is actually enabled, which is a different instruction from
      // "show it holding no value".
      availableToSettle:
        availableToSettle === null
          ? null
          : {
              label: 'Available to settle',
              value: availableToSettle,
              context: 'You can settle up to this much right now.',
            },

      inFlight: {
        label: 'In flight',
        value: inFlightCount,
        context:
          inFlightCount === 0
            ? 'Nothing is moving right now.'
            : `${plural(inFlightCount, 'Settlement is', 'Settlements are')} on the way. ` +
              'Nothing is needed from you.',
      },

      settledToday: {
        label: 'Settled today',
        value: settledToday,
        context:
          settledTodayCount === 0
            ? 'Nothing settled yet today.'
            : `Across ${settledTodayCount} ${plural(settledTodayCount, 'settlement', 'settlements')}.`,
      },

      needsAttention: {
        label: 'Needs attention',
        value: needsAttentionCount,
        context:
          needsAttentionCount === 0
            ? 'Nothing needs you.'
            : `${needsAttentionCount} ${plural(needsAttentionCount, 'settlement is', 'settlements are')} waiting on you.`,
        // § 5: no delta chip unless the delta is actionable. This is the one
        // metric where there is something to do, so it is the one with an
        // action — and the action is a destination, not a percentage.
        ...(needsAttentionCount > 0
          ? { action: { label: 'Review', href: '/settlements?filter=action_required' } }
          : {}),
      },
    },
    activeSettlements,
    openExceptions,
    emptyMessage: nothingAtAll
      ? 'Nothing has moved yet. Your first settlement will appear here.'
      : null,
  }
}

/**
 * Which customer states count as *in flight*.
 *
 * Derived from `CustomerStatus`, never from the internal machine: a settlement
 * is in flight when the customer would say it is moving, which is exactly
 * `SETTLING`. `ACTION_REQUIRED` is not in flight — it is stopped, waiting on
 * them — and counting it in both places would make the two metrics overlap and
 * the page add up to more than the truth.
 */
export function isInFlight(status: CustomerStatus): boolean {
  return status === 'SETTLING'
}

/** Which customer state is the one that needs the customer. */
export function needsAttention(status: CustomerStatus): boolean {
  return status === 'ACTION_REQUIRED'
}

/**
 * The metrics as a list, for rendering only.
 *
 * Filters out the absent facility tile. Deliberately not the shape the
 * presentation is stored in — see `OverviewPresentation.metrics`.
 */
export function metricList(p: OverviewPresentation): readonly MetricView[] {
  const { availableToSettle, inFlight, settledToday, needsAttention: attention } = p.metrics
  return availableToSettle === null
    ? [inFlight, settledToday, attention]
    : [availableToSettle, inFlight, settledToday, attention]
}

/** Accessible summary of the four figures, for a screen-reader landmark. */
export function metricsSummary(p: OverviewPresentation): string {
  return metricList(p)
    .map((m) => `${m.label}: ${typeof m.value === 'number' ? m.value : formatMoney(m.value!)}`)
    .join('. ')
}

import type { Meta, StoryObj } from '@storybook/react'
import { SettlementDetail } from './surfaces.js'
import {
  ACTION_REQUIRED,
  CANCELLATION_REQUESTED,
  CANCELLED,
  DELAYED,
  DETAIL_BASE,
  FAILED,
  READY,
  RETURN_CONFIRMED,
  RETURN_REPAID,
  SETTLED_DESIGN_ONLY,
  SETTLING,
  SETTLING_PAST_PONR,
  TIMELINE,
} from './fixtures.js'

const noop = (): void => {}

/**
 * Settlement detail — `PRODUCT.md § 12.3`.
 *
 * Its own title, which it did not have until Stage 10: these stories lived in
 * the New Settlement file and therefore published under *that* screen's name.
 * Two screens sharing one Storybook title is not cosmetic — it makes the Stage
 * 10 exit criterion *"loading, empty, error and disabled states exist everywhere
 * and are reviewed"* unreviewable, because there is no way to look at one
 * screen's states without the other's mixed in.
 */
const meta: Meta<typeof SettlementDetail> = {
  title: 'Surfaces/Settlement detail',
  component: SettlementDetail,
  args: {
    ...DETAIL_BASE,
    presentation: SETTLED_DESIGN_ONLY,
    internalStatus: 'SETTLED',
  },
}
export default meta

export const DetailReady: StoryObj<typeof SettlementDetail> = {
  name: 'Ready',
  render: () => (
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={READY}
      internalStatus="QUOTED"
      onCancel={noop}
    />
  ),
}

export const DetailSettling: StoryObj<typeof SettlementDetail> = {
  name: 'Settling, cancellable',
  render: () => (
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={SETTLING}
      internalStatus="AUTHORIZED"
      authorizedAt={new Date('2026-09-02T09:45:00Z')}
      authorizedTermsHash="4f8d2c1b9e7a06534f8d2c1b9e7a06534f8d2c1b9e7a06534f8d2c1b9e7a0653"
      destinationVersionId="dvr_9Kd2ZxKp0Wq4"
      onRequestCancellation={noop}
    />
  ),
}

export const DetailCancellationRequested: StoryObj<typeof SettlementDetail> = {
  name: 'Cancellation requested',
  render: () => (
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={CANCELLATION_REQUESTED}
      internalStatus="DRAWDOWN_CONFIRMED"
      authorizedAt={new Date('2026-09-02T09:45:00Z')}
      onRequestCancellation={noop}
    />
  ),
}

export const DetailPastPointOfNoReturn: StoryObj<typeof SettlementDetail> = {
  name: 'Past the point of no return',
  render: () => (
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={SETTLING_PAST_PONR}
      internalStatus="PAYOUT_SUBMITTED"
      authorizedAt={new Date('2026-09-02T09:45:00Z')}
      onRequestCancellation={noop}
    />
  ),
}

export const DetailDelayed: StoryObj<typeof SettlementDetail> = {
  name: 'Delayed, nothing for the customer to do',
  render: () => (
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={DELAYED}
      internalStatus="EXCEPTION"
      authorizedAt={new Date('2026-09-02T09:45:00Z')}
    />
  ),
}

export const DetailActionRequired: StoryObj<typeof SettlementDetail> = {
  name: 'Action required',
  render: () => (
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={ACTION_REQUIRED}
      internalStatus="EXCEPTION"
      authorizedAt={new Date('2026-09-02T09:45:00Z')}
      onRequirementAction={noop}
    />
  ),
}

export const DetailCancelled: StoryObj<typeof SettlementDetail> = {
  name: 'Cancelled',
  render: () => (
    <SettlementDetail {...DETAIL_BASE} presentation={CANCELLED} internalStatus="CANCELLED" />
  ),
}

export const DetailFailed: StoryObj<typeof SettlementDetail> = {
  name: 'Not completed',
  render: () => <SettlementDetail {...DETAIL_BASE} presentation={FAILED} internalStatus="FAILED" />,
}

export const DetailSettledDesignOnly: StoryObj<typeof SettlementDetail> = {
  name: 'Settled (design only, unreachable in Stage 3)',
  render: () => (
    <SettlementDetail
      {...DETAIL_BASE}
      presentation={SETTLED_DESIGN_ONLY}
      internalStatus="SETTLED"
      authorizedAt={new Date('2026-09-02T09:45:00Z')}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Stage 3 has no payout execution and no finality, so nothing in the running product can reach SETTLED. This story exists so the finished state can be designed and tested now rather than discovered in Stage 6.',
      },
    },
  },
}

export const DetailLoading: StoryObj<typeof SettlementDetail> = {
  name: 'Loading',
  render: () => (
    <SettlementDetail {...DETAIL_BASE} presentation={READY} internalStatus="QUOTED" loading />
  ),
}

/* ── Stage 10 — the § 12.3 states that had no screen ─────────────────────── */

export const DetailWithTimeline: StoryObj<typeof SettlementDetail> = {
  name: 'Technical detail, in plain language',
  args: {
    ...DETAIL_BASE,
    presentation: SETTLED_DESIGN_ONLY,
    internalStatus: 'SETTLED',
    authorizedAt: new Date('2026-09-02T08:32:00Z'),
    timeline: TIMELINE,
  },
  parameters: {
    docs: {
      description: {
        story:
          '`PRODUCT.md § 12.3` prints this list verbatim, and every line of it is a sentence about the customer\u2019s ' +
          'money rather than a state name. Expand *Technical details* to read it. The mapping is deliberately ' +
          'partial: a transition with no plain words produces no row, because silence beats jargon and a timeline ' +
          'is not an audit log.',
      },
    },
  },
}

export const DetailReturned: StoryObj<typeof SettlementDetail> = {
  name: 'Settled, then returned',
  args: {
    ...DETAIL_BASE,
    presentation: SETTLED_DESIGN_ONLY,
    internalStatus: 'SETTLED',
    authorizedAt: new Date('2026-09-02T08:32:00Z'),
    timeline: TIMELINE,
    returnNotice: RETURN_CONFIRMED,
  },
  parameters: {
    docs: {
      description: {
        story:
          '\u00a7 12.3: the return notice *"is the first thing read on that page, and the settlement still reads ' +
          'SETTLED beside it, because both facts are true"*. `STATE_MACHINES.md \u00a7 8.5` records the resulting ' +
          'tension as accepted deliberately \u2014 mutating a final record *"destroys the distinction between never ' +
          'delivered and delivered then returned, and those have different consequences for the customer\u2019s own ' +
          'books"*. Stage 6 built this view model; no screen rendered it until Stage 10.',
      },
    },
  },
}

export const DetailReturnResolved: StoryObj<typeof SettlementDetail> = {
  name: 'Returned, funds back',
  args: {
    ...DETAIL_BASE,
    presentation: SETTLED_DESIGN_ONLY,
    internalStatus: 'SETTLED',
    authorizedAt: new Date('2026-09-02T08:32:00Z'),
    timeline: TIMELINE,
    returnNotice: RETURN_REPAID,
  },
  parameters: {
    docs: {
      description: {
        story:
          'A resolved return is still shown \u2014 it is part of what happened to this payment \u2014 but it is a status ' +
          'rather than an alert, and it stops being red.',
      },
    },
  },
}

import type { Meta, StoryObj } from '@storybook/react'
import { Overview } from './surfaces.js'
import { BUSY_VIEW, ONBOARDING_VIEW, QUIET_VIEW } from './fixtures.js'

const noop = (): void => {}

const meta: Meta<typeof Overview> = {
  title: 'Surfaces/Overview',
  component: Overview,
  args: {
    presentation: BUSY_VIEW,
    onOpenSettlement: noop,
    onNewSettlement: noop,
    onNavigate: noop,
  },
  parameters: {
    docs: {
      description: {
        component:
          '`PRODUCT.md § 12.1`. Four questions and nothing else: how much can I settle now, what is moving, ' +
          'what is settled, what needs my attention. No charts, no vanity metrics, no "welcome back" hero, ' +
          'and no fifth number — Revision 5 of the frozen document removed one that had been proposed.',
      },
    },
  },
}
export default meta
type S = StoryObj<typeof Overview>

export const Default: S = {
  name: 'A working day',
}

export const Loading: S = {
  args: { loading: true },
  parameters: {
    docs: {
      description: {
        story: 'Skeletons at the final dimensions. No figure shows a number it does not have yet.',
      },
    },
  },
}

export const Empty: S = {
  name: 'Day one — nothing set up yet',
  args: { presentation: ONBOARDING_VIEW },
  parameters: {
    docs: {
      description: {
        story:
          '§ 12.1 allows a workspace to exist before it is set up to settle, and shows **Available to settle** ' + // liquidity-copy:allow — quoting § 12.1
          'only once it is. The tile is absent rather than zero, and the blocking explanation belongs to ' +
          'preflight, on the screen where someone is actually trying to settle.',
      },
    },
  },
}

export const Error: S = {
  name: 'One figure could not be loaded',
  args: { errors: { 'Available to settle': 'Could not load. Retrying.' } },
  parameters: {
    docs: {
      description: {
        story:
          'Per-metric, not per-page. An Overview whose headroom figure timed out should still say what is in ' +
          'flight; replacing the whole screen with one error is how a page becomes less useful than no page.',
      },
    },
  },
}

export const Disabled: S = {
  parameters: {
    docs: {
      description: {
        story: 'Not applicable: Overview reports. Its one control is New settlement, which carries its own disabled state.',
      },
    },
  },
}

export const Quiet: S = {
  name: 'Set up to settle, but a quiet day',
  args: { presentation: QUIET_VIEW },
  parameters: {
    docs: {
      description: {
        story: 'Nothing moving reads as calm rather than as broken. No red, no empty-state alarm on the metrics.',
      },
    },
  },
}

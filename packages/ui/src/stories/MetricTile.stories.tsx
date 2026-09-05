import type { Meta, StoryObj } from '@storybook/react'
import { money } from '@inrsettle/money'
import { MetricTile } from '../components/overview.js'

const meta: Meta<typeof MetricTile> = {
  title: 'Primitives/MetricTile',
  component: MetricTile,
  args: {
    label: 'In flight',
    value: 3,
    context: 'Settling now. Nothing is needed from you.',
  },
}
export default meta
type S = StoryObj<typeof MetricTile>

export const Default: S = {
  args: {
    label: 'Settled today',
    value: money('INR', 1250000000n),
    context: 'Across 4 settlements.',
  },
}

export const Loading: S = {
  args: { loading: true },
  parameters: {
    docs: {
      description: {
        story:
          'A skeleton at the figure’s final height, so the tile does not resize when the number arrives (§ 10).',
      },
    },
  },
}

export const Empty: S = {
  args: {
    label: 'Available to settle',
    value: null,
    context: 'You can settle once your account is set up for it.',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Empty is “no such figure”, not zero. `PRODUCT.md § 12.1` shows **Available to settle** only where the ' + // liquidity-copy:allow — prose about the rule
          'workspace is set up to settle; rendering it as ₹0 would tell a customer they have no headroom when the ' +
          'truth is that the question does not apply to them yet. The copy never names the arrangement behind it.',
      },
    },
  },
}

export const Error: S = {
  args: {
    label: 'Available to settle',
    value: null,
    error: 'Could not load. Retrying.',
    context: 'Your settlements are unaffected.',
  },
  parameters: {
    docs: {
      description: {
        story:
          'A figure that failed to load says so. It never falls back to a stale or zero number, because a wrong headroom figure is worse than none.',
      },
    },
  },
}

export const Disabled: S = {
  parameters: {
    docs: {
      description: {
        story:
          'Not applicable: a metric is a rendered figure, not a control. Its optional action is an ordinary button and carries its own disabled state; ' +
          'a tile with nothing to act on simply has no action.',
      },
    },
  },
}

export const NeedsAttention: S = {
  args: {
    label: 'Needs attention',
    value: 2,
    context: 'Two settlements are waiting on a document.',
    action: { label: 'Review', onSelect: () => {} },
  },
  parameters: {
    docs: {
      description: {
        story:
          '§ 5: *“no delta chip unless the delta is actionable”*. The tile has no way to render a percentage at all — ' +
          'what it can render is the one thing worth doing about the number.',
      },
    },
  },
}

export const TheFourQuestions: S = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))' }}>
      <MetricTile
        label="Available to settle"
        value={money('INR', 4500000000n)}
        context="You can settle up to this much right now."
      />
      <MetricTile label="In flight" value={3} context="Settling now. Nothing is needed from you." />
      <MetricTile
        label="Settled today"
        value={money('INR', 1250000000n)}
        context="Across 4 settlements."
      />
      <MetricTile
        label="Needs attention"
        value={2}
        context="Two settlements are waiting on a document."
        action={{ label: 'Review', onSelect: () => {} }}
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'The four questions `PRODUCT.md § 12.1` says Overview answers, and no fifth. The catalogue exists so a fifth metric ' +
          'cannot be added without someone deciding to add it.',
      },
    },
  },
}

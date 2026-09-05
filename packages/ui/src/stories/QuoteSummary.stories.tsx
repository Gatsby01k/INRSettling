import type { Meta, StoryObj } from '@storybook/react'
import { money } from '@inrsettle/money'
import { QuoteSummary } from '../components/settlement.js'

const SANDBOX_NOTICE =
  'Sandbox pricing. These rates and fees are deterministic test values, not a commercial quote.'

const meta: Meta<typeof QuoteSummary> = {
  title: 'Primitives/QuoteSummary',
  component: QuoteSummary,
  args: {
    recipientAmount: money('INR', 500000000n),
    fundingAmount: money('USDT', 60240964n),
    fxRate: '83.0000000000',
    fxPair: 'USDT/INR',
    fees: [{ code: 'platform_fee', label: 'Platform fee', amount: money('USDT', 301205n) }],
    estimatedDelivery: 'under 30 minutes',
    expiresInSeconds: 143,
    provisionalNotice: SANDBOX_NOTICE,
  },
}
export default meta
type S = StoryObj<typeof QuoteSummary>

export const Default: S = {}
export const Loading: S = { args: { loading: true } }
export const Empty: S = {
  parameters: { docs: { description: { story: 'Not applicable: with nothing to price the form does not render a summary.' } } },
}
export const Error: S = {
  args: { error: 'We could not reach the pricing service. Try again in a moment.' },
}
export const Disabled: S = {
  parameters: { docs: { description: { story: 'Not applicable: the summary reports a price and accepts no input.' } } },
}
export const Expired: S = { args: { expiresInSeconds: 0 } }

export const Repricing: S = {
  args: { repricing: true },
  parameters: {
    docs: {
      description: {
        story:
          '§ 6, the amount morph: the recipient figure stays on screen and transitions in place. ' +
          'It never blanks — *"that reads as uncertainty about money"* — so only the derived lines wait.',
      },
    },
  },
}

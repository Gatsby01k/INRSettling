import type { Meta, StoryObj } from '@storybook/react'
import { money } from '@inrsettle/money'
import { AmountDisplay } from '../components/settlement.js'

const meta: Meta<typeof AmountDisplay> = {
  title: 'Primitives/AmountDisplay',
  component: AmountDisplay,
  args: { amount: money('INR', 500000000n), size: 'primary' },
}
export default meta
type S = StoryObj<typeof AmountDisplay>

export const Default: S = { args: { label: 'Recipient gets', size: 'hero' } }
export const Loading: S = {
  parameters: { docs: { description: { story: 'Not applicable: the surface renders a Skeleton at the figure’s height while the amount is unknown.' } } },
}
export const Empty: S = {
  args: { amount: money('INR', 0n) },
  parameters: { docs: { description: { story: 'Zero is a real amount and renders as one.' } } },
}
export const Error: S = {
  args: { amount: money('INR', 500000000n), superseded: true, label: 'Previous quote' },
  parameters: { docs: { description: { story: 'A superseded figure is struck through rather than removed, so the change is visible.' } } },
}
export const Disabled: S = {
  parameters: { docs: { description: { story: 'Not applicable: an amount is not interactive.' } } },
}
export const Currencies: S = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <AmountDisplay amount={money('INR', 500000000n)} label="Indian grouping" />
      <AmountDisplay amount={money('USDT', 5960000000n)} label="Six-decimal currency" />
      <AmountDisplay amount={money('USD', 599900n)} label="International grouping" />
    </div>
  ),
}

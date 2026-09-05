import type { Meta, StoryObj } from '@storybook/react'
import { Combobox } from '../components/inputs.js'

const options = [
  { value: 'usdt', label: 'USDT' }, { value: 'usdc', label: 'USDC' }, { value: 'usd', label: 'USD' },
]

const meta: Meta<typeof Combobox> = {
  title: 'Primitives/Combobox',
  component: Combobox,
  args: { id: 'currency', label: 'Funding currency', options },
}
export default meta
type S = StoryObj<typeof Combobox>

export const Default: S = { args: { value: 'usdt' } }
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { options: [], emptyLabel: 'No funding currencies enabled yet' } }
export const Error: S = { args: { error: 'Choose a funding currency.' } }
export const Disabled: S = { args: { value: 'usdt', disabled: true } }

import type { Meta, StoryObj } from '@storybook/react'
import { Select } from '../components/index.js'

const options = [
  { value: 'usdt', label: 'USDT' },
  { value: 'usdc', label: 'USDC' },
]

const meta: Meta<typeof Select> = {
  title: 'Primitives/Select',
  component: Select,
  args: { id: 'funding', label: 'Funding currency', options },
}
export default meta
type S = StoryObj<typeof Select>

export const Default: S = {}
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { options: [], emptyLabel: 'No funding currencies enabled yet' } }
export const Error: S = { args: { error: 'Choose a funding currency.' } }
export const Disabled: S = { args: { disabled: true } }

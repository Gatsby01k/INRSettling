import type { Meta, StoryObj } from '@storybook/react'
import { AmountInput } from '../components/inputs.js'

const meta: Meta<typeof AmountInput> = {
  title: 'Primitives/AmountInput',
  component: AmountInput,
  args: { id: 'amount', label: 'Recipient gets', currency: 'INR' },
}
export default meta
type S = StoryObj<typeof AmountInput>

export const Default: S = { args: { value: 500000000n } }
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { value: null, placeholder: '0.00', help: 'The exact amount the recipient receives.' } }
export const Error: S = { args: { value: null, error: 'Enter an amount in INR.' } }
export const Disabled: S = { args: { value: 500000000n, disabled: true } }

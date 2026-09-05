import type { Meta, StoryObj } from '@storybook/react'
import { Radio } from '../components/inputs.js'

const options = [
  { value: 'recipient_first', label: 'Recipient gets a fixed amount' },
  { value: 'source_first', label: 'I send a fixed amount' },
]

const meta: Meta<typeof Radio> = {
  title: 'Primitives/Radio',
  component: Radio,
  args: { name: 'direction', legend: 'Direction', options, value: 'recipient_first' },
}
export default meta
type S = StoryObj<typeof Radio>

export const Default: S = {}
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { options: [], emptyLabel: 'No directions available' } }
export const Error: S = { args: { error: 'Choose a direction.' } }
export const Disabled: S = { args: { disabled: true } }

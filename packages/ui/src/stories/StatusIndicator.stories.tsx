import type { Meta, StoryObj } from '@storybook/react'
import { StatusIndicator } from '../components/beneficiary.js'

const meta: Meta<typeof StatusIndicator> = {
  title: 'Primitives/StatusIndicator',
  component: StatusIndicator,
  args: { tone: 'settled', label: 'Verified' },
}
export default meta
type S = StoryObj<typeof StatusIndicator>

export const Default: S = { args: { tone: 'settled', label: 'Verified', detail: 'checked 12 Aug' } }
export const Loading: S = { args: { tone: 'settling', label: 'Verifying', detail: 'usually under a minute' } }
export const Error: S = { args: { tone: 'action_required', label: 'Could not verify' } }
export const Empty: S = {
  args: { tone: 'ready', label: 'Not verified yet' },
  parameters: { docs: { description: { story: 'The nearest thing to empty: a destination nobody has checked.' } } },
}
export const Disabled: S = {
  args: { tone: 'cancelled', label: 'Disabled' },
  parameters: { docs: { description: { story: 'Not interactive; this renders a disabled subject, not a disabled control.' } } },
}

import type { Meta, StoryObj } from '@storybook/react'
import { Button } from '../components/index.js'

const meta: Meta<typeof Button> = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: 'Settle', variant: 'primary' },
}
export default meta
type S = StoryObj<typeof Button>

export const Default: S = {}
export const Secondary: S = { args: { variant: 'secondary', children: 'Cancel settlement' } }
export const Ghost: S = { args: { variant: 'ghost', children: 'View details' } }
export const Destructive: S = { args: { variant: 'destructive', children: 'Revoke key' } }
export const Loading: S = { args: { loading: true, children: 'Settling' } }
export const Error: S = {
  args: { variant: 'secondary', children: 'Retry' },
  parameters: { docs: { description: { story: 'A button does not fail on its own; it offers the recovery for a failure shown beside it.' } } },
}
export const Disabled: S = {
  args: { disabled: true, disabledReason: 'Add a beneficiary before settling' },
}
export const Empty: S = {
  parameters: { docs: { description: { story: 'Not applicable: a button renders its own label and has no collection that can be empty.' } } },
}

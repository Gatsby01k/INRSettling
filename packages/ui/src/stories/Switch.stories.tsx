import type { Meta, StoryObj } from '@storybook/react'
import { Switch } from '../components/index.js'

const meta: Meta<typeof Switch> = {
  title: 'Primitives/Switch',
  component: Switch,
  args: { label: 'Separation of duties' },
}
export default meta
type S = StoryObj<typeof Switch>

export const Default: S = { args: { defaultChecked: true } }
export const Error: S = { args: { 'aria-invalid': true } }
export const Disabled: S = { args: { disabled: true, checked: true, readOnly: true } }
export const Loading: S = {
  parameters: { docs: { description: { story: 'Not applicable: a switch reflects state it already has.' } } },
}
export const Empty: S = {
  parameters: { docs: { description: { story: 'Not applicable: a switch is binary.' } } },
}

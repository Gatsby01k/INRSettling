import type { Meta, StoryObj } from '@storybook/react'
import { Checkbox } from '../components/index.js'

const meta: Meta<typeof Checkbox> = {
  title: 'Primitives/Checkbox',
  component: Checkbox,
  args: { label: 'Require a second approver' },
}
export default meta
type S = StoryObj<typeof Checkbox>

export const Default: S = {}
export const Error: S = { args: { 'aria-invalid': true } }
export const Disabled: S = { args: { disabled: true, checked: true, readOnly: true } }
export const Loading: S = {
  parameters: { docs: { description: { story: 'Not applicable: a checkbox reflects state it already has; the surrounding form owns loading.' } } },
}
export const Empty: S = {
  parameters: { docs: { description: { story: 'Not applicable: a checkbox is binary and has no collection that can be empty.' } } },
}

import type { Meta, StoryObj } from '@storybook/react'
import { Popover } from '../components/overlays.js'

const meta: Meta<typeof Popover> = {
  title: 'Primitives/Popover',
  component: Popover,
  args: { id: 'filters', trigger: 'Filters', open: true, children: 'Filter controls go here.' },
}
export default meta
type S = StoryObj<typeof Popover>

export const Default: S = {}
export const Loading: S = { args: { loading: true } }
export const Error: S = { args: { children: 'Could not load filters. Try again.' } }
export const Disabled: S = { args: { open: false, disabled: true } }
export const Empty: S = {
  parameters: { docs: { description: { story: 'Not applicable: a popover with nothing to show is not opened; its trigger is hidden instead.' } } },
}

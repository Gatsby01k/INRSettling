import type { Meta, StoryObj } from '@storybook/react'
import { Reference } from '../components/settlement.js'

const meta: Meta<typeof Reference> = {
  title: 'Primitives/Reference',
  component: Reference,
  args: { value: 'stl_2Rn8Kq5TzYw6', label: 'Settlement' },
}
export default meta
type S = StoryObj<typeof Reference>

export const Default: S = {}
export const Loading: S = {
  parameters: { docs: { description: { story: 'Not applicable: a reference either exists or its row is omitted.' } } },
}
export const Empty: S = {
  parameters: { docs: { description: { story: 'Not applicable: an absent reference is not rendered.' } } },
}
export const Error: S = {
  parameters: { docs: { description: { story: 'Not applicable: a reference is a value, not an operation.' } } },
}
export const Disabled: S = { args: { value: 'dvr_9Kd2ZxKp0Wq4', label: 'Destination version', truncate: true } }

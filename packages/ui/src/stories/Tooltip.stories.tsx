import type { Meta, StoryObj } from '@storybook/react'
import { Button, Tooltip } from '../components/index.js'

const meta: Meta<typeof Tooltip> = {
  title: 'Primitives/Tooltip',
  component: Tooltip,
  args: { label: 'Copied to clipboard', children: <Button variant="ghost">stl_2Rn8Kq5TzYw6</Button> },
}
export default meta
type S = StoryObj<typeof Tooltip>

export const Default: S = {}
export const Disabled: S = {
  args: { label: 'Add a beneficiary first', children: <Button disabled>Settle</Button> },
}
export const Loading: S = { parameters: { docs: { description: { story: 'Not applicable: a tooltip renders text it already holds.' } } } }
export const Empty: S = { parameters: { docs: { description: { story: 'Not applicable: a tooltip with no label is not rendered.' } } } }
export const Error: S = { parameters: { docs: { description: { story: 'Not applicable: a tooltip has no failure of its own.' } } } }

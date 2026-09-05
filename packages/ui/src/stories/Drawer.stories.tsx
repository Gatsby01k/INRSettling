import type { Meta, StoryObj } from '@storybook/react'
import { Button, Skeleton } from '../components/index.js'
import { Drawer } from '../components/overlays.js'

const meta: Meta<typeof Drawer> = {
  title: 'Primitives/Drawer',
  component: Drawer,
  args: {
    open: true,
    title: 'Event details',
    children: 'The raw event payload appears here.',
    actions: <Button variant="secondary">Close</Button>,
  },
}
export default meta
type S = StoryObj<typeof Drawer>

export const Default: S = {}
export const Loading: S = { args: { children: <Skeleton height={120} /> } }
export const Error: S = { args: { title: 'Could not load this event', children: 'Send us the request ID from the developer log.' } }
export const Empty: S = { parameters: { docs: { description: { story: 'Not applicable: a drawer with nothing to show is not opened.' } } } }
export const Disabled: S = { parameters: { docs: { description: { story: 'Not applicable: its controls carry their own disabled state.' } } } }

import type { Meta, StoryObj } from '@storybook/react'
import { Button, EmptyState } from '../components/index.js'

const meta: Meta<typeof EmptyState> = {
  title: 'Primitives/EmptyState',
  component: EmptyState,
  args: {
    title: 'No beneficiaries yet',
    body: 'Add a beneficiary in India and verify their account, then you can settle to them.',
    action: <Button>Add beneficiary</Button>,
  },
}
export default meta
type S = StoryObj<typeof EmptyState>

export const Empty: S = {}
export const Error: S = {
  args: {
    title: 'We could not load your beneficiaries',
    body: 'This is on us. Try again, and if it keeps happening send us the request ID from the developer log.',
    action: <Button variant="secondary">Try again</Button>,
  },
}
export const Default: S = { parameters: { docs: { description: { story: 'Not applicable: an empty state exists only to represent emptiness.' } } } }
export const Loading: S = { parameters: { docs: { description: { story: 'Not applicable: a skeleton is shown while the collection loads.' } } } }
export const Disabled: S = { parameters: { docs: { description: { story: 'Not applicable: its action is a Button with its own states.' } } } }

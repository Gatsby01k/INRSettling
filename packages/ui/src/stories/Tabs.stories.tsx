import type { Meta, StoryObj } from '@storybook/react'
import { Tabs } from '../components/overlays.js'

const items = [
  { id: 'requests', label: 'Request logs', content: 'Recent API requests.' },
  { id: 'events', label: 'Event logs', content: 'Recent webhook deliveries.' },
  { id: 'keys', label: 'API keys', content: 'Keys for this environment.' },
]

const meta: Meta<typeof Tabs> = {
  title: 'Primitives/Tabs',
  component: Tabs,
  args: { id: 'dev', label: 'Developer', items },
}
export default meta
type S = StoryObj<typeof Tabs>

export const Default: S = {}
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { items: [], emptyLabel: 'Nothing to show yet' } }
export const Disabled: S = {
  args: { items: [items[0]!, { ...items[1]!, disabled: true }, items[2]!] },
}
export const Error: S = {
  parameters: { docs: { description: { story: 'Not applicable: the panel inside a tab set shows its own error state.' } } },
}

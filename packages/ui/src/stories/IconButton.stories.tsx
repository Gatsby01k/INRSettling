import type { Meta, StoryObj } from '@storybook/react'
import { IconButton } from '../components/index.js'

const meta: Meta<typeof IconButton> = {
  title: 'Primitives/IconButton',
  component: IconButton,
  args: { label: 'Copy reference', children: '⧉' },
}
export default meta
type S = StoryObj<typeof IconButton>

export const Default: S = {}
export const Loading: S = { args: { loading: true } }
export const Error: S = { args: { variant: 'destructive', label: 'Retry copy' } }
export const Disabled: S = { args: { disabled: true, disabledReason: 'Nothing to copy yet' } }
export const Empty: S = {
  parameters: { docs: { description: { story: 'Not applicable: an icon button has no collection that can be empty.' } } },
}

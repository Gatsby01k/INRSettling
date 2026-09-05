import type { Meta, StoryObj } from '@storybook/react'
import { Toast } from '../components/overlays.js'

const meta: Meta<typeof Toast> = {
  title: 'Primitives/Toast',
  component: Toast,
  args: { id: 't1', title: 'API key created', body: 'Copy it now — it is not shown again.' },
}
export default meta
type S = StoryObj<typeof Toast>

export const Default: S = {}
export const Loading: S = { args: { title: 'Creating key', loading: true } }
export const Error: S = { args: { tone: 'error', title: 'That change was not saved', body: 'A reason is required.' } }
export const Empty: S = { parameters: { docs: { description: { story: 'Not applicable: a toast with nothing to say is not raised.' } } } }
export const Disabled: S = { parameters: { docs: { description: { story: 'Not applicable: only its dismiss button is interactive.' } } } }

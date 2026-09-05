import type { Meta, StoryObj } from '@storybook/react'
import { Textarea } from '../components/index.js'

const meta: Meta<typeof Textarea> = {
  title: 'Primitives/Textarea',
  component: Textarea,
  args: { id: 'reason', label: 'Reason' },
}
export default meta
type S = StoryObj<typeof Textarea>

export const Default: S = { args: { defaultValue: 'Single-operator pilot, agreed with the customer.' } }
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { help: 'Recorded in the audit trail.' } }
export const Error: S = { args: { error: 'A reason is required to disable this in live.' } }
export const Disabled: S = { args: { disabled: true, defaultValue: 'Recorded 1 Sep 2026' } }

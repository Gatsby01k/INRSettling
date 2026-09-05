import type { Meta, StoryObj } from '@storybook/react'
import { DatePicker } from '../components/inputs.js'

const meta: Meta<typeof DatePicker> = {
  title: 'Primitives/DatePicker',
  component: DatePicker,
  args: { id: 'from', label: 'From' },
}
export default meta
type S = StoryObj<typeof DatePicker>

export const Default: S = { args: { value: '2026-09-01' } }
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { value: '', help: 'Leave blank for all time.' } }
export const Error: S = { args: { value: '2026-09-01', error: 'From must be before To.' } }
export const Disabled: S = { args: { value: '2026-09-01', disabled: true } }

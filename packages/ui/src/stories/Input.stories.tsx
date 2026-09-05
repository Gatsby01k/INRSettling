import type { Meta, StoryObj } from '@storybook/react'
import { Input } from '../components/index.js'

const meta: Meta<typeof Input> = {
  title: 'Primitives/Input',
  component: Input,
  args: { id: 'reference', label: 'Your reference', placeholder: 'INVOICE-2026-0914' },
}
export default meta
type S = StoryObj<typeof Input>

export const Default: S = { args: { defaultValue: 'INVOICE-2026-0914' } }
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { help: 'Optional. Shown on the settlement receipt.' } }
export const Error: S = {
  args: { defaultValue: 'INVOICE 2026 0914', error: 'Reference cannot contain spaces.' },
}
export const Disabled: S = { args: { disabled: true, defaultValue: 'INVOICE-2026-0914' } }

import type { Meta, StoryObj } from '@storybook/react'
import { Breadcrumb } from '../components/overlays.js'

const meta: Meta<typeof Breadcrumb> = {
  title: 'Primitives/Breadcrumb',
  component: Breadcrumb,
  args: { items: [{ label: 'Settlements', href: '#' }, { label: 'stl_2Rn8Kq5TzYw6' }] },
}
export default meta
type S = StoryObj<typeof Breadcrumb>

export const Default: S = {}
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { items: [], emptyLabel: 'Overview' } }
export const Error: S = { parameters: { docs: { description: { story: 'Not applicable: a breadcrumb has no failure of its own.' } } } }
export const Disabled: S = { parameters: { docs: { description: { story: 'Not applicable: a breadcrumb is navigation, not a control.' } } } }

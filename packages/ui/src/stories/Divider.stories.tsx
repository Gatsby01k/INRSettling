import type { Meta, StoryObj } from '@storybook/react'
import { Divider } from '../components/index.js'

const meta: Meta<typeof Divider> = { title: 'Primitives/Divider', component: Divider }
export default meta
type S = StoryObj<typeof Divider>

export const Default: S = {}
export const Loading: S = { parameters: { docs: { description: { story: 'Not applicable: a rule has no content to load.' } } } }
export const Empty: S = { parameters: { docs: { description: { story: 'Not applicable: a rule has no content to be empty.' } } } }
export const Error: S = { parameters: { docs: { description: { story: 'Not applicable: a rule cannot fail.' } } } }
export const Disabled: S = { parameters: { docs: { description: { story: 'Not applicable: a rule is not interactive.' } } } }

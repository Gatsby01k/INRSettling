import type { Meta, StoryObj } from '@storybook/react'
import { Spinner } from '../components/index.js'

const meta: Meta<typeof Spinner> = { title: 'Primitives/Spinner', component: Spinner }
export default meta
type S = StoryObj<typeof Spinner>

export const Loading: S = {}
export const Default: S = { parameters: { docs: { description: { story: 'Not applicable: a spinner exists only to represent loading.' } } } }
export const Empty: S = { parameters: { docs: { description: { story: 'Not applicable.' } } } }
export const Error: S = { parameters: { docs: { description: { story: 'Not applicable: a spinner has no failure of its own.' } } } }
export const Disabled: S = { parameters: { docs: { description: { story: 'Not applicable: a spinner is not interactive.' } } } }

import type { Meta, StoryObj } from '@storybook/react'
import { Skeleton } from '../components/index.js'

const meta: Meta<typeof Skeleton> = {
  title: 'Primitives/Skeleton',
  component: Skeleton,
  args: { width: 280, height: 20 },
}
export default meta
type S = StoryObj<typeof Skeleton>

export const Loading: S = {}
export const Default: S = { parameters: { docs: { description: { story: 'Not applicable: a skeleton exists only to represent loading, so its loading story is its default.' } } } }
export const Empty: S = { parameters: { docs: { description: { story: 'Not applicable: a skeleton has no content to be empty.' } } } }
export const Error: S = { parameters: { docs: { description: { story: 'Not applicable: the surrounding view shows the error.' } } } }
export const Disabled: S = { parameters: { docs: { description: { story: 'Not applicable: a skeleton is not interactive.' } } } }

import type { Meta, StoryObj } from '@storybook/react'
import { Button, Modal, Skeleton } from '../components/index.js'

const meta: Meta<typeof Modal> = {
  title: 'Primitives/Modal',
  component: Modal,
  args: {
    open: true,
    title: 'Turn off separation of duties?',
    children: 'One person will be able to create and approve settlements in live.',
    actions: <><Button variant="secondary">Keep it on</Button><Button variant="destructive">Turn it off</Button></>,
  },
}
export default meta
type S = StoryObj<typeof Modal>

export const Default: S = {}
export const Loading: S = { args: { children: <Skeleton height={64} />, actions: <Button loading>Saving</Button> } }
export const Error: S = {
  args: {
    title: 'That change was not saved',
    children: 'A reason is required to disable separation of duties in live.',
    actions: <Button variant="secondary">Back</Button>,
  },
}
export const Empty: S = { parameters: { docs: { description: { story: 'Not applicable: a modal with nothing to say is not opened.' } } } }
export const Disabled: S = { parameters: { docs: { description: { story: 'Not applicable: its controls carry their own disabled state.' } } } }

import type { Meta, StoryObj } from '@storybook/react'
import { FileDrop } from '../components/inputs.js'

const meta: Meta<typeof FileDrop> = {
  title: 'Primitives/FileDrop',
  component: FileDrop,
  args: { id: 'upload', label: 'Supporting document', accept: '.pdf,.png,.jpg' },
}
export default meta
type S = StoryObj<typeof FileDrop>

export const Default: S = { args: { files: [{ name: 'invoice-0914.pdf' }] } }
export const Loading: S = { args: { loading: true } }
export const Empty: S = { args: { files: [], help: 'PDF, PNG or JPG, up to 10 MB.' } }
export const Error: S = { args: { files: [], error: 'That file type is not accepted.' } }
export const Disabled: S = { args: { disabled: true, files: [] } }

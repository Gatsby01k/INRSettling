import type { Meta, StoryObj } from '@storybook/react'
import { SettlementProgress } from '../components/settlement.js'

const meta: Meta<typeof SettlementProgress> = {
  title: 'Primitives/SettlementProgress',
  component: SettlementProgress,
  args: { current: 'SETTLING' },
}
export default meta
type S = StoryObj<typeof SettlementProgress>

export const Default: S = { args: { current: 'READY', detail: 'Ready to settle.' } }
export const Loading: S = {
  args: { current: 'SETTLING', detail: 'Usually under 30 minutes.' },
  parameters: { docs: { description: { story: 'Settling is the rail’s own in-progress state; there is no separate loading skeleton.' } } },
}
export const Empty: S = {
  parameters: { docs: { description: { story: 'Not applicable: a settlement always has a position on the rail.' } } },
}
export const Error: S = {
  args: { current: 'SETTLING', delayed: true, detail: 'Taking longer than usual. Nothing is needed from you.' },
}
export const Disabled: S = {
  parameters: { docs: { description: { story: 'Not applicable: the rail reports progress and accepts no input.' } } },
}
export const Settled: S = { args: { current: 'SETTLED', detail: 'Funds released.' } }

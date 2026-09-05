import type { Meta, StoryObj } from '@storybook/react'
import { BeneficiaryPicker } from '../components/beneficiary.js'

const options = [
  {
    id: 'ben_1',
    displayName: 'Aarti Sharma',
    destinationSummary: 'HDFC •••• 6789',
    verification: { tone: 'settled' as const, label: 'Verified' },
  },
  {
    id: 'ben_2',
    displayName: 'Vertex Software Pvt Ltd',
    destinationSummary: 'ICIC •••• 0099',
    verification: { tone: 'settling' as const, label: 'Verifying' },
  },
  {
    id: 'ben_3',
    displayName: 'Ravi Menon',
    destinationSummary: null,
    verification: { tone: 'ready' as const, label: 'Not verified yet' },
  },
]

const meta: Meta<typeof BeneficiaryPicker> = {
  title: 'Primitives/BeneficiaryPicker',
  component: BeneficiaryPicker,
  args: { label: 'Beneficiary', options, query: '', onChange: () => {}, onQueryChange: () => {} },
}
export default meta
type S = StoryObj<typeof BeneficiaryPicker>

export const Default: S = { args: { value: 'ben_1' } }
export const Loading: S = { args: { loading: true, options: [] } }
export const Empty: S = { args: { options: [], query: 'zzz' } }
export const Error: S = {
  args: { options: [], query: 'zzz', emptyLabel: 'We could not load your beneficiaries. Try again in a moment.' },
}
export const Disabled: S = {
  args: { disabled: true, disabledReason: 'Choose a funding currency first.' },
}

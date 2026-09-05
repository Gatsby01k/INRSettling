import type { Meta, StoryObj } from '@storybook/react'
import { RequirementCard } from '../components/beneficiary.js'

const meta: Meta<typeof RequirementCard> = {
  title: 'Primitives/RequirementCard',
  component: RequirementCard,
  args: {
    code: 'beneficiary_account_unverified',
    title: 'Beneficiary payout details need verification',
    detail:
      'We confirm that HDFC •••• 6789 accepts payments and matches the beneficiary name. This takes about a minute.',
    action: { label: 'Verify now', onAction: () => {} },
  },
}
export default meta
type S = StoryObj<typeof RequirementCard>

export const Default: S = {}
export const Loading: S = { args: { busy: true, action: { label: 'Verifying…', onAction: () => {} } } }
export const Error: S = {
  args: {
    code: 'beneficiary_account_verification_failed',
    title: 'We could not confirm these payout details',
    detail:
      'The bank did not accept HDFC •••• 6789. Check the account number, IFSC and name with Aarti Sharma, then save the corrected details.',
    action: { label: 'Edit details', onAction: () => {} },
  },
}
export const Empty: S = {
  parameters: {
    docs: {
      description: {
        story:
          'Not applicable: the card cannot render without a title, a detail and an action — the type requires all three. A settlement with no requirements shows EmptyState instead.',
      },
    },
  },
}
export const Disabled: S = {
  args: {
    code: 'liquidity_facility_required',
    title: 'Your account is not set up to settle yet',
    detail:
      'Live settlements need your account to be enabled for settling. Sandbox settlements work without it, so you can keep building and testing.',
    action: { label: 'Talk to us about going live', onAction: () => {} },
    actionDisabledReason: 'Only a workspace admin can request this.',
  },
}
export const Advisory: S = {
  args: {
    severity: 'advisory',
    code: 'large_settlement_review',
    title: 'Large settlements may take longer to clear',
    detail:
      'Settlements of ₹50,00,000.00 are reviewed by the partner bank, which can add a few hours to delivery.',
    action: { label: 'Read more', onAction: () => {} },
  },
}

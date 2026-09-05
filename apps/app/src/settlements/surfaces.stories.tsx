import type { Meta, StoryObj } from '@storybook/react'
import { NewSettlement, EMPTY_NEW_SETTLEMENT } from './surfaces.js'
import {
  BENEFICIARIES,
  FUNDING_CURRENCIES,
  INVOICE_REQUIREMENT,
  PURPOSES,
  QUOTE,
  SANDBOX_PRICING_NOTICE,
} from './fixtures.js'

const noop = (): void => {}

const FILLED = {
  beneficiaryId: 'ben_aarti',
  recipientMinorUnits: 500_000_000n,
  purposeCode: 'SOFTWARE_SERVICES',
  fundingCurrency: 'USDT' as const,
  reference: '',
  documents: [],
}

const newSettlementMeta: Meta<typeof NewSettlement> = {
  title: 'Surfaces/New settlement',
  component: NewSettlement,
  args: {
    values: FILLED,
    onChange: noop,
    beneficiaries: BENEFICIARIES,
    beneficiaryQuery: 'Aarti',
    onBeneficiaryQueryChange: noop,
    purposes: PURPOSES,
    fundingCurrencies: FUNDING_CURRENCIES,
    quote: QUOTE,
    provisionalNotice: SANDBOX_PRICING_NOTICE,
    onSubmit: noop,
  },
}
export default newSettlementMeta
type N = StoryObj<typeof NewSettlement>

export const NewDefault: N = { name: 'Priced and ready' }
export const NewEmpty: N = {
  name: 'Empty',
  args: { values: EMPTY_NEW_SETTLEMENT, beneficiaryQuery: '', quote: null },
}
export const NewQuoteLoading: N = { name: 'Pricing', args: { quote: null, quoteLoading: true } }
export const NewQuoteError: N = {
  name: 'Pricing failed',
  args: { quote: null, quoteError: 'We could not reach the pricing service. Try again in a moment.' },
}
export const NewBlocked: N = {
  name: 'Blocked by preflight',
  args: {
    requirements: [INVOICE_REQUIREMENT],
    submitDisabledReason: 'Attach the invoice before you can settle this amount.',
  },
}
export const NewSubmitting: N = { name: 'Submitting', args: { submitting: true } }
export const NewRepricing: N = {
  name: 'Re-pricing',
  args: { quoteRepricing: true },
  parameters: {
    docs: {
      description: {
        story:
          '`DESIGN_SYSTEM.md § 6`: *"The figure never blanks and re-renders; that reads as uncertainty about money."* ' +
          'So a re-price keeps the recipient amount on screen and morphs it, and only the derived lines — you pay, ' +
          'rate, fees — go grey, because those genuinely are unknown until the new quote lands. ' +
          'Before Stage 10 this state replaced the whole summary with skeletons.',
      },
    },
  },
}

export const NewWithDocuments: N = {
  name: 'A purpose that needs documents',
  args: { documentsRequired: true },
  parameters: {
    docs: {
      description: {
        story:
          'The fifth input in the `PRODUCT.md § 12.2` reading order, and the *"if needed"* half of it. ' +
          'A file input on every settlement would imply one is expected; preflight decides, not this screen.',
      },
    },
  },
}

export const NewQuoteExpired: N = {
  name: 'Rate expired',
  args: { quote: { ...QUOTE, expiresInSeconds: 0 } },
}

/**
 * The receipt template — the "same template" in `ARCHITECTURE.md § 9`.
 *
 * Tested here, in the domain, because that is where it lives and because both
 * surfaces that render it — the UI and headless Chromium — are downstream. A
 * template tested only through the PDF would be a template whose properties
 * were being asserted through a browser, which is slower and proves less.
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalize,
  contentHash,
  escapeHtml,
  humanLabel,
  receiptDocument,
  renderReceiptTemplate,
  returnNoticeDocument,
  type CanonicalValue,
} from '../index.js'

const content = {
  receiptId: 'rcp_1', settlementId: 'stl_1', settlementIdDisplay: 'stl_1',
  workspaceId: 'ws_1', environment: 'sandbox',
  beneficiarySnapshot: {
    displayName: 'Aarti Sharma', legalName: null, country: 'IN',
    destinationKind: 'bank_account', accountNumberLast4: '0000',
    ifsc: 'HDFC0000123', vpa: null, accountHolderName: 'Aarti Sharma',
    destinationVersionId: 'dvr_1',
  },
  recipientAmount: { currency: 'INR', minorUnits: 500_000_000n },
  deliveredAmount: { currency: 'INR', minorUnits: 500_000_000n },
  fundingAmount: { currency: 'USDT', minorUnits: 1_000_000n },
  fxRate: 'INR/USDT 5000000000e-10',
  feeComponents: [{ kind: 'platform_fee', amount: { currency: 'INR', minorUnits: 250_000n } }],
  roundingResidual: { currency: 'INR', minorUnits: 0n },
  purpose: 'SOFTWARE_SERVICES', externalReference: 'inv-4412',
  payoutReference: 'UTR000000123', rail: 'RTGS',
  reconciliationResult: 'MATCHED', finalStatus: 'SETTLED',
  authorizedTermsHash: 'a'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z', authorizedAt: '2026-09-02T00:00:00.000Z',
  creditedAt: '2026-09-03T00:00:00.000Z', settledAt: '2026-09-03T01:00:00.000Z',
} as const

const receipt = receiptDocument(content)
const hash = contentHash(receipt)

describe('one template, rendered by every surface', () => {
  it('is a pure function of the document and the hash', () => {
    // The determinism that INV-29 actually needs. The PDF's bytes are not
    // reproducible — Chromium stamps a creation date — and they do not need to
    // be, because the PDF is not what `content_hash` covers. This is.
    expect(renderReceiptTemplate(receipt, hash)).toBe(renderReceiptTemplate(receipt, hash))
  })

  it('prints the hash on the document it is the hash of', () => {
    // The practical content of INV-29: a person holding the paper and the API
    // response can compare them without trusting either.
    expect(renderReceiptTemplate(receipt, hash)).toContain(hash)
  })

  it('changes when the document changes', () => {
    const other = receiptDocument({
      ...content,
      recipientAmount: { currency: 'INR', minorUnits: 500_000_001n },
    })
    expect(renderReceiptTemplate(other, contentHash(other)))
      .not.toBe(renderReceiptTemplate(receipt, hash))
  })

  it('renders every field of the canonical document a reader needs', () => {
    const html = renderReceiptTemplate(receipt, hash)
    for (const field of [
      'payout_reference', 'recipient_amount', 'delivered_amount', 'funding_amount',
      'reconciliation_result', 'final_status', 'beneficiary_snapshot', 'fee_components',
    ]) {
      expect(html, field).toContain(`data-field="${field}"`)
    }
    // A receipt that showed a curated subset would be a receipt whose hash
    // covers things the reader cannot see, and the reader is who the hash is for.
    expect(html).toContain('UTR000000123')
    expect(html).toContain('Aarti Sharma')
  })

  it('formats money the way every other surface does', () => {
    // The money package's own rule — Indian grouping for INR — not a second
    // opinion about it.
    const html = renderReceiptTemplate(receipt, hash)
    expect(html).toContain('₹50,00,000.00')
    // USDT is a six-decimal currency; the template asks the money package for
    // the scale rather than assuming two, which is how a receipt in a
    // non-two-decimal currency stays correct.
    expect(html).toContain('1.000000 USDT')
  })

  it('never leaks a full account number', () => {
    expect(renderReceiptTemplate(receipt, hash)).not.toContain('5010012340')
  })

  it('renders a return notice through the same function', () => {
    const notice = returnNoticeDocument(
      {
        noticeId: 'rnt_1', returnId: 'ret_1', settlementId: 'stl_1', receiptId: 'rcp_1',
        workspaceId: 'ws_1', environment: 'sandbox',
        amount: { currency: 'INR', minorUnits: 500_000_000n },
        reasonCode: 'RAIL_REVERSAL', reasonMessage: 'the receiving bank sent it back',
        returnStatusAtIssue: 'CONFIRMED', providerReturnReference: 'pret_1',
        createdAt: '2026-09-10T00:00:00.000Z',
      },
      hash,
    )
    const html = renderReceiptTemplate(notice, contentHash(notice))
    expect(html).toContain('Return notice')
    // It names the receipt it is about, and does not restate it.
    expect(html).toContain(hash)
    expect(html).not.toContain('UTR000000123')
  })
})

describe('escaping', () => {
  it('escapes every value, with no trusted path', () => {
    const hostile = receiptDocument({
      ...content,
      beneficiarySnapshot: {
        ...content.beneficiarySnapshot,
        displayName: '<script>alert(1)</script>',
        accountHolderName: `" onload="x`,
      },
    })
    const html = renderReceiptTemplate(hostile, contentHash(hostile))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('onload="x')
  })

  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('a hostile name changes the markup but not the hash’s meaning', () => {
    // The document is what is hashed; the template is a rendering of it. So an
    // injection attempt is neutralised at the rendering and is still faithfully
    // recorded in the canonical bytes, which is the honest split.
    const hostile = receiptDocument({
      ...content,
      beneficiarySnapshot: { ...content.beneficiarySnapshot, displayName: '<b>x</b>' },
    })
    expect(canonicalize(hostile.document as Record<string, CanonicalValue>)).toContain('<b>x</b>')
    expect(renderReceiptTemplate(hostile, contentHash(hostile))).not.toContain('<b>x</b>')
  })
})

describe('labels', () => {
  it('turns a field name into something a person reads', () => {
    expect(humanLabel('credited_at')).toBe('Credited at')
    expect(humanLabel('payout_reference')).toBe('Payout reference')
  })
})

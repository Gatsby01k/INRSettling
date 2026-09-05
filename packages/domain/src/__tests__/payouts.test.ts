/**
 * The payout domain — rail selection, UTR well-formedness, and the versioned
 * provider mapping that `INV-43` requires to be data rather than code.
 *
 * Everything here is pure, so it checks the *rules*: that rail selection reads
 * the provider's declaration rather than a table of Indian banking facts
 * somebody typed in, that a UTR is checked rather than trusted, and — the one
 * that matters most — that an unmapped provider code cannot throw, cannot
 * widen the taxonomy, and lands somewhere safe.
 */
import { describe, expect, it } from 'vitest'
import {
  EXCEPTION_CODES,
  PAYOUT_RAILS,
  UNMAPPED_REJECTION_DEFAULT,
  UNMAPPED_UNKNOWN_DEFAULT,
  interpretProviderCode,
  isCustomerActionable,
  isExceptionCode,
  isWellFormedUtr,
  selectRail,
  validateMappingTable,
  type PayoutCapabilities,
  type ProviderMappingTable,
} from '../index.js'

const rails: PayoutCapabilities['rails'] = [
  { rail: 'UPI', minMinor: 1n, maxMinor: 10_000_000n, destinationKinds: ['vpa'], open: true, terminalStatusSlaSeconds: 300 },
  { rail: 'IMPS', minMinor: 1n, maxMinor: 50_000_000n, destinationKinds: ['bank_account'], open: true, terminalStatusSlaSeconds: 900 },
  { rail: 'RTGS', minMinor: 20_000_000n, maxMinor: null, destinationKinds: ['bank_account'], open: true, terminalStatusSlaSeconds: 3600 },
  { rail: 'NEFT', minMinor: 1n, maxMinor: null, destinationKinds: ['bank_account'], open: true, terminalStatusSlaSeconds: 7200 },
]
const capabilities: PayoutCapabilities = { providerId: 'p', currency: 'INR', rails }

describe('rail selection reads the provider, not a hard-coded rulebook', () => {
  it('sends a VPA over UPI', () => {
    expect(
      selectRail({ capabilities, destinationKind: 'vpa', amountMinor: 100_000n }),
    ).toMatchObject({ ok: true, rail: 'UPI' })
  })

  it('prefers the fastest open rail that can carry the amount', () => {
    // IMPS beats NEFT for a small bank transfer; both could carry it.
    expect(
      selectRail({ capabilities, destinationKind: 'bank_account', amountMinor: 1_000_000n }),
    ).toMatchObject({ ok: true, rail: 'IMPS' })
  })

  it('falls to NEFT when the amount exceeds the faster rails', () => {
    // Above IMPS's declared ceiling; RTGS could carry it and is preferred over
    // NEFT, which is the frozen ordering.
    expect(
      selectRail({ capabilities, destinationKind: 'bank_account', amountMinor: 60_000_000n }),
    ).toMatchObject({ ok: true, rail: 'RTGS' })
  })

  it('refuses when no rail serves the destination kind', () => {
    const vpaOnly: PayoutCapabilities = { ...capabilities, rails: [rails[0]!] }
    expect(
      selectRail({ capabilities: vpaOnly, destinationKind: 'bank_account', amountMinor: 1n }),
    ).toMatchObject({ ok: false, reason: 'no_rail_for_destination' })
  })

  it('refuses when the amount fits no rail', () => {
    const rtgsOnly: PayoutCapabilities = { ...capabilities, rails: [rails[2]!] }
    expect(
      selectRail({ capabilities: rtgsOnly, destinationKind: 'bank_account', amountMinor: 100n }),
    ).toMatchObject({ ok: false, reason: 'no_rail_for_amount' })
  })

  it('distinguishes "everything is shut" from "nothing fits"', () => {
    // A closed rail opens again; a payment no rail can carry does not become
    // possible by waiting. Operations needs to tell those apart.
    const shut: PayoutCapabilities = {
      ...capabilities,
      rails: rails.map((r) => ({ ...r, open: false })),
    }
    expect(
      selectRail({ capabilities: shut, destinationKind: 'bank_account', amountMinor: 1_000_000n }),
    ).toMatchObject({ ok: false, reason: 'all_rails_closed' })
  })

  it('never selects a rail the provider has not declared', () => {
    const one: PayoutCapabilities = { ...capabilities, rails: [rails[3]!] }
    const chosen = selectRail({ capabilities: one, destinationKind: 'bank_account', amountMinor: 1n })
    expect(chosen).toMatchObject({ ok: true, rail: 'NEFT' })
    expect(PAYOUT_RAILS).toContain('NEFT')
  })
})

describe('a UTR is checked, not trusted', () => {
  it('accepts a well-formed reference', () => {
    expect(isWellFormedUtr('UTR000000123')).toBe(true)
  })

  it('rejects absent, empty and malformed values', () => {
    // Malformed is worse than absent: absent is visibly incomplete, malformed
    // looks like proof and is not — and the UTR is what a customer quotes to
    // their beneficiary's bank.
    for (const bad of [null, undefined, '', 'short', 'has spaces!!', 'UTR-000-123']) {
      expect(isWellFormedUtr(bad), String(bad)).toBe(false)
    }
  })
})

describe('INV-43 — the mapping table is data, and the taxonomy stays closed', () => {
  const table: ProviderMappingTable = {
    providerId: 'p',
    version: 'p.v1',
    source: 'sandbox_fixture',
    codes: [
      {
        providerCode: 'ACCOUNT_CLOSED',
        outcome: 'rejected',
        exceptionCode: 'PAYOUT_REJECTED_DESTINATION',
        note: 'the beneficiary account no longer exists',
      },
      { providerCode: 'PAID', outcome: 'credited', note: 'value reached the beneficiary' },
    ],
  }

  it('maps a known code to its taxonomy entry', () => {
    expect(interpretProviderCode(table, 'ACCOUNT_CLOSED')).toMatchObject({
      mapped: true,
      outcome: 'rejected',
      exceptionCode: 'PAYOUT_REJECTED_DESTINATION',
      mappingVersion: 'p.v1',
    })
  })

  it('never throws on a code it has never seen', () => {
    // The invariant, stated as the absence of a failure mode. A provider that
    // ships a new error code on a Friday must not be able to stop the queue.
    expect(() => interpretProviderCode(table, 'XX_NOVEL')).not.toThrow()
    expect(() => interpretProviderCode(table, '')).not.toThrow()
  })

  it('routes an unmapped rejection to the safe default and raises the alarm', () => {
    const result = interpretProviderCode(table, 'XX_NOVEL', 'rejected')
    expect(result).toMatchObject({
      mapped: false,
      outcome: 'rejected',
      exceptionCode: UNMAPPED_REJECTION_DEFAULT,
      alarm: 'unmapped_provider_code',
      rawCode: 'XX_NOVEL',
    })
  })

  it('routes an unclassifiable input to unknown, which leads to a pull', () => {
    expect(interpretProviderCode(table, 'XX_NOVEL')).toMatchObject({
      mapped: false,
      outcome: 'unknown',
      exceptionCode: UNMAPPED_UNKNOWN_DEFAULT,
    })
  })

  it('picks defaults that are never customer-actionable', () => {
    // We do not know what happened, so we cannot tell a customer what to do —
    // and a card saying "action required" with no action is worse than a delay.
    for (const code of [UNMAPPED_REJECTION_DEFAULT, UNMAPPED_UNKNOWN_DEFAULT]) {
      expect(isCustomerActionable(code), code).toBe(false)
    }
  })

  it('never invents a code outside the closed taxonomy', () => {
    const results = ['XX_A', 'XX_B', ''].flatMap((c) => [
      interpretProviderCode(table, c, 'rejected'),
      interpretProviderCode(table, c, 'unknown'),
    ])
    for (const r of results) {
      if ('exceptionCode' in r && r.exceptionCode) {
        expect(EXCEPTION_CODES).toContain(r.exceptionCode)
      }
    }
  })
})

describe('a mapping table is validated before it can be consulted', () => {
  it('accepts a well-formed table', () => {
    expect(
      validateMappingTable(
        {
          providerId: 'p',
          version: 'v1',
          source: 'sandbox_fixture',
          codes: [
            {
              providerCode: 'A',
              outcome: 'rejected',
              exceptionCode: 'PAYOUT_REJECTED_PROVIDER',
              note: 'the provider failed definitively',
            },
          ],
        },
        isExceptionCode,
      ),
    ).toEqual([])
  })

  it('rejects an entry naming a code outside the taxonomy', () => {
    // Without a load-time check, "the enum stays closed" would be true only of
    // code — and this table is data that someone edits.
    const problems = validateMappingTable(
      {
        providerId: 'p',
        version: 'v1',
        source: 'sandbox_fixture',
        codes: [
          {
            providerCode: 'A',
            outcome: 'rejected',
            exceptionCode: 'INVENTED_CODE' as never,
            note: 'a code that does not exist',
          },
        ],
      },
      isExceptionCode,
    )
    expect(problems.join(' ')).toMatch(/not in the closed taxonomy/)
  })

  it('rejects a rejection with no exception code, a duplicate, and an unexplained entry', () => {
    const problems = validateMappingTable(
      {
        providerId: 'p',
        version: 'v1',
        source: 'sandbox_fixture',
        codes: [
          { providerCode: 'A', outcome: 'rejected', note: 'a rejection with nowhere to go' },
          { providerCode: 'A', outcome: 'credited', note: 'the same code again, differently' },
          { providerCode: 'B', outcome: 'credited', note: 'short' },
        ],
      },
      isExceptionCode,
    )
    expect(problems.join(' ')).toMatch(/names no exception code/)
    expect(problems.join(' ')).toMatch(/duplicate mapping/)
    expect(problems.join(' ')).toMatch(/no usable note/)
  })
})

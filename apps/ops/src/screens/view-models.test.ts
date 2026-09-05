/**
 * The ops view models, as rules rather than as formatting.
 *
 * The one that matters most is the availability of actions: past the point of
 * no return an operator may resume and may not fail or cancel, and the screen
 * has to say so before the click rather than refuse afterwards.
 */
import { describe, expect, it } from 'vitest'
import {
  confirmFacilityLimit, confirmResolution, exceptionRow, facilityCard, formatMinor,
  orderQueue, providerEventRow, shortAge,
} from './view-models.js'

const NOW = new Date('2026-09-05T12:00:00Z')
const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000)

describe('money on an ops screen', () => {
  it('formats from the string, never through a number', () => {
    expect(formatMinor({ currency: 'INR', minorUnits: '500000000' }))
      .toBe('5,000,000.00 INR')
    expect(formatMinor({ currency: 'USDT', minorUnits: '1' })).toBe('0.01 USDT')
    expect(formatMinor({ currency: 'INR', minorUnits: '0' })).toBe('0.00 INR')
  })

  it('survives above 2^53, which is why it never becomes a number', () => {
    // The whole reason `INV-04` puts minor units on the wire as a string. A
    // rounded figure on an ops screen is one somebody makes a decision from.
    const huge = '900719925474099100'
    expect(formatMinor({ currency: 'INR', minorUnits: huge }))
      .toBe('9,007,199,254,740,991.00 INR')
  })

  it('formats a negative delta, which a reconciliation mismatch is', () => {
    expect(formatMinor({ currency: 'INR', minorUnits: '-2500' })).toBe('-25.00 INR')
  })
})

describe('the exception queue', () => {
  const base = {
    id: 'exc_1',
    settlementId: 'stl_1',
    workspaceId: 'ws_alpha',
    environment: 'live' as const,
    code: 'RECONCILIATION_MISMATCH',
    enteredFrom: 'RECONCILING',
    openedAt: ago(30),
    recipientAmount: { currency: 'INR', minorUnits: '500000000' },
    pastPointOfNoReturn: false,
    providerRawCode: null,
    classification: null,
  }

  it('offers all three resolutions before the point of no return', () => {
    expect(exceptionRow(base, NOW).available).toEqual(['resume', 'fail', 'cancel'])
    expect(exceptionRow(base, NOW).unavailableBecause).toBeNull()
  })

  it('offers only resume after it, and says why', () => {
    const row = exceptionRow({ ...base, pastPointOfNoReturn: true }, NOW)
    expect(row.available).toEqual(['resume'])
    expect(row.unavailableBecause).toMatch(/may already have credited/)
    // The honest framing: not "you are not allowed", but "we do not know".
    expect(row.unavailableBecause).toMatch(/resume it and find out/)
  })

  it('shows where a resume would go, because it is data and not a choice', () => {
    expect(exceptionRow(base, NOW).resumesTo).toBe('RECONCILING')
    expect(exceptionRow({ ...base, enteredFrom: 'PAYOUT_SUBMITTED' }, NOW).resumesTo)
      .toBe('PAYOUT_SUBMITTED')
  })

  it('flags an exception the provider caused with a code we do not know', () => {
    // The difference between "the provider is misbehaving" and "our mapping is
    // out of date" — different incidents, different fixes, identical from the
    // settlement's side.
    expect(exceptionRow(base, NOW).unmapped).toBe(false)
    expect(exceptionRow({ ...base, classification: 'unmapped' }, NOW).unmapped).toBe(true)
    expect(exceptionRow({ ...base, providerRawCode: 'ERR_9001' }, NOW).unmapped).toBe(true)
  })

  it('puts live before sandbox, then oldest first', () => {
    const rows = [
      exceptionRow({ ...base, id: 'a', environment: 'sandbox', openedAt: ago(600) }, NOW),
      exceptionRow({ ...base, id: 'b', environment: 'live', openedAt: ago(5) }, NOW),
      exceptionRow({ ...base, id: 'c', environment: 'live', openedAt: ago(300) }, NOW),
    ]
    // A ten-hour-old sandbox exception is somebody testing; a five-minute-old
    // live one is a customer's money.
    expect(orderQueue(rows).map((r) => r.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('a facility card', () => {
  const base = {
    id: 'fac_1',
    workspaceId: 'ws_alpha',
    environment: 'live' as const,
    providerId: 'partner_one',
    currency: 'USDT',
    limit: { currency: 'USDT', minorUnits: '100000000' },
    available: { currency: 'USDT', minorUnits: '60000000' },
    reserved: { currency: 'USDT', minorUnits: '10000000' },
    drawn: { currency: 'USDT', minorUnits: '30000000' },
    status: 'ACTIVE',
  }

  it('states the floor a limit cannot go below', () => {
    // drawn + reserved is money that has moved or is promised.
    expect(facilityCard(base).committed).toBe('400,000.00 USDT')
  })

  it('warns before a settlement stalls rather than after', () => {
    expect(facilityCard(base).headroom).toBe('healthy')
    expect(facilityCard({
      ...base, available: { currency: 'USDT', minorUnits: '1000000' },
    }).headroom).toBe('tight')
    expect(facilityCard({
      ...base, available: { currency: 'USDT', minorUnits: '0' },
    }).headroomLabel).toMatch(/settlements will stall here/)
  })

  it('says a suspended facility is not accepting reservations', () => {
    const card = facilityCard({ ...base, status: 'SUSPENDED' })
    expect(card.headroom).toBe('suspended')
    expect(card.headroomLabel).toContain('SUSPENDED')
  })
})

describe('a provider event', () => {
  const base = {
    id: 'pev_1',
    providerId: 'partner_one',
    eventType: 'payout.status',
    receivedAt: ago(2),
    signatureValid: true,
    interpretation: 'payout_credited',
    unmappedCode: null,
    subjectId: 'stl_1',
  }

  it('says plainly when a signature did not verify', () => {
    const row = providerEventRow({ ...base, signatureValid: false }, NOW)
    expect(row.verdict).toBe('unsigned')
    // Not just "invalid": what it *did*, which is nothing.
    expect(row.verdictLabel).toMatch(/changed nothing/)
  })

  it('names the code we could not interpret', () => {
    const row = providerEventRow(
      { ...base, unmappedCode: 'ERR_9001', interpretation: null }, NOW)
    expect(row.verdict).toBe('unmapped')
    expect(row.verdictLabel).toContain('ERR_9001')
    expect(row.verdictLabel).toMatch(/mapping table needs it/)
  })

  it('checks the signature before the mapping, because an unsigned event means nothing', () => {
    const row = providerEventRow(
      { ...base, signatureValid: false, unmappedCode: 'ERR_9001' }, NOW)
    expect(row.verdict).toBe('unsigned')
  })

  it('distinguishes received from interpreted', () => {
    expect(providerEventRow({ ...base, interpretation: null }, NOW).verdict).toBe('pending')
    expect(providerEventRow(base, NOW).verdict).toBe('interpreted')
  })
})

describe('what an operator is told before acting', () => {
  it('names the consequence, not the action', () => {
    const resume = confirmResolution('resume', 'LIQUIDITY_RESERVED')
    expect(resume.body).toContain('LIQUIDITY_RESERVED')
    // The honest part: it may stall again, and that is correct rather than a
    // failure to hide.
    expect(resume.body).toMatch(/stall again/)

    const fail = confirmResolution('fail', 'READY')
    expect(fail.body).toMatch(/no money reached their beneficiary/)
    expect(fail.body).toMatch(/final/)
  })

  it('asks a question a reason can actually answer', () => {
    expect(confirmResolution('fail', 'READY').reasonPrompt)
      .toMatch(/How do you know no value was delivered/)
    for (const resolution of ['resume', 'fail', 'cancel'] as const) {
      expect(confirmResolution(resolution, 'READY').reasonPrompt)
        .toMatch(/recorded permanently/)
    }
  })

  it('says which direction a limit change goes, and what it does not touch', () => {
    const committed = { currency: 'USDT', minorUnits: '40000000' }
    const raising = confirmFacilityLimit(
      { currency: 'USDT', minorUnits: '100000000' },
      { currency: 'USDT', minorUnits: '200000000' },
      committed,
    )
    expect(raising.title).toMatch(/Raise/)
    expect(raising.body).toMatch(/No money moves/)

    const lowering = confirmFacilityLimit(
      { currency: 'USDT', minorUnits: '200000000' },
      { currency: 'USDT', minorUnits: '100000000' },
      committed,
    )
    expect(lowering.title).toMatch(/Lower/)
    expect(lowering.body).toContain('400,000.00 USDT')
    expect(lowering.body).toMatch(/settlements already funded carry on/)
  })
})

describe('ages', () => {
  it('reads at a glance, which is what a queue is for', () => {
    expect(shortAge(ago(0), NOW)).toBe('0s')
    expect(shortAge(ago(5), NOW)).toBe('5m')
    expect(shortAge(ago(180), NOW)).toBe('3h')
    expect(shortAge(ago(60 * 24 * 3), NOW)).toBe('3d')
  })

  it('does not go negative on a clock that disagrees', () => {
    expect(shortAge(new Date(NOW.getTime() + 5000), NOW)).toBe('0s')
  })
})

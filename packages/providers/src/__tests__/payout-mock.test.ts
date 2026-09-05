/**
 * `MockIndiaPayoutProvider` — first-class code with tests.
 *
 * The two properties worth the most here are provider *idempotency* and the two
 * timeouts. If the simulator paid twice for the same key, every `INV-25` test
 * above it would prove nothing; and if it could not distinguish a timeout that
 * moved money from one that did not, the whole `UNKNOWN` design would be
 * untestable.
 */
import { describe, expect, it } from 'vitest'
import { PayoutTimeout } from '@inrsettle/domain'
import { createMockIndiaPayoutProvider } from '../payouts/mock-india.js'

const AT = new Date('2026-09-03T10:00:00.000Z')
const clock = () => AT

const cmd = (account: string, key: string, amountMinor = 500_000_000n) => ({
  settlementId: 'stl_1',
  attemptNumber: 1,
  idempotencyKey: key,
  rail: 'NEFT' as const,
  amountMinor,
  currency: 'INR' as const,
  destination: {
    destinationVersionId: 'dvr_1',
    kind: 'bank_account' as const,
    accountNumber: account,
    ifsc: 'HDFC0000123',
    accountHolderName: 'Aarti Sharma',
  },
})

describe('provider idempotency', () => {
  it('returns the first answer for a repeated key, and does not pay again', async () => {
    // The property INV-25 relies on. A simulator without it would make every
    // idempotency test above it vacuous.
    const p = createMockIndiaPayoutProvider({ now: clock })
    const first = await p.submitPayout(cmd('5010012340000', 'payout:v1:stl_1:1'))
    const again = await p.submitPayout(cmd('5010012340000', 'payout:v1:stl_1:1'))
    expect(again.providerReference).toBe(first.providerReference)
    expect(p.submissions.size).toBe(1)
  })

  it('treats a different key as a different submission', async () => {
    const p = createMockIndiaPayoutProvider({ now: clock })
    await p.submitPayout(cmd('5010012340000', 'payout:v1:stl_1:1'))
    await p.submitPayout(cmd('5010012340000', 'payout:v1:stl_1:2'))
    expect(p.submissions.size).toBe(2)
  })
})

describe('the two timeouts, which are not the same event', () => {
  it('…0005 times out having performed the payout', async () => {
    const p = createMockIndiaPayoutProvider({ now: clock })
    await expect(p.submitPayout(cmd('5010012340005', 'k1'))).rejects.toBeInstanceOf(PayoutTimeout)
    expect(await p.getPayout('k1')).toMatchObject({ status: 'CREDITED' })
  })

  it('a submission the provider never received answers not_found', async () => {
    const p = createMockIndiaPayoutProvider({ now: clock })
    expect(await p.getPayout('never-sent')).toEqual({ ok: true, status: 'not_found' })
  })

  it('is indistinguishable at the moment of failure', async () => {
    // There is nothing in the thrown error that separates "it happened" from
    // "it did not". That is the point, and it is why a pull is the only
    // correct recovery.
    const p = createMockIndiaPayoutProvider({ now: clock })
    const error = await p.submitPayout(cmd('5010012340005', 'k2')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PayoutTimeout)
    expect((error as PayoutTimeout).idempotencyKey).toBe('k2')
  })
})

describe('outcomes are selected by input, never by chance', () => {
  it('credits …0000 with a well-formed UTR', async () => {
    const p = createMockIndiaPayoutProvider({ now: clock })
    const ack = await p.submitPayout(cmd('5010012340000', 'k'))
    expect(ack.status).toBe('CREDITED')
    expect(ack.utr).toMatch(/^UTR\d{9}$/)
  })

  it('rejects …0002 with the code the mapping table expects', async () => {
    const p = createMockIndiaPayoutProvider({ now: clock })
    const ack = await p.submitPayout(cmd('5010012340002', 'k'))
    expect(ack).toMatchObject({ status: 'REJECTED', rawCode: 'BENE_ACCOUNT_CLOSED' })
  })

  it('leaves …0003 accepted and in flight', async () => {
    const p = createMockIndiaPayoutProvider({ now: clock })
    expect((await p.submitPayout(cmd('5010012340003', 'k'))).status).toBe('ACCEPTED')
    expect(await p.getPayout('k')).toMatchObject({ status: 'ACCEPTED' })
  })

  it('produces the same result on two independent instances', async () => {
    const a = createMockIndiaPayoutProvider({ now: clock })
    const b = createMockIndiaPayoutProvider({ now: clock })
    expect((await a.submitPayout(cmd('5010012340002', 'k'))).rawCode).toBe(
      (await b.submitPayout(cmd('5010012340002', 'k'))).rawCode,
    )
  })
})

describe('signature verification', () => {
  const p = createMockIndiaPayoutProvider({ now: clock, webhookSecret: 's3cret' })

  it('accepts a correctly signed, timely payload', () => {
    const signed = p.sign({ id: 'evt_1', type: 'payout.credited' })
    expect(p.verifySignature(signed.raw, signed.headers)).toMatchObject({
      valid: true, providerEventId: 'evt_1', eventType: 'payout.credited',
    })
  })

  it('rejects a tampered body', () => {
    const signed = p.sign({ id: 'evt_2', type: 'payout.credited' })
    const tampered = signed.raw.replace('credited', 'rejected')
    expect(p.verifySignature(tampered, signed.headers)).toMatchObject({
      valid: false, reason: 'bad_signature',
    })
  })

  it('rejects stale and future timestamps symmetrically', () => {
    // SECURITY.md § 4.2: |now − t| > 300s fails in *either* direction. Stale is
    // the common case and is what a replay looks like.
    const stale = p.sign({ id: 'evt_3', type: 'payout.credited' }, new Date(AT.getTime() - 3600_000))
    expect(p.verifySignature(stale.raw, stale.headers)).toMatchObject({ reason: 'stale_timestamp' })

    const future = p.sign({ id: 'evt_4', type: 'payout.credited' }, new Date(AT.getTime() + 3600_000))
    expect(p.verifySignature(future.raw, future.headers)).toMatchObject({ reason: 'future_timestamp' })
  })

  it('accepts the edges of the tolerance window', () => {
    for (const offset of [-299_000, 299_000]) {
      const signed = p.sign({ id: 'evt_edge', type: 'payout.credited' }, new Date(AT.getTime() + offset))
      expect(p.verifySignature(signed.raw, signed.headers).valid, String(offset)).toBe(true)
    }
  })

  it('rejects a malformed header or body rather than guessing', () => {
    expect(p.verifySignature('{}', {})).toMatchObject({ valid: false, reason: 'malformed' })
    expect(p.verifySignature('not json', { 'inrsettle-signature': 't=1,v1=ab' })).toMatchObject({
      valid: false,
    })
    // Signed correctly, but carrying no event id — unusable for deduplication.
    const noId = p.sign({ type: 'payout.credited' })
    expect(p.verifySignature(noId.raw, noId.headers)).toMatchObject({ valid: false, reason: 'malformed' })
  })

  it('does not throw on a signature of the wrong length', () => {
    // `timingSafeEqual` throws on a length mismatch rather than returning
    // false, which would turn a hostile input into a 500.
    const signed = p.sign({ id: 'evt_5', type: 'payout.credited' })
    const shortSig = signed.headers['inrsettle-signature']!.replace(/v1=.*/, 'v1=ab')
    expect(() => p.verifySignature(signed.raw, { 'inrsettle-signature': shortSig })).not.toThrow()
    expect(p.verifySignature(signed.raw, { 'inrsettle-signature': shortSig })).toMatchObject({
      valid: false, reason: 'bad_signature',
    })
  })
})

describe('declared capabilities', () => {
  it('declares rails rather than asserting Indian banking rules', async () => {
    const p = createMockIndiaPayoutProvider({ now: clock })
    const caps = await p.capabilities()
    expect(caps.currency).toBe('INR')
    expect(caps.rails.map((r) => r.rail).sort()).toEqual(['IMPS', 'NEFT', 'RTGS', 'UPI'])
    // Every rail carries its own SLA, so the T18 sweeper has a number that came
    // from the provider rather than from us. D-13 stays open.
    for (const rail of caps.rails) expect(rail.terminalStatusSlaSeconds).toBeGreaterThan(0)
  })

  it('can be overridden, which is how a real partner supplies its own answer', async () => {
    const p = createMockIndiaPayoutProvider({
      now: clock,
      rails: [{
        rail: 'NEFT', minMinor: 1n, maxMinor: null, destinationKinds: ['bank_account'],
        open: false, terminalStatusSlaSeconds: 60,
      }],
    })
    const caps = await p.capabilities()
    expect(caps.rails).toHaveLength(1)
    expect(caps.rails[0]!.open).toBe(false)
  })
})

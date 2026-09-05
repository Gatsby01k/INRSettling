/**
 * `MockLiquidityProvider` — first-class code with tests, not a throwaway stub.
 *
 * The scenarios that earn their keep are the two timeouts. A provider call that
 * does not answer leaves the caller unable to say whether money moved, and the
 * only thing that separates "it did" from "it did not" is a later status pull.
 * A mock that could not produce both would make the `UNKNOWN` paths — T29, Y05,
 * `INV-24`, `INV-47` — untestable, which is to say untested.
 */
import { describe, expect, it } from 'vitest'
import { ProviderTimeout } from '@inrsettle/domain'
import { createMockLiquidityProvider, liquidityScenarioFor } from '../liquidity/mock.js'

const cmd = (reference: string, fingerprint: string, amountMinor = 1_000_000n) => ({
  providerFacilityId: 'pfac_1',
  currency: 'USDT' as const,
  amountMinor,
  requestFingerprint: fingerprint,
  reference,
})

describe('scenario selection is by input, never by chance', () => {
  it('reads the scenario off the reference suffix', () => {
    expect(liquidityScenarioFor('ref_0000')).toBe('confirm')
    expect(liquidityScenarioFor('ref_0001')).toBe('reject')
    expect(liquidityScenarioFor('ref_0002')).toBe('timeout_not_performed')
    expect(liquidityScenarioFor('ref_0003')).toBe('timeout_performed')
    expect(liquidityScenarioFor('ref_0004')).toBe('pending')
  })

  it('defaults to the happy path, so a test that does not care need not say', () => {
    expect(liquidityScenarioFor('anything')).toBe('confirm')
  })

  it('gives the same answer every time it is asked', () => {
    const a = createMockLiquidityProvider()
    const b = createMockLiquidityProvider()
    expect(liquidityScenarioFor('ref_0003')).toBe(liquidityScenarioFor('ref_0003'))
    expect(a.id).toBe(b.id)
  })
})

describe('drawdown', () => {
  it('confirms and moves the provider-side drawn figure', async () => {
    const p = createMockLiquidityProvider()
    const ack = await p.requestDrawdown(cmd('ref_0000', 'drawdown:v1:drw_1'))
    expect(ack.status).toBe('CONFIRMED')
    expect((await p.getFacility('pfac_1')).drawnMinor).toBe(1_000_000n)
  })

  it('is idempotent: the same fingerprint returns the same answer, once', async () => {
    // What a real provider's idempotency store does — returns the previous
    // result rather than doing the thing again. A mock that drew down twice
    // would hide exactly the bug the fingerprint exists to prevent.
    const p = createMockLiquidityProvider()
    const first = await p.requestDrawdown(cmd('ref_0000', 'drawdown:v1:drw_1'))
    const again = await p.requestDrawdown(cmd('ref_0000', 'drawdown:v1:drw_1'))
    expect(again.providerReference).toBe(first.providerReference)
    expect((await p.getFacility('pfac_1')).drawnMinor).toBe(1_000_000n)
  })

  it('rejects when asked to', async () => {
    const p = createMockLiquidityProvider()
    expect((await p.requestDrawdown(cmd('ref_0001', 'drawdown:v1:drw_2'))).status).toBe('FAILED')
    expect((await p.getFacility('pfac_1')).drawnMinor).toBe(0n)
  })
})

describe('the two timeouts, which are not the same event', () => {
  it('a timeout that did not perform answers not_found on the pull', async () => {
    const p = createMockLiquidityProvider()
    await expect(p.requestDrawdown(cmd('ref_0002', 'drawdown:v1:drw_3'))).rejects.toBeInstanceOf(
      ProviderTimeout,
    )
    // `not_found` is a real answer, distinct from an error: it is the provider
    // saying the command it was never asked to perform does not exist, which
    // resolves UNKNOWN in the safe direction.
    expect(await p.getDrawdown('drawdown:v1:drw_3')).toEqual({ ok: true, status: 'not_found' })
    expect((await p.getFacility('pfac_1')).drawnMinor).toBe(0n)
  })

  it('a timeout that did perform answers CONFIRMED on the pull', async () => {
    // The scenario that justifies the whole design. The caller heard nothing,
    // the money moved, and resubmitting would draw down twice.
    const p = createMockLiquidityProvider()
    await expect(p.requestDrawdown(cmd('ref_0003', 'drawdown:v1:drw_4'))).rejects.toBeInstanceOf(
      ProviderTimeout,
    )
    expect(await p.getDrawdown('drawdown:v1:drw_4')).toMatchObject({ ok: true, status: 'CONFIRMED' })
    expect((await p.getFacility('pfac_1')).drawnMinor).toBe(1_000_000n)
  })

  it('is indistinguishable at the moment of failure, and only the pull separates them', async () => {
    const p = createMockLiquidityProvider()
    const errors: unknown[] = []
    for (const [ref, fp] of [['ref_0002', 'fp_a'], ['ref_0003', 'fp_b']] as const) {
      await p.requestDrawdown(cmd(ref, fp)).catch((e: unknown) => errors.push(e))
    }
    // Both throw the same type carrying the same information. There is nothing
    // in the failure itself that tells them apart — which is the point.
    expect(errors).toHaveLength(2)
    expect(errors.every((e) => e instanceof ProviderTimeout)).toBe(true)

    expect(await p.getDrawdown('fp_a')).toMatchObject({ status: 'not_found' })
    expect(await p.getDrawdown('fp_b')).toMatchObject({ status: 'CONFIRMED' })
  })
})

describe('repayment', () => {
  it('reduces the provider-side drawn figure on confirmation', async () => {
    const p = createMockLiquidityProvider()
    await p.requestDrawdown(cmd('ref_0000', 'drawdown:v1:drw_5', 5_000_000n))
    await p.submitRepayment(cmd('ref_0000', 'repay:v1:rpy_1:1', 2_000_000n))
    expect((await p.getFacility('pfac_1')).drawnMinor).toBe(3_000_000n)
  })

  it('reports an accepted-but-pending repayment as SUBMITTED', async () => {
    const p = createMockLiquidityProvider()
    expect((await p.submitRepayment(cmd('ref_0004', 'repay:v1:rpy_2:1'))).status).toBe('SUBMITTED')
  })

  it('answers getRepayment, which INV-47 requires the port to carry', async () => {
    const p = createMockLiquidityProvider()
    await p.submitRepayment(cmd('ref_0000', 'repay:v1:rpy_3:1'))
    expect(await p.getRepayment('repay:v1:rpy_3:1')).toMatchObject({ ok: true, status: 'CONFIRMED' })
    expect(await p.getRepayment('repay:v1:rpy_never:1')).toEqual({ ok: true, status: 'not_found' })
  })

  it('treats a re-request under a new fingerprint as a new submission', async () => {
    // Y08. The attempt component is what makes the second submission reachable
    // at all — the first fingerprint would have returned its cached failure.
    const p = createMockLiquidityProvider()
    await p.submitRepayment(cmd('ref_0001', 'repay:v1:rpy_4:1'))
    expect(await p.getRepayment('repay:v1:rpy_4:1')).toMatchObject({ status: 'FAILED' })

    await p.submitRepayment(cmd('ref_0000', 'repay:v1:rpy_4:2'))
    expect(await p.getRepayment('repay:v1:rpy_4:2')).toMatchObject({ status: 'CONFIRMED' })
  })
})

describe('the facility snapshot', () => {
  it('does not move on its own between reads', async () => {
    // A snapshot with a moving timestamp makes every test that compares two
    // snapshots flaky for reasons that have nothing to do with the code.
    const p = createMockLiquidityProvider()
    const a = await p.getFacility('pfac_1')
    const b = await p.getFacility('pfac_1')
    expect(a).toEqual(b)
  })

  it('reports the limit it was configured with', async () => {
    const p = createMockLiquidityProvider({ limitMinor: 42n, currency: 'USDT' })
    expect((await p.getFacility('pfac_1')).limitMinor).toBe(42n)
  })
})

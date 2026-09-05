import { describe, expect, it } from 'vitest'
import {
  add, compare, formatMoney, fromJson, money, moneyFromDecimalString, MoneyError,
  scaleOf, subtract, sum, toJson,
} from './index.js'

describe('money — INV-01..INV-04', () => {
  it('holds INR as paise and USDT at scale 6', () => {
    expect(scaleOf('INR')).toBe(2)
    expect(scaleOf('USDT')).toBe(6)
    expect(moneyFromDecimalString('INR', '5000000.00').minorUnits).toBe(500000000n)
    expect(moneyFromDecimalString('USDT', '56547.652707').minorUnits).toBe(56547652707n)
  })

  it('refuses cross-currency arithmetic (INV-03)', () => {
    const inr = money('INR', 100n)
    const usdt = money('USDT', 100n)
    expect(() => add(inr, usdt)).toThrowError(MoneyError)
    expect(() => subtract(inr, usdt)).toThrowError(/cannot combine INR and USDT/)
  })

  it('refuses more precision than the currency has', () => {
    expect(() => moneyFromDecimalString('INR', '1.234')).toThrowError(/more precision/)
    expect(moneyFromDecimalString('USDT', '1.234567').minorUnits).toBe(1234567n)
  })

  it('survives values beyond Number.MAX_SAFE_INTEGER (INV-04)', () => {
    const huge = money('USDT', 9_007_199_254_740_993n) // 2^53 + 1
    const json = toJson(huge)
    expect(json.minor_units).toBe('9007199254740993')
    expect(fromJson(json).minorUnits).toBe(huge.minorUnits)
    // The failure mode this guards against:
    expect(BigInt(Number(json.minor_units))).not.toBe(huge.minorUnits)
  })

  it('groups digits both ways without changing the value', () => {
    const m = moneyFromDecimalString('INR', '5000000.00')
    expect(formatMoney(m, { format: 'international' })).toBe('₹5,000,000.00')
    expect(formatMoney(m, { format: 'indian' })).toBe('₹50,00,000.00')
  })

  it('adds and compares exactly', () => {
    const a = moneyFromDecimalString('INR', '0.10')
    const b = moneyFromDecimalString('INR', '0.20')
    expect(add(a, b).minorUnits).toBe(30n)
    // The classic float failure, absent by construction:
    expect(formatMoney(add(a, b), { symbol: false })).toBe('0.30')
    expect(compare(a, b)).toBe(-1)
    expect(sum('INR', [a, b, a]).minorUnits).toBe(40n)
  })

  it('rejects a non-integer minor_units on the wire', () => {
    expect(() => fromJson({ currency: 'INR', minor_units: '10.5' })).toThrowError(/integer string/)
    expect(() => fromJson({ currency: 'XYZ', minor_units: '10' })).toThrowError(/unknown currency/)
  })
})

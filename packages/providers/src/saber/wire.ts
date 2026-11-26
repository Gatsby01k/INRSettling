/** Preserve decimal tokens at the HTTP boundary; money never takes a trip
 * through Number, even when Saber specifies JSON numbers on the wire. */
export function parseSaberJson(raw: string): unknown {
  return JSON.parse(raw.replace(/("(?:[^"\\]|\\.)*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (token: string, quoted: string | undefined) => quoted === undefined ? JSON.stringify(token) : token)) as unknown
}

class DecimalToken {
  constructor(readonly value: string) {}
}
export function saberDecimal(value: string): DecimalToken {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
    throw new Error('Saber amount must be a positive plain decimal string')
  }
  return new DecimalToken(value)
}

export function encodeSaberJson(value: unknown): string {
  if (value instanceof DecimalToken) return value.value
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(encodeSaberJson).join(',') + ']'
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.entries(value as Record<string, unknown>).map(([k, v]) => JSON.stringify(k) + ':' + encodeSaberJson(v)).join(',') + '}'
  }
  throw new Error('Saber JSON accepts explicit decimal tokens, strings, booleans and plain objects')
}

export function saberObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Saber response shape')
  return value as Record<string, unknown>
}

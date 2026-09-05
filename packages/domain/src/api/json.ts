/**
 * A strict JSON reader for request bodies.
 *
 * `JSON.parse` is not usable here for one reason: **it silently resolves
 * duplicate keys**. `JSON.parse('{"minor_units":"100","minor_units":"100000000"}')`
 * yields `{minor_units: "100000000"}` — last wins — and a different parser in a
 * proxy, a gateway or the customer's own SDK may take the first. Two hops then
 * disagree about what the request *was*.
 *
 * That matters more here than in most APIs, because a request body is
 * fingerprinted for idempotency. Two bodies that differ only in a duplicated key
 * collapse to the same fingerprint, and the same fingerprint is a **replay**:
 * the client is told its second payment succeeded, receives the first payment's
 * response, and the money never moves. A `400` is the right answer to an
 * ambiguous document, and it is not a thing that can be canonicalized away.
 *
 * So: a recursive-descent reader that produces the same values `JSON.parse`
 * would, and refuses a duplicate key inside any object. It is not a general JSON
 * library — it reads request bodies, which are small, and it reports the byte
 * offset of the problem because "invalid JSON" without a position is the generic
 * error message `PRODUCT.md § 7.1` forbids.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    /** `duplicate_key` is a distinct code because it is a distinct hazard. */
    readonly kind: 'malformed' | 'duplicate_key' = 'malformed',
  ) {
    super(message)
    this.name = 'JsonParseError'
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

class Reader {
  private i = 0
  constructor(private readonly s: string) {}

  get offset(): number {
    return this.i
  }

  private fail(message: string, kind: 'malformed' | 'duplicate_key' = 'malformed'): never {
    throw new JsonParseError(message, this.i, kind)
  }

  private peek(): string | undefined {
    return this.s[this.i]
  }

  private skipWhitespace(): void {
    while (this.i < this.s.length && WHITESPACE.has(this.s[this.i]!)) this.i += 1
  }

  private expect(ch: string): void {
    if (this.s[this.i] !== ch) this.fail(`expected ${JSON.stringify(ch)}`)
    this.i += 1
  }

  parseDocument(): JsonValue {
    this.skipWhitespace()
    const value = this.parseValue()
    this.skipWhitespace()
    if (this.i !== this.s.length) this.fail('trailing content after the JSON value')
    return value
  }

  private parseValue(): JsonValue {
    this.skipWhitespace()
    const ch = this.peek()
    if (ch === undefined) this.fail('unexpected end of input')
    switch (ch) {
      case '{': return this.parseObject()
      case '[': return this.parseArray()
      case '"': return this.parseString()
      case 't': return this.parseLiteral('true', true)
      case 'f': return this.parseLiteral('false', false)
      case 'n': return this.parseLiteral('null', null)
      default: return this.parseNumber()
    }
  }

  private parseLiteral<T extends boolean | null>(word: string, value: T): T {
    if (this.s.slice(this.i, this.i + word.length) !== word) this.fail(`expected ${word}`)
    this.i += word.length
    return value
  }

  private parseObject(): { [key: string]: JsonValue } {
    this.expect('{')
    const out: { [key: string]: JsonValue } = {}
    // A plain object literal inherits Object.prototype, so "__proto__" and
    // "constructor" as keys would be assignments to the prototype chain rather
    // than to the document. Null-prototype storage keeps a key a key.
    const seen = new Set<string>()
    this.skipWhitespace()
    if (this.peek() === '}') {
      this.i += 1
      return out
    }
    for (;;) {
      this.skipWhitespace()
      if (this.peek() !== '"') this.fail('expected a quoted object key')
      const keyAt = this.i
      const key = this.parseString()
      if (seen.has(key)) {
        this.i = keyAt
        this.fail(
          `duplicate key ${JSON.stringify(key)} — a JSON object with the same key twice has no ` +
            'single meaning, and different parsers resolve it differently',
          'duplicate_key',
        )
      }
      seen.add(key)
      this.skipWhitespace()
      this.expect(':')
      const value = this.parseValue()
      Object.defineProperty(out, key, {
        value, writable: true, enumerable: true, configurable: true,
      })
      this.skipWhitespace()
      const next = this.peek()
      if (next === ',') {
        this.i += 1
        continue
      }
      if (next === '}') {
        this.i += 1
        return out
      }
      this.fail('expected "," or "}"')
    }
  }

  private parseArray(): JsonValue[] {
    this.expect('[')
    const out: JsonValue[] = []
    this.skipWhitespace()
    if (this.peek() === ']') {
      this.i += 1
      return out
    }
    for (;;) {
      out.push(this.parseValue())
      this.skipWhitespace()
      const next = this.peek()
      if (next === ',') {
        this.i += 1
        continue
      }
      if (next === ']') {
        this.i += 1
        return out
      }
      this.fail('expected "," or "]"')
    }
  }

  private parseString(): string {
    this.expect('"')
    let out = ''
    for (;;) {
      const ch = this.s[this.i]
      if (ch === undefined) this.fail('unterminated string')
      if (ch === '"') {
        this.i += 1
        return out
      }
      if (ch === '\\') {
        this.i += 1
        const esc = this.s[this.i]
        if (esc === undefined) this.fail('unterminated escape sequence')
        this.i += 1
        switch (esc) {
          case '"': out += '"'; break
          case '\\': out += '\\'; break
          case '/': out += '/'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'u': {
            const hex = this.s.slice(this.i, this.i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('malformed \\u escape')
            // `Number('0x…')` rather than `parseInt`, which the money lint rule
            // bans outright (`INV-01`). The rule is about arithmetic on amounts
            // and this is a character code, but a ban with exceptions is a ban
            // nobody trusts — and the alternative here is exact and shorter.
            out += String.fromCharCode(Number(`0x${hex}`))
            this.i += 4
            break
          }
          default: this.fail(`unknown escape \\${esc}`)
        }
        continue
      }
      // Unescaped control characters are invalid JSON, and U+0000 in particular
      // cannot be stored in a jsonb column — a stray NUL that reached the
      // database would abort the whole transaction.
      if (ch < ' ') this.fail('unescaped control character in string')
      out += ch
      this.i += 1
    }
  }

  private parseNumber(): number {
    const start = this.i
    if (this.peek() === '-') this.i += 1
    while (this.i < this.s.length && this.s[this.i]! >= '0' && this.s[this.i]! <= '9') this.i += 1
    if (this.peek() === '.') {
      this.i += 1
      while (this.i < this.s.length && this.s[this.i]! >= '0' && this.s[this.i]! <= '9') this.i += 1
    }
    const e = this.peek()
    if (e === 'e' || e === 'E') {
      this.i += 1
      const sign = this.peek()
      if (sign === '+' || sign === '-') this.i += 1
      while (this.i < this.s.length && this.s[this.i]! >= '0' && this.s[this.i]! <= '9') this.i += 1
    }
    const text = this.s.slice(start, this.i)
    if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
      this.i = start
      this.fail('malformed number')
    }
    return Number(text)
  }
}

/** Parse a request body, refusing anything ambiguous. */
export function parseStrictJson(text: string): JsonValue {
  return new Reader(text).parseDocument()
}

// Verifying an INRSettle webhook — TypeScript (Node 18+)
//
// Three rules, and each one is a vulnerability if you skip it:
//
//   1. Compare in constant time. `===` on a hex digest leaks the answer one
//      byte at a time to anyone who can send you requests and time them.
//   2. Reject a timestamp outside five minutes in EITHER direction. A stale
//      timestamp is exactly what a replay looks like; checking only the future
//      side leaves the replay window open forever.
//   3. Treat `event.id` as an idempotency key. Redelivery is expected, not a
//      fault, and events can arrive out of order — `created_at` orders them.
//
// For anything irreversible on your side, re-read the settlement over the API
// rather than trusting the payload alone.

import { createHmac, timingSafeEqual } from 'node:crypto'

const TOLERANCE_SECONDS = 300

export function verifyInrsettleSignature(
  rawBody: string,
  signatureHeader: string,
  secrets: string[], // one, or two during a rotation overlap
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  let timestamp: number | null = null
  const presented: string[] = []

  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value)
    else if (key === 'v1' && /^[0-9a-f]+$/i.test(value)) presented.push(value.toLowerCase())
  }
  if (timestamp === null || presented.length === 0) return false

  // Rule 2 — both directions.
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false

  for (const secret of secrets) {
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')
    for (const candidate of presented) {
      // Rule 1 — constant time.
      const a = Buffer.from(expected, 'utf8')
      const b = Buffer.from(candidate, 'utf8')
      if (a.length === b.length && timingSafeEqual(a, b)) return true
    }
  }
  return false
}

// Express, for example. Note `express.raw`: the signature covers the RAW body,
// so a JSON body-parser that has already re-serialised it will not verify.
//
//   app.post('/webhooks/inrsettle',
//     express.raw({ type: 'application/json' }),
//     (req, res) => {
//       const ok = verifyInrsettleSignature(
//         req.body.toString('utf8'),
//         req.get('INRSettle-Signature') ?? '',
//         [process.env.INRSETTLE_WEBHOOK_SECRET!],
//       )
//       if (!ok) return res.status(400).send('bad signature')
//       const event = JSON.parse(req.body.toString('utf8'))
//       if (alreadyHandled(event.id)) return res.sendStatus(200)  // rule 3
//       handle(event)
//       res.sendStatus(200)
//     })

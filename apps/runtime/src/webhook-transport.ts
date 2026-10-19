import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import type { WebhookTransport } from '@inrsettle/app-services'

/** Public destinations only. IPv6 is limited to global unicast and excludes
 * documentation space; IPv4-mapped IPv6 is never accepted. */
export function publicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6) return false
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
  if (normalized.startsWith('2001:') && Number.parseInt(normalized.split(':')[1] || '0', 16) <= 0x1ff) return false
  return /^[23]/.test(normalized) && !normalized.startsWith('2001:db8:')
    && !normalized.startsWith('2002:') && !normalized.startsWith('3fff:')
}

export function secureWebhookTransport(): WebhookTransport {
  return { async post({ url, body, headers, timeoutMs }) {
    try {
      const target = new URL(url)
      if (target.protocol !== 'https:' || target.username || target.password || target.hash) return { error: 'endpoint_not_allowed' }
      const hostname = target.hostname.replace(/^\[|\]$/g, '')
      let resolutionTimer: ReturnType<typeof setTimeout> | undefined
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_resolve, reject) => { resolutionTimer = setTimeout(() => reject(new Error('resolution_timeout')), timeoutMs) }),
      ]).finally(() => { if (resolutionTimer) clearTimeout(resolutionTimer) })
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return { error: 'endpoint_not_public' }
      const selected = addresses[0]!
      // Pin the validated address for this connection, while retaining the
      // original hostname for TLS certificate verification. Never follow 3xx.
      return await new Promise<{ statusCode: number; body: string } | { error: string }>(resolve => {
        let finished = false
        const finish = (value: { statusCode: number; body: string } | { error: string }) => {
          if (!finished) { finished = true; clearTimeout(timer); resolve(value) }
        }
        const req = request(target, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
          lookup: (_name, _options, callback) => callback(null, selected.address, selected.family),
          agent: false,
        }, response => {
          let content = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => { content = (content + chunk).slice(0, 4096) })
          response.on('end', () => finish({ statusCode: response.statusCode ?? 502, body: content }))
          response.on('error', () => finish({ error: 'response_failed' }))
        })
        const timer = setTimeout(() => { finish({ error: 'timeout' }); req.destroy() }, timeoutMs)
        req.on('error', () => finish({ error: 'connection_failed' }))
        req.end(body)
      })
    } catch { return { error: 'endpoint_resolution_failed' } }
  } }
}

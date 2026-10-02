import { createHash } from 'node:crypto';
import { telegramSettings, sendTelegramInquiry, TelegramDeliveryError } from '../landing/server/telegram.mjs';

const MAX_BYTES = 12_000;
const EMAIL = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INTERESTS = new Set(['settlements', 'integration', 'partnership', 'investor']);
const VOLUMES = new Set(['evaluating', 'under-100k', '100k-1m', 'over-1m']);
const INTEREST_LABELS = { settlements: 'Settlement workflow', integration: 'API integration', partnership: 'Banking & liquidity partnership', investor: 'Investor information' };
const VOLUME_LABELS = { evaluating: 'Still evaluating', 'under-100k': 'Under $100k', '100k-1m': '$100k–$1m', 'over-1m': 'Over $1m' };
// A warm-instance guard, not a distributed limiter. Configure a deployment-level
// rate-limit rule on /api/contact before public launch (see landing/DEPLOY.md).
export function createContactHandler({ env = process.env, send = fetch, now = Date.now, report = event => console.error('[inquiry-delivery]', JSON.stringify(event)) } = {}) {
  const attempts = new Map();
  const telegramDeliveries = new Map();
  function configuration() {
    try {
      const site = new URL(env.SITE_URL);
      if (site.protocol !== 'https:' || site.username || site.password) return null;
      // Existing email installations keep working. Telegram takes priority when supplied.
      const channel = env.CONTACT_DELIVERY || (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID ? 'telegram' : 'email');
      if (channel === 'telegram') {
        const telegram = telegramSettings(env);
        return telegram ? { channel, origin: site.origin, telegram } : null;
      }
      return channel === 'email' && env.RESEND_API_KEY && env.CONTACT_FROM ? { channel, origin: site.origin } : null;
    } catch { return null; }
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
    const delivery = configuration();
    if (req.method === 'GET') return reply(200, delivery ? { available: true, channel: delivery.channel } : { available: false });
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return reply(405, { error: 'method_not_allowed' }); }
    if (!delivery) return reply(503, { error: 'delivery_unavailable' });
    if (req.headers.origin !== delivery.origin) return reply(403, { error: 'origin_not_allowed' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { error: 'json_required' });
    if (Number(req.headers['content-length'] || 0) > MAX_BYTES) return reply(413, { error: 'request_too_large' });
    let data;
    try {
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        if (Buffer.byteLength(req.body) > MAX_BYTES) return reply(413, { error: 'request_too_large' });
        data = JSON.parse(req.body.toString());
      } else if (req.body !== undefined) data = req.body;
      else {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > MAX_BYTES) return reply(413, { error: 'request_too_large' }); chunks.push(Buffer.from(chunk)); }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) return reply(413, { error: 'request_too_large' });
    } catch { return reply(400, { error: 'invalid_json' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return reply(400, { error: 'invalid_request' });
    if (data.website) return reply(400, { error: 'invalid_request' });
    for (const [key, max] of Object.entries({ name: 100, email: 254, company: 150, message: 2000 })) {
      if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > max) return reply(400, { error: 'invalid_fields' });
      data[key] = data[key].trim();
    }
    if (!EMAIL.test(data.email) || /[\r\n]/.test(data.name + data.company) || data.message.length < 10 || !INTERESTS.has(data.interest) || !VOLUMES.has(data.volume)) return reply(400, { error: 'invalid_fields' });
    if (data.context !== undefined && (typeof data.context !== 'string' || data.context.length > 2000)) return reply(400, { error: 'invalid_fields' });
    const requestId = req.headers['idempotency-key'];
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return reply(400, { error: 'invalid_request_id' });
    const ip = createHash('sha256').update(String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown')).digest('hex');
    const timestamp = now();
    for (const [key, value] of attempts) if (timestamp - value.since > 600_000) attempts.delete(key);
    for (const [key, value] of telegramDeliveries) if (!value.pending && timestamp - value.since > 600_000) telegramDeliveries.delete(key);
    const limit = attempts.get(ip) || { since: timestamp, count: 0 };
    if (limit.count >= 5 || (!attempts.has(ip) && attempts.size >= 5000)) { res.setHeader('Retry-After', '600'); return reply(429, { error: 'too_many_requests' }); }
    limit.count++; attempts.set(ip, limit);
    const text = `INRSETTLE WEBSITE INQUIRY\nReference: ${requestId}\n\nName: ${data.name}\nWork email: ${data.email}\nCompany: ${data.company}\nInterest: ${INTEREST_LABELS[data.interest]}\nExpected monthly volume: ${VOLUME_LABELS[data.volume]}\n\n${data.message}${data.context ? '\n\n' + data.context.trim() : ''}`;
    // The recipient is fixed; visitor-controlled values never choose delivery destinations.
    // Bind idempotency to the canonical message and supplied retry ID.
    const fingerprint = createHash('sha256').update(text).digest('hex');
    try {
      if (delivery.channel === 'telegram') {
        const key = createHash('sha256').update(`${delivery.telegram.token}/${delivery.telegram.chatId}/${requestId}/${fingerprint}`).digest('hex');
        if (!telegramDeliveries.has(key) && telegramDeliveries.size >= 5000) { res.setHeader('Retry-After', '600'); return reply(429, { error: 'too_many_requests' }); }
        const progress = telegramDeliveries.get(key) || { since: timestamp, nextPart: 0, pending: null };
        telegramDeliveries.set(key, progress);
        // Coalesce concurrent retries and resume acknowledged parts in this warm instance.
        // Telegram has no provider idempotency key; this is not cross-instance deduplication.
        if (!progress.pending) progress.pending = sendTelegramInquiry({ settings: delivery.telegram, text, requestId, progress, send, signal: AbortSignal.timeout(8000) }).finally(() => { progress.pending = null; });
        await progress.pending;
        return reply(202, { accepted: true });
      }
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `inquiry/${requestId}/${fingerprint}` },
        body: JSON.stringify({ from: env.CONTACT_FROM, to: ['info@inrsettle.com'], reply_to: data.email, subject: `INRSettle inquiry — ${data.company}`, text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return reply(502, { error: 'delivery_failed' });
      const result = await response.json();
      if (typeof result.id !== 'string' || !result.id) return reply(502, { error: 'delivery_failed' });
      // Provider acceptance is not an inbox-delivery guarantee.
      return reply(202, { accepted: true });
    } catch (error) {
      if (delivery.channel === 'telegram') {
        const failure = { channel: 'telegram', requestId, reason: 'request_failed' };
        if (error instanceof TelegramDeliveryError) {
          failure.reason = error.reason;
          if (error.providerStatus) failure.providerStatus = error.providerStatus;
        } else if (error?.name === 'TimeoutError' || error?.name === 'AbortError') failure.reason = 'request_timeout';
        // Logs stay useful to the owner without exposing the token, provider
        // response, recipient ID, URL, stack or the visitor's personal data.
        try { report(failure); } catch { /* Logging must not change the response. */ }
      }
      return reply(502, { error: 'delivery_failed' });
    }
  };
}
export default createContactHandler();

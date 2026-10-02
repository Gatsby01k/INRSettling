export const validTelegramToken = token => typeof token === 'string' && /^[1-9]\d{3,}:[A-Za-z0-9_-]{20,}$/.test(token);

export function telegramSettings(env) {
  const chatId = env.TELEGRAM_CHAT_ID;
  // This integration is for the owner's personal chat, never a visitor-supplied destination.
  if (!validTelegramToken(env.TELEGRAM_BOT_TOKEN) || !/^[1-9]\d{0,15}$/.test(chatId || '') || !Number.isSafeInteger(Number(chatId))) return null;
  return { token: env.TELEGRAM_BOT_TOKEN, chatId };
}

// Only fixed classifications leave this module. Never retain the provider's
// description, credential-bearing URL or submitted contact details in an error.
export class TelegramDeliveryError extends Error {
  constructor(reason, providerStatus) {
    super('delivery_failed');
    this.reason = reason;
    if (Number.isInteger(providerStatus) && providerStatus >= 400 && providerStatus <= 599) this.providerStatus = providerStatus;
  }
}

function rejected(status, result) {
  const code = Number.isInteger(result?.error_code) ? result.error_code : status;
  const description = typeof result?.description === 'string' ? result.description.toLowerCase() : '';
  let reason = 'provider_rejected';
  if (code === 401 || code === 404) reason = 'token_rejected';
  else if (code === 429) reason = 'provider_rate_limited';
  else if (code >= 500) reason = 'provider_unavailable';
  else if (code === 400 && description.includes('chat not found')) reason = 'chat_unavailable';
  else if (code === 403 && description.includes('blocked')) reason = 'bot_blocked';
  else if (code === 403 && description.includes("can't initiate conversation")) reason = 'chat_not_started';
  else if (code === 403) reason = 'chat_forbidden';
  return new TelegramDeliveryError(reason, code);
}

function messageParts(text) {
  const parts = [];
  while (text.length > 3500) {
    let end = text.lastIndexOf('\n', 3500);
    if (end < 1750) end = 3500;
    // Never cut a UTF-16 surrogate pair in half.
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

export async function sendTelegramInquiry({ settings, text, requestId, progress, send, signal }) {
  const parts = messageParts(text);
  for (let index = progress.nextPart; index < parts.length; index++) {
    const prefix = parts.length > 1 ? `INRSettle · ${requestId}\nPart ${index + 1}/${parts.length}\n\n` : '';
    const response = await send(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: settings.chatId, text: prefix + parts[index], link_preview_options: { is_disabled: true } }), signal,
    });
    let result;
    try { result = await response.json(); }
    catch { throw response.ok ? new TelegramDeliveryError('invalid_response') : rejected(response.status); }
    if (!response.ok || result?.ok !== true) throw rejected(response.status, result);
    if (!Number.isInteger(result.result?.message_id) || result.result.message_id <= 0) throw new TelegramDeliveryError('invalid_acknowledgement');
    if (String(result.result.chat?.id) !== settings.chatId || result.result.chat.type !== 'private') throw new TelegramDeliveryError('unexpected_recipient');
    progress.nextPart = index + 1;
  }
}

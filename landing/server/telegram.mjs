export const validTelegramToken = token => typeof token === 'string' && /^[1-9]\d{3,}:[A-Za-z0-9_-]{20,}$/.test(token);

export function telegramSettings(env) {
  const chatId = env.TELEGRAM_CHAT_ID;
  // This integration is for the owner's personal chat, never a visitor-supplied destination.
  if (!validTelegramToken(env.TELEGRAM_BOT_TOKEN) || !/^[1-9]\d{0,15}$/.test(chatId || '') || !Number.isSafeInteger(Number(chatId))) return null;
  return { token: env.TELEGRAM_BOT_TOKEN, chatId };
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
    if (!response.ok) throw new Error('delivery_failed');
    const result = await response.json();
    if (result.ok !== true || !Number.isInteger(result.result?.message_id) || result.result.message_id <= 0 || String(result.result.chat?.id) !== settings.chatId || result.result.chat.type !== 'private') throw new Error('delivery_failed');
    progress.nextPart = index + 1;
  }
}

// Read-only setup for the owner's personal chat. Never prints the bot token,
// message bodies, webhook URL or other users' identities; never deletes a webhook.
import { randomBytes } from 'node:crypto';
import { validTelegramToken } from '../server/telegram.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN;
const expectedBot = 'inrslead_bot';
const challenge = process.argv[2];
async function call(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok || data.ok !== true) throw new Error('telegram_unavailable');
  return data.result;
}

try {
  if (!validTelegramToken(token)) throw new Error('missing_token');
  if (challenge && !/^[a-f0-9]{12}$/.test(challenge)) throw new Error('invalid_challenge');
  const bot = await call('getMe');
  if (bot.username?.toLowerCase() !== expectedBot) throw new Error('wrong_bot');
  if (!challenge) {
    const code = randomBytes(6).toString('hex');
    console.log(`Откройте https://t.me/${expectedBot} и отправьте в личном чате:\n/start inrsettle-${code}\n\nЗатем выполните из корня проекта:\nnode --env-file=.env.local landing/scripts/telegram-chat.mjs ${code}`);
  } else {
    const webhook = await call('getWebhookInfo');
    if (webhook.url) throw new Error('existing_webhook');
    // No offset: do not acknowledge/discard the bot's queued updates.
    const updates = await call('getUpdates', { limit: 100, timeout: 0 });
    const chats = new Set(updates.filter(update => update.message?.chat.type === 'private' && update.message.text === `/start inrsettle-${challenge}`).map(update => String(update.message.chat.id)));
    if (chats.size !== 1) throw new Error(chats.size ? 'ambiguous_chat' : 'chat_not_found');
    console.log(`Добавьте в настройки сервера:\nTELEGRAM_CHAT_ID=${[...chats][0]}\n\nБот: @${expectedBot}. Тестовая заявка не отправлялась.`);
  }
} catch (error) {
  const messages = {
    missing_token: 'Добавьте TELEGRAM_BOT_TOKEN в .env.local или серверное окружение. Не вставляйте токен в команду или чат.',
    invalid_challenge: 'Код должен совпадать с 12 символами, показанными при первом запуске.',
    wrong_bot: 'Этот токен принадлежит другому боту. Нужен токен @inrslead_bot.',
    existing_webhook: 'У бота уже есть webhook. Получите свой chat.id в существующем обработчике бота. Его настройки не изменены.',
    ambiguous_chat: 'Команда найдена в нескольких чатах. Запустите настройку заново с новым кодом только в своём личном чате.',
    chat_not_found: 'Команда пока не найдена. Отправьте указанную команду в личном чате бота и повторите эту же команду настройки.',
  };
  console.error(messages[error.message] || 'Telegram не подтвердил запрос. Проверьте токен и доступ к API; секреты не выводились.');
  process.exitCode = 1;
}

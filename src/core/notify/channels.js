/**
 * Delivery channels for problem alerts. Plain text only; secrets never
 * appear in errors (the token / webhook URL is part of the request URL).
 */

const TIMEOUT_MS = 10_000;

export function telegramChannel({ token, chatId, fetchImpl = fetch }) {
  if (!token) throw new Error('No Telegram bot token: `npm run nyra -- secrets set telegram-bot <bot>`.');
  return {
    name: 'telegram',
    async send(text) {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(`Telegram: ${data.description ?? `HTTP ${response.status}`}`);
    },
  };
}

export function discordChannel({ url, fetchImpl = fetch }) {
  if (!url) throw new Error('No Discord webhook: `npm run nyra -- notify discord`.');
  assertDiscordWebhook(url);
  return {
    name: 'discord',
    async send(text) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No @everyone/@here pings from collected or error text.
        body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Discord: HTTP ${response.status}`);
    },
  };
}

export function assertDiscordWebhook(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The Discord webhook must be a URL.');
  }
  if (parsed.protocol !== 'https:' || !/^(?:canary\.|ptb\.)?discord(?:app)?\.com$/.test(parsed.hostname) ||
      !parsed.pathname.startsWith('/api/webhooks/')) {
    throw new Error('The Discord webhook must look like https://discord.com/api/webhooks/<id>/<token>.');
  }
}

/** Find chats that wrote to the bot, to fill telegram.chat_id. */
export async function telegramChatsOf(token, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(`Telegram: ${data.description ?? `HTTP ${response.status}`}`);
  const chats = new Map();
  for (const update of data.result ?? []) {
    const chat = update.message?.chat ?? update.channel_post?.chat ?? update.my_chat_member?.chat;
    if (chat?.id) chats.set(String(chat.id), { id: String(chat.id), type: chat.type, title: chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ?? chat.username });
  }
  return [...chats.values()];
}

import { TELEGRAM } from '../../config/app.config.js';
import { buildTelegramMessageUrl } from './TelegramMessageParser.js';

export class TelegramBotGateway {
  constructor({ token = TELEGRAM.botToken, fetchImpl = fetch } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async identity() {
    if (!this.token) return { transport: 'bot', configured: false, next_action: 'Set TELEGRAM_BOT_TOKEN in the local .env. Then call telegram_publisher_info to identify the bot username.' };
    const me = await this.#call('getMe');
    if (!me.is_bot) throw new Error('Telegram credentials do not identify a bot.');
    return { transport: 'bot', configured: true, bot_id: me.id, username: me.username, name: me.first_name };
  }

  async resolve(account) {
    const me = await this.identity();
    if (!me.configured) throw new Error(me.next_action);
    const chat = await this.#call('getChat', { chat_id: account.startsWith('-100') ? account : `@${account}` });
    if (chat.type !== 'channel') throw new Error('Publishing is supported only to broadcast Telegram channels.');
    const membership = await this.#call('getChatMember', { chat_id: chat.id, user_id: me.bot_id });
    if (membership.status !== 'creator' &&
        !(membership.status === 'administrator' && membership.can_post_messages === true)) {
      throw new Error(`Add @${me.username} as an administrator with permission to post messages in this Telegram channel.`);
    }
    return { id: chat.id, username: chat.username };
  }

  async send(target, draft) {
    const message = await this.#call('sendMessage', {
      chat_id: target.id, text: draft.text,
      link_preview_options: { is_disabled: Boolean(draft.disable_preview) },
    });
    if (!Number.isInteger(message.message_id) || message.message_id < 1 || String(message.chat?.id) !== String(target.id)) {
      throw new Error('Telegram returned an unrecognized publication receipt. Check the channel before any retry.');
    }
    return {
      channel_id: String(target.id), message_id: message.message_id,
      url: buildTelegramMessageUrl(target.username ?? String(target.id), String(message.message_id)),
      sent_at: new Date().toISOString(),
    };
  }

  async close() {}

  async #call(method, params = {}) {
    if (!this.token) throw new Error('TELEGRAM_BOT_TOKEN is not configured in the local .env.');
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params), signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const rejection = new Error(data.description ?? `HTTP ${response.status}`);
        // A Bot API answer with ok:false and a 4xx code is an explicit refusal:
        // the method was not executed. Timeouts and 5xx stay uncertain.
        rejection.notSent = data.ok === false && data.error_code >= 400 && data.error_code < 500;
        throw rejection;
      }
      return data.result;
    } catch (error) {
      // Fetch errors can include their URL, which contains the bot credential.
      const detail = String(error.message ?? 'Request failed').replaceAll(this.token, '[redacted]');
      const wrapped = new Error(`Telegram Bot API ${method} failed: ${detail}`);
      if (error.notSent) wrapped.notSent = true;
      throw wrapped;
    }
  }
}

/**
 * Minimal Discord REST client for reading channel messages with a bot token.
 * No Gateway connection: collection polls like the other platforms.
 *
 * The bot needs View Channel + Read Message History in each configured
 * channel, and the Message Content intent enabled in the Developer Portal.
 */

import { PKG } from '../../config/app.config.js';

const API = 'https://discord.com/api/v10';

export class DiscordError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

export class DiscordClient {
  /** @param {{ token: string, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} opts */
  constructor({ token, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!token) throw new DiscordError('No Discord bot token.', { code: 'DISCORD_TOKEN_MISSING' });
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  /** @returns {Promise<{ id: string, guild_id?: string, name?: string }>} */
  channel(channelId) {
    return this.#get(`/channels/${channelId}`);
  }

  /** Newest messages first, as Discord returns them. */
  messages(channelId, { after, limit = 100 } = {}) {
    const query = new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) });
    return this.#get(`/channels/${channelId}/messages?${query}`);
  }

  async #get(path, retried = false) {
    const response = await this.fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${this.token}`, 'User-Agent': `DiscordBot (https://github.com/SamuiRo/EANyra, ${PKG.version})` },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (response.status === 429 && !retried) {
      const body = await response.json().catch(() => ({}));
      await this.sleep(Math.min(Number(body.retry_after ?? 1), 10) * 1000);
      return this.#get(path, true);
    }
    if (response.status === 401) {
      throw new DiscordError('Discord rejected the bot token.', { status: 401, code: 'DISCORD_UNAUTHORIZED' });
    }
    if (response.status === 403) {
      throw new DiscordError('The bot cannot read this channel (needs View Channel and Read Message History).', { status: 403 });
    }
    if (response.status === 404) throw new DiscordError('Discord channel not found (check the channel id).', { status: 404 });
    if (!response.ok) throw new DiscordError(`Discord API error ${response.status}.`, { status: response.status });
    return response.json();
  }
}

/** A question worth answering in a post: a real sentence ending in or containing "?". */
export function isQuestion(text) {
  const clean = String(text ?? '').replace(/https?:\/\/\S+/g, '').trim();
  return clean.length >= 15 && clean.includes('?');
}

/**
 * Normalize one Discord message into a RawSignal, or null when it is not
 * material (bots, system messages, empty, filtered out).
 */
export function messageToSignal(message, { channelId, guildId, channelName, filter = 'questions' }) {
  if (!message || message.author?.bot || ![0, 19].includes(message.type ?? 0)) return null;
  const content = String(message.content ?? '').trim();
  if (!content) return null;
  const question = isQuestion(content);
  if (filter === 'questions' && !question) return null;
  const firstLine = content.split('\n')[0];
  return {
    source: 'discord',
    source_id: `${channelId}:${message.id}`,
    signal_type: question ? 'question' : 'community_message',
    title: firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine,
    body: content.slice(0, 4000),
    url: guildId ? `https://discord.com/channels/${guildId}/${channelId}/${message.id}` : null,
    occurred_at: message.timestamp ? new Date(message.timestamp) : null,
    metadata: {
      channel: channelName ?? null,
      // Display name only; no Discord user ids are stored.
      author: message.author?.global_name ?? message.author?.username ?? null,
      reactions: (message.reactions ?? []).reduce((sum, reaction) => sum + (reaction.count ?? 0), 0),
      reply: message.type === 19,
    },
    scraped_at: new Date(),
  };
}

/** Compare Discord snowflakes (decimal strings beyond Number precision). */
export function newerId(a, b) {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

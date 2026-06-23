import { TELEGRAM } from '../../config/app.config.js';
import { print } from '../../shared/utils.js';
import { TelegramClient } from './TelegramClient.js';
import {
  isTelegramContentMessage,
  normalizeTelegramChannel,
  normalizeTelegramDate,
  parseTelegramMessage,
} from './TelegramMessageParser.js';

export class TelegramScraper {
  constructor({ client = new TelegramClient(), config = TELEGRAM } = {}) {
    this.clientManager = client;
    this.config        = config;
    this.client        = null;
  }

  async connect() {
    if (!this.client) {
      this.client = await this.clientManager.connect();
    }
    return this.client;
  }

  async disconnect() {
    await this.clientManager.disconnect?.();
    this.client = null;
  }

  /**
   * Poll a Telegram channel once and return normalized RawPost objects.
   *
   * @param {string} username Telegram public channel username or channel id.
   * @param {{ since?: Date|string|number|null, initialLimit?: number }} opts
   */
  async scrapeAccount(username, { since = null, initialLimit = null } = {}) {
    const channel = normalizeTelegramChannel(username);
    const client  = await this.connect();

    print(`[Telegram] Polling ${formatChannel(channel)}`, 'info');

    const sinceDate = applyOverlap(since, this.config.overlapMinutes);
    const messages  = sinceDate
      ? await this.#fetchMessagesSince(client, channel, sinceDate)
      : await this.#fetchLatestMessages(
        client,
        channel,
        initialLimit ?? this.config.initialPostsPerAccount,
      );
    const posts     = messages
      .map(message => parseTelegramMessage(message, { username: channel }))
      .filter(Boolean);

    const mode = sinceDate ? 'new candidate' : 'initial';
    print(`[Telegram] ${formatChannel(channel)}: ${posts.length} ${mode} post(s).`, 'data');
    return posts;
  }

  async #fetchMessagesSince(client, channel, sinceDate) {
    const fetchLimit = positiveInt(this.config.fetchLimit, 100);
    const maxPages   = positiveInt(this.config.maxPagesPerAccount, 20);
    const collected  = new Map();

    let offsetId = 0;

    for (let page = 0; page < maxPages; page++) {
      const options = { limit: fetchLimit };
      if (offsetId > 0) options.offsetId = offsetId;

      const messages = await this.#getMessagesPage(client, channel, options);
      if (!messages.length) break;

      let oldestId = null;
      let reachedBoundary = false;

      for (const message of messages) {
        const numericId = Number(message.id);
        if (Number.isFinite(numericId)) {
          oldestId = oldestId === null ? numericId : Math.min(oldestId, numericId);
        }

        const postedAt = normalizeTelegramDate(message.date);
        if (sinceDate && postedAt && postedAt <= sinceDate) {
          reachedBoundary = true;
          continue;
        }
        if (sinceDate && !postedAt) continue;
        if (!isTelegramContentMessage(message)) continue;

        collected.set(String(message.id), message);
      }

      if (messages.length < fetchLimit || reachedBoundary || oldestId === null) break;
      if (oldestId === offsetId) break;
      offsetId = oldestId;
    }

    return [...collected.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  async #fetchLatestMessages(client, channel, target) {
    const fetchLimit  = positiveInt(this.config.fetchLimit, 100);
    const maxPages    = positiveInt(this.config.maxPagesPerAccount, 20);
    const targetCount = positiveInt(target, 20);
    const collected   = new Map();

    let offsetId = 0;

    for (let page = 0; page < maxPages; page++) {
      const options = { limit: fetchLimit };
      if (offsetId > 0) options.offsetId = offsetId;

      const messages = await this.#getMessagesPage(client, channel, options);
      if (!messages.length) break;

      let oldestId = null;

      for (const message of messages) {
        const numericId = Number(message.id);
        if (Number.isFinite(numericId)) {
          oldestId = oldestId === null ? numericId : Math.min(oldestId, numericId);
        }

        if (!isTelegramContentMessage(message)) continue;
        collected.set(String(message.id), message);
      }

      if (collected.size >= targetCount || messages.length < fetchLimit || oldestId === null) break;
      if (oldestId === offsetId) break;
      offsetId = oldestId;
    }

    return [...collected.values()]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(-targetCount);
  }

  async #getMessagesPage(client, channel, options) {
    const result = await client.getMessages(channel, options);
    return Array.from(result ?? []).filter(Boolean);
  }
}

function applyOverlap(since, minutes) {
  const sinceDate = normalizeTelegramDate(since);
  if (!sinceDate) return null;

  const overlapMs = nonNegativeInt(minutes, 0) * 60_000;
  return new Date(sinceDate.getTime() - overlapMs);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function formatChannel(channel) {
  return channel.startsWith('-') ? channel : `@${channel}`;
}

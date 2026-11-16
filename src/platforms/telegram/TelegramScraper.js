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
   * Kept for callers that do not track backfill; see collect().
   *
   * @param {string} username Telegram public channel username or channel id.
   * @param {{ since?: Date|string|number|null, initialLimit?: number }} opts
   */
  async scrapeAccount(username, opts = {}) {
    return (await this.collect(username, opts)).posts;
  }

  /**
   * Poll a channel and continue an unfinished backfill.
   *
   * A run reads newest-first and stops at the previous boundary. When the
   * page cap (maxPagesPerAccount) is hit first, the older unread interval is
   * returned as `backfill` ({ since, before_id }) instead of being skipped.
   * Passing it back on the next run reads that interval from before_id down
   * to since. Several gaps merge into one interval; re-reading collected
   * messages is harmless because posts are upserted.
   *
   * @param {string} username
   * @param {{ since?: Date|string|number|null, initialLimit?: number,
   *           backfill?: { since: string, before_id: number } | null }} opts
   * @returns {Promise<{ posts: object[], complete: boolean,
   *                     backfill: { since: string, before_id: number } | null }>}
   */
  async collect(username, { since = null, initialLimit = null, backfill = null } = {}) {
    const channel = normalizeTelegramChannel(username);
    const client  = await this.connect();

    print(`[Telegram] Polling ${formatChannel(channel)}`, 'info');

    const sinceDate = applyOverlap(since, this.config.overlapMinutes);
    const collected = new Map();
    let newGap = null;

    if (sinceDate) {
      const recent = await this.#fetchRange(client, channel, { sinceDate, beforeId: 0 });
      for (const message of recent.messages) collected.set(String(message.id), message);
      if (!recent.complete) newGap = { since: sinceDate.toISOString(), before_id: recent.oldestId };
    } else {
      const latest = await this.#fetchLatestMessages(client, channel, initialLimit ?? this.config.initialPostsPerAccount);
      for (const message of latest) collected.set(String(message.id), message);
    }

    let oldGap = validBackfill(backfill);
    if (oldGap) {
      print(`[Telegram] ${formatChannel(channel)}: continuing backfill before #${oldGap.before_id}`, 'system');
      const older = await this.#fetchRange(client, channel, {
        sinceDate: new Date(oldGap.since), beforeId: oldGap.before_id,
      });
      for (const message of older.messages) collected.set(String(message.id), message);
      oldGap = older.complete ? null : { since: oldGap.since, before_id: older.oldestId };
    }

    // One interval covers both gaps: from the newest unread id down to the
    // oldest unread date.
    const pending = newGap || oldGap ? {
      since: oldGap?.since ?? newGap.since,
      before_id: newGap?.before_id ?? oldGap.before_id,
    } : null;

    const posts = [...collected.values()]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(message => parseTelegramMessage(message, { username: channel }))
      .filter(Boolean);

    const mode = sinceDate ? 'new candidate' : 'initial';
    print(`[Telegram] ${formatChannel(channel)}: ${posts.length} ${mode} post(s).`, 'data');
    if (pending) {
      print(`[Telegram] ${formatChannel(channel)}: older messages before #${pending.before_id} remain; they will be read on the next run.`, 'warning');
    }
    return { posts, complete: !pending, backfill: pending };
  }

  /**
   * Read newest-first from beforeId (0 = newest) until sinceDate.
   * complete = the boundary or the start of the channel was reached.
   */
  async #fetchRange(client, channel, { sinceDate, beforeId }) {
    const fetchLimit = positiveInt(this.config.fetchLimit, 100);
    const maxPages   = positiveInt(this.config.maxPagesPerAccount, 20);
    const collected  = [];

    let offsetId = beforeId > 0 ? beforeId : 0;
    let oldestId = null;

    for (let page = 0; page < maxPages; page++) {
      const options = { limit: fetchLimit };
      if (offsetId > 0) options.offsetId = offsetId;

      const messages = await this.#getMessagesPage(client, channel, options);
      if (!messages.length) return { messages: collected, complete: true, oldestId };

      let pageOldest = null;
      let reachedBoundary = false;

      for (const message of messages) {
        const numericId = Number(message.id);
        if (Number.isFinite(numericId)) {
          pageOldest = pageOldest === null ? numericId : Math.min(pageOldest, numericId);
        }

        const postedAt = normalizeTelegramDate(message.date);
        if (postedAt && postedAt <= sinceDate) {
          reachedBoundary = true;
          continue;
        }
        if (!postedAt) continue;
        if (!isTelegramContentMessage(message)) continue;

        collected.push(message);
      }

      if (pageOldest !== null) oldestId = pageOldest;
      if (messages.length < fetchLimit || reachedBoundary || pageOldest === null) {
        return { messages: collected, complete: true, oldestId };
      }
      if (pageOldest === offsetId) return { messages: collected, complete: true, oldestId };
      offsetId = pageOldest;
    }

    // Page cap reached before the boundary: the rest is still unread.
    return { messages: collected, complete: false, oldestId };
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

function validBackfill(value) {
  if (!value || typeof value !== 'object') return null;
  const since = new Date(value.since);
  const beforeId = Number(value.before_id);
  if (Number.isNaN(since.getTime()) || !Number.isInteger(beforeId) || beforeId < 1) return null;
  return { since: since.toISOString(), before_id: beforeId };
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

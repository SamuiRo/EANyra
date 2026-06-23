import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramScraper } from '../src/platforms/telegram/TelegramScraper.js';
import {
  buildTelegramMessageUrl,
  normalizeTelegramChannel,
  normalizeTelegramDate,
  parseTelegramMessage,
} from '../src/platforms/telegram/TelegramMessageParser.js';

test('parses Telegram messages into RawPost records', () => {
  const post = parseTelegramMessage({
    id:       42,
    message:  'Launch notes https://example.com',
    date:     1_718_000_000,
    views:    120,
    forwards: 7,
    replies:  { replies: 3 },
    reactions: {
      results: [{ count: 5 }, { count: 2 }],
    },
    entities: [{
      className: 'MessageEntityUrl',
      offset:    13,
      length:    19,
    }],
  }, { username: '@Example_Channel' });

  assert.equal(post.platform, 'telegram');
  assert.equal(post.platform_id, 'example_channel:42');
  assert.equal(post.text, 'Launch notes https://example.com');
  assert.equal(post.shared_url, 'https://example.com');
  assert.equal(post.raw_url, 'https://t.me/example_channel/42');
  assert.equal(post.likes, 7);
  assert.equal(post.reposts, 7);
  assert.equal(post.replies, 3);
  assert.equal(post.views, 120);
  assert.equal(post.visibility, 'public');
  assert.equal(post.posted_at.toISOString(), '2024-06-10T06:13:20.000Z');
});

test('normalizes Telegram channels and message URLs', () => {
  assert.equal(normalizeTelegramChannel('@My_Channel'), 'my_channel');
  assert.equal(normalizeTelegramChannel('https://t.me/s/My_Channel'), 'my_channel');
  assert.equal(normalizeTelegramChannel('https://t.me/c/123456789/10'), '-100123456789');
  assert.equal(buildTelegramMessageUrl('-100123456789', '10'), 'https://t.me/c/123456789/10');
  assert.equal(normalizeTelegramDate(1_718_000_000).toISOString(), '2024-06-10T06:13:20.000Z');
});

test('Telegram scraper initial run imports the latest configured posts', async () => {
  const manager = new MockTelegramClient([
    [
      { id: 4, message: 'latest', date: new Date('2026-06-23T10:00:00Z') },
      { id: 3, message: 'previous', date: new Date('2026-06-23T09:00:00Z') },
    ],
  ]);
  const scraper = new TelegramScraper({
    client: manager,
    config: {
      fetchLimit: 2,
      initialPostsPerAccount: 2,
      maxPagesPerAccount: 5,
      overlapMinutes: 0,
    },
  });

  const posts = await scraper.scrapeAccount('example');

  assert.deepEqual(posts.map(post => post.platform_id), ['example:3', 'example:4']);
  assert.deepEqual(manager.calls, [{
    channel: 'example',
    options: { limit: 2 },
  }]);
});

test('Telegram scraper returns only messages newer than the scrape boundary', async () => {
  const manager = new MockTelegramClient([
    [
      { id: 4, message: 'newer', date: new Date('2026-06-23T09:00:00Z') },
      { id: 3, message: 'new', date: new Date('2026-06-23T08:00:00Z') },
    ],
    [
      { id: 2, message: 'old', date: new Date('2026-06-22T23:00:00Z') },
      { id: 1, message: 'older', date: new Date('2026-06-22T22:00:00Z') },
    ],
  ]);
  const scraper = new TelegramScraper({
    client: manager,
    config: { fetchLimit: 2, maxPagesPerAccount: 5, overlapMinutes: 0 },
  });

  const posts = await scraper.scrapeAccount('example', {
    since: new Date('2026-06-23T00:00:00Z'),
  });

  assert.deepEqual(posts.map(post => post.platform_id), ['example:3', 'example:4']);
  assert.deepEqual(manager.calls.map(call => call.options), [
    { limit: 2 },
    { limit: 2, offsetId: 3 },
  ]);
});

class MockTelegramClient {
  constructor(pages) {
    this.pages = [...pages];
    this.calls = [];
  }

  async connect() {
    return {
      getMessages: async (channel, options) => {
        this.calls.push({ channel, options });
        return this.pages.shift() ?? [];
      },
    };
  }

  async disconnect() {}
}

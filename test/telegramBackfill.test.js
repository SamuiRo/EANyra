import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramScraper } from '../src/platforms/telegram/TelegramScraper.js';

const BASE = Date.parse('2026-11-01T00:00:00Z');
const at = id => new Date(BASE + id * 3600_000);

/** A channel with messages 1..count, served newest-first like GramJS. */
function channel(count) {
  const messages = Array.from({ length: count }, (_, i) => ({ id: i + 1, message: `post ${i + 1}`, date: at(i + 1) }));
  const calls = [];
  const client = {
    async getMessages(_channel, { limit, offsetId = 0 }) {
      calls.push(offsetId);
      return messages.filter(m => !offsetId || m.id < offsetId).sort((a, b) => b.id - a.id).slice(0, limit);
    },
  };
  return {
    calls,
    add(n) {
      const start = messages.length;
      for (let i = 1; i <= n; i++) messages.push({ id: start + i, message: `post ${start + i}`, date: at(start + i) });
    },
    scraper: new TelegramScraper({
      client: { connect: async () => client, disconnect: async () => {} },
      config: { fetchLimit: 5, maxPagesPerAccount: 2, overlapMinutes: 0 },
    }),
  };
}

const ids = posts => posts.map(post => Number(post.platform_id.split(':')[1]));

test('a backlog larger than the page cap is resumed on later runs without losing messages', async () => {
  const ch = channel(30);
  const seen = new Set();

  // Watermark at message 5; 25 new messages but only 2 pages × 5 per run.
  const first = await ch.scraper.collect('example', { since: at(5) });
  assert.deepEqual(ids(first.posts), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  assert.equal(first.complete, false);
  assert.deepEqual(first.backfill, { since: at(5).toISOString(), before_id: 21 });
  ids(first.posts).forEach(id => seen.add(id));

  // Watermark advanced to message 30; the gap continues from #21.
  const second = await ch.scraper.collect('example', { since: at(30), backfill: first.backfill });
  assert.deepEqual(ids(second.posts), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(second.backfill, { since: at(5).toISOString(), before_id: 11 });
  ids(second.posts).forEach(id => seen.add(id));

  const third = await ch.scraper.collect('example', { since: at(30), backfill: second.backfill });
  assert.deepEqual(ids(third.posts), [6, 7, 8, 9, 10]);
  assert.equal(third.complete, true);
  assert.equal(third.backfill, null);
  ids(third.posts).forEach(id => seen.add(id));

  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 6));
});

test('a new gap and an old gap merge into one interval', async () => {
  const ch = channel(30);
  const first = await ch.scraper.collect('example', { since: at(5) });   // gap: (5, 21)
  ch.add(15);                                                            // 31..45 arrive
  const second = await ch.scraper.collect('example', { since: at(30), backfill: first.backfill });
  // New messages 36..45 read; 31..35 unread (new gap); old gap advanced to before #11.
  assert.ok(ids(second.posts).includes(45));
  // Merged: newest unread id from the new gap, oldest unread date from the old gap.
  assert.deepEqual(second.backfill, { since: at(5).toISOString(), before_id: 36 });
  // Draining the merged interval reaches every message down to the old boundary.
  let state = second.backfill;
  const seen = new Set([...ids(first.posts), ...ids(second.posts)]);
  for (let run = 0; run < 10 && state; run++) {
    const next = await ch.scraper.collect('example', { since: at(45), backfill: state });
    ids(next.posts).forEach(id => seen.add(id));
    state = next.backfill;
  }
  assert.equal(state, null);
  for (let id = 6; id <= 45; id++) assert.ok(seen.has(id), `message ${id} was lost`);
});

test('invalid stored checkpoints are ignored and scrapeAccount keeps returning posts', async () => {
  const ch = channel(3);
  const result = await ch.scraper.collect('example', { since: at(1), backfill: { since: 'nonsense', before_id: -1 } });
  assert.deepEqual(ids(result.posts), [2, 3]);
  assert.equal(result.backfill, null);
  assert.deepEqual(ids(await ch.scraper.scrapeAccount('example', { since: at(2) })), [3]);
});

test('the Telegram collector persists the checkpoint and reports incomplete runs', async t => {
  const { Sequelize } = await import('sequelize');
  const { SchemaMigrator } = await import('../src/core/teapot/SchemaMigrator.js');
  const { registerModels } = await import('../src/core/teapot/models/index.js');
  const { SourceStateRepository } = await import('../src/core/teapot/repositories/SourceStateRepository.js');
  const { COLLECTORS } = await import('../src/platforms/collectors.js');
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const state = new SourceStateRepository(sequelize);
  const ch = channel(30);
  const account = { id: 1, username: 'example', last_scraped_at: at(5) };
  const collect = () => COLLECTORS.telegram.collect({
    account, session: 'default',
    runtime: { telegramScraper: async () => ch.scraper },
    repos: { stateRepo: state, postRepo: { newestPostDate: async () => null } },
  });

  const first = await collect();
  assert.match(first.warning, /Incomplete: older messages before #21/);
  assert.deepEqual(JSON.parse(await state.get('telegram_backfill', 'example')), { since: at(5).toISOString(), before_id: 21 });
  account.last_scraped_at = first.scrapedAt;

  await collect();
  const last = await collect();
  assert.equal(last.warning, undefined);
  assert.equal(await state.get('telegram_backfill', 'example'), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Sequelize } from 'sequelize';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { ContentService } from '../src/core/services/ContentService.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';
import { platformIdFromUrl } from '../src/core/services/draftLinks.js';
import { validateAccounts, parseAccountRef } from '../src/config/accountConfig.js';
import { PLATFORM_CATALOG, MANUAL_METRICS_PLATFORMS } from '../src/platforms/catalog.js';
import { COLLECTORS } from '../src/platforms/collectors.js';

const ACCOUNTS = [
  { platform: 'threads', username: 'example.handle' },
  { platform: 'threads', username: 'example_other' },
  { platform: 'twitter', username: 'example_public' },
];

test('Threads is a manual platform: accounts with dots, drafts, no collector numbers', async () => {
  assert.deepEqual(PLATFORM_CATALOG.threads, {
    id: 'threads', displayName: 'Threads', output: 'posts', session: null,
    collection: PLATFORM_CATALOG.threads.collection, publishing: 'manual', metrics: 'manual',
  });
  assert.deepEqual(MANUAL_METRICS_PLATFORMS, ['threads']);
  assert.deepEqual(parseAccountRef('threads/@Example.Handle'), { platform: 'threads', username: 'example.handle' });
  assert.throws(() => parseAccountRef('twitter/example.handle'), /Invalid twitter username/);
  assert.throws(() => validateAccounts([{ platform: 'threads', username: 'example', publish_enabled: true }]), /publishing is supported only for Telegram/);
  assert.deepEqual(await COLLECTORS.threads.collect({}), { records: [], keepWatermark: true });
  assert.equal(platformIdFromUrl('threads', 'https://www.threads.net/@example.handle/post/DAbc_12-x?xmt=1'), 'DAbc_12-x');
  assert.equal(platformIdFromUrl('threads', 'https://www.threads.com/@example.handle/post/C9z'), 'C9z');
  assert.equal(platformIdFromUrl('threads', 'https://www.threads.net/@example.handle'), null);
});

async function service(t, personas) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const db = sequelizeExecutor(sequelize);
  const content = new ContentService(db, {
    loadAccounts: async () => validateAccounts(ACCOUNTS), loadPersonas: async () => personas,
    loadGlobalContext: async () => ({ projects: [] }),
  });
  return { db, content };
}

const persona = (slug, accounts, extra = {}) => ({
  slug, name: slug, disclosure: 'public', linked_to: [], projects: [], voice: {}, bio: {},
  platforms: { threads: { posting_frequency: '4 posts per week' } }, accounts, ...extra,
});

test('a Threads draft is published by hand and its numbers are entered and updated', async t => {
  const { db, content } = await service(t, [
    persona('example-public', [{ platform: 'threads', username: 'example.handle' }, { platform: 'twitter', username: 'example_public' }]),
  ]);
  const draft = await content.createDraft({ platform: 'threads', account: 'threads/example.handle', text: 'A useful find', signal_ids: [] });
  assert.equal(draft.persona, 'example-public');
  await assert.rejects(content.createDraft({ platform: 'threads', account: 'example.handle', text: 'x'.repeat(501) }), /longer than 500/);

  const plan = await content.contentPlan({ persona: 'example-public' });
  const item = plan.personas[0].accounts.find(entry => entry.account === 'threads/example.handle');
  assert.equal(item.publishing, 'manual');
  assert.equal(item.status, 'due');
  assert.match(item.data_warning, /post_metrics_record/);

  const url = 'https://www.threads.net/@example.handle/post/DExample1';
  const first = await content.recordPostMetrics({
    platform: 'threads', account: 'example.handle', url, draft_id: draft.id, likes: 4, replies: 1, views: 120,
  });
  assert.equal(first.updated, false);
  assert.deepEqual([first.post.text, first.post.likes, first.post.reposts, first.post.views], ['A useful find', 4, 0, 120]);
  assert.deepEqual(first.draft, { id: draft.id, status: 'published' }, 'the draft is marked published and linked');
  assert.equal((await content.getDraft(draft.id)).published_url, url);

  const second = await content.recordPostMetrics({ platform: 'threads', account: 'threads/example.handle', url: `${url}?xmt=abc`, likes: 9, views: 300 });
  assert.equal(second.updated, true);
  assert.deepEqual([second.post.likes, second.post.replies, second.post.views], [9, 1, 300], 'omitted numbers stay as they were');
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM posts WHERE platform = 'threads'")).n), 1);

  const after = (await content.contentPlan({ persona: 'example-public' })).personas[0].accounts.find(entry => entry.account === 'threads/example.handle');
  assert.equal(after.posts_last_7_days, 1);
  assert.equal(after.status, 'on_track');
  assert.equal((await content.performance({ persona: 'example-public', platform: 'threads' })).published, 1);
});

test('manual numbers are refused for collected platforms, bad input and the wrong persona', async t => {
  const { content } = await service(t, [
    persona('example-public', [{ platform: 'threads', username: 'example.handle' }]),
    persona('example-hidden', [{ platform: 'threads', username: 'example_other' }], { disclosure: 'isolated' }),
  ]);
  const url = 'https://www.threads.net/@example.handle/post/DExample2';
  await assert.rejects(content.recordPostMetrics({ platform: 'twitter', account: 'example_public', url: 'https://x.com/a/status/1' }),
    /collected automatically; manual entry is for: threads/);
  await assert.rejects(content.recordPostMetrics({ platform: 'threads', account: 'example.handle', url: 'https://example.com/x' }),
    /not a Threads post URL/);
  await assert.rejects(content.recordPostMetrics({ platform: 'threads', account: 'example.handle', url, likes: -1 }), /likes must be a whole number/);
  await assert.rejects(content.recordPostMetrics({ platform: 'threads', account: 'example_ghost', url }), /not a configured account/);
  await assert.rejects(content.recordPostMetrics({ platform: 'threads', account: 'example_other', persona: 'example-public', url }),
    /belongs to another persona, not "example-public"/);
  const hiddenDraft = await content.createDraft({ platform: 'threads', account: 'example_other', text: 'Other' });
  await assert.rejects(content.recordPostMetrics({ platform: 'threads', account: 'example.handle', url, draft_id: hiddenDraft.id }),
    /is for threads\/example_other, not threads\/example.handle/);
  await content.recordPostMetrics({ platform: 'threads', account: 'example.handle', url });
  await assert.rejects(content.recordPostMetrics({ platform: 'threads', account: 'example_other', url }), /already recorded for another account/);
});

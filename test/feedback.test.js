import assert from 'node:assert/strict';
import test from 'node:test';
import { Sequelize } from 'sequelize';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { ContentService } from '../src/core/services/ContentService.js';
import { linkPublishedDrafts, platformIdFromUrl } from '../src/core/services/draftLinks.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';
import { SourceStateRepository } from '../src/core/teapot/repositories/SourceStateRepository.js';
import { SignalRepository } from '../src/core/teapot/repositories/SignalRepository.js';
import { COLLECTORS } from '../src/platforms/collectors.js';
import { validateAccounts } from '../src/config/accountConfig.js';
import { buildMarkdown } from '../src/core/export/MarkdownExporter.js';
import { LinkedinImporter } from '../src/platforms/linkedin/LinkedinImporter.js';

const NOW = new Date('2026-11-18T12:00:00Z');
const DAY = 864e5;

async function database(t) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  return { sequelize, models };
}

test('published URLs map to the platform ids collectors store', () => {
  assert.equal(platformIdFromUrl('twitter', 'https://x.com/brand_x/status/1790000000000000001?s=20'), '1790000000000000001');
  assert.equal(platformIdFromUrl('twitter', 'https://twitter.com/brand_x/statuses/42'), '42');
  assert.equal(platformIdFromUrl('telegram', 'https://t.me/Brand_Channel/15'), 'brand_channel:15');
  assert.equal(platformIdFromUrl('telegram', 'https://t.me/c/1234567890/7'), '-1001234567890:7');
  assert.equal(platformIdFromUrl('linkedin', 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7100000000000000000'), '7100000000000000000');
  assert.equal(platformIdFromUrl('linkedin', 'https://www.linkedin.com/feed/update/urn:li:activity:1/'), null);
  assert.equal(platformIdFromUrl('twitter', 'https://x.com/home'), null);
  assert.equal(platformIdFromUrl('twitter', null), null);
});

test('published drafts link to collected posts and report engagement vs. the account median', async t => {
  const { sequelize, models } = await database(t);
  const accounts = validateAccounts([{ username: 'brand_x', platform: 'twitter' }, { username: 'brand_tg', platform: 'telegram' }]);
  const personas = [{ slug: 'brand', name: 'Brand', accounts: [{ platform: 'twitter', username: 'brand_x' }], voice: {}, bio: {}, platforms: {}, projects: null }];
  const content = new ContentService(sequelizeExecutor(sequelize), {
    loadAccounts: async () => accounts, loadPersonas: async () => personas, loadGlobalContext: async () => ({}), now: () => NOW,
  });
  const x = await models.Account.create({ username: 'brand_x', platform: 'twitter' });
  // Typical posts score 10; median 10.
  for (let i = 0; i < 3; i++) {
    await models.Post.create({ account_id: x.id, platform: 'twitter', platform_id: `old${i}`, text: 't', likes: 10, posted_at: new Date(NOW - (5 + i) * DAY) });
  }
  const release = await models.Signal.create({ source: 'github', source_id: 'r', signal_type: 'release', title: 'v3' });
  const idea = await content.addSignal({ title: 'Local-first', persona: 'brand' });

  const hit = await content.createDraft({ platform: 'twitter', account: 'brand_x', text: 'Release post', signal_ids: [release.id] });
  const flop = await content.createDraft({ platform: 'twitter', account: 'brand_x', text: 'Idea post', signal_ids: [idea.id] });
  const pending = await content.createDraft({ platform: 'twitter', account: 'brand_x', text: 'Not collected yet' });
  await content.markPublished(hit.id, { url: 'https://x.com/brand_x/status/900' });
  await content.markPublished(flop.id, { url: 'https://x.com/brand_x/status/901' });
  await content.markPublished(pending.id, { url: 'https://x.com/brand_x/status/902' });
  const manual = await content.createDraft({ platform: 'twitter', account: 'brand_x', text: 'Mine', created_by: 'user' });
  await content.markPublished(manual.id, { url: 'https://x.com/brand_x/status/903' });

  // Collection later picks the posts up.
  await models.Post.create({ account_id: x.id, platform: 'twitter', platform_id: '900', text: 'Release post', likes: 20, reposts: 5, replies: 2, posted_at: NOW });
  await models.Post.create({ account_id: x.id, platform: 'twitter', platform_id: '901', text: 'Idea post', likes: 4, posted_at: NOW });
  await models.Post.create({ account_id: x.id, platform: 'twitter', platform_id: '903', text: 'Mine', likes: 10, posted_at: NOW });
  assert.equal(await linkPublishedDrafts(sequelizeExecutor(sequelize)), 3);
  assert.equal(await linkPublishedDrafts(sequelizeExecutor(sequelize)), 0);

  const linked = await content.getDraft(hit.id);
  assert.deepEqual({ likes: linked.post.likes, score: linked.post.score }, { likes: 20, score: 32 });

  const perf = await content.performance({ days: 30 });
  assert.equal(perf.published, 4);
  assert.equal(perf.measured, 3);
  // Account median over 6 posts (10,10,10,32,4,10) = 10.
  assert.deepEqual(perf.drafts.map(d => [d.id, d.vs_median]), [[hit.id, 3.2], [manual.id, 1], [flop.id, 0.4]]);
  assert.deepEqual(perf.by_signal_type, { 'github/release': { drafts: 1, median_vs_account: 3.2 }, 'note/idea': { drafts: 1, median_vs_account: 0.4 } });
  assert.equal(perf.by_author.ai.median_vs_account, 1.8);
  assert.equal(perf.by_author.author.median_vs_account, 1);
  assert.deepEqual(perf.not_yet_collected.map(d => d.id), [pending.id]);
  assert.equal((await content.performance({ platform: 'telegram' })).published, 0);
});

test('the first README sha is persisted, so the next change becomes a signal', async t => {
  const { sequelize, models } = await database(t);
  const state = new SourceStateRepository(sequelize);
  let sha = 'sha-1';
  let pushedAt = '2020-01-01T00:00:00Z';   // quiet repository: outside the lookback window
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    const body = path.endsWith('/repos') ? [{ name: 'tool', full_name: 'dev/tool', created_at: '2020-01-01T00:00:00Z', pushed_at: pushedAt }]
      : path.endsWith('/readme') ? { sha, html_url: 'https://github.com/dev/tool#readme' }
        : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const account = await models.Account.create({ username: 'dev', platform: 'github' });
  const collect = () => COLLECTORS.github.collect({
    account, session: 'default',
    runtime: { credentials: { githubToken: () => 'token' } },
    repos: { signalRepo: new SignalRepository(models.Signal), stateRepo: state },
  });

  assert.deepEqual((await collect()).records, []);
  assert.deepEqual(await state.getAll('github_readme', 'dev/'), { 'dev/tool': 'sha-1' });
  assert.deepEqual((await collect()).records, []);
  // A push changes the README.
  sha = 'sha-2';
  pushedAt = new Date().toISOString();
  const { records } = await collect();
  assert.equal(records.length, 1);
  assert.equal(records[0].signal_type, 'readme_change');
  assert.deepEqual(records[0].metadata, { repo: 'tool', prev_sha: 'sha-1', new_sha: 'sha-2' });
  assert.deepEqual(await state.getAll('github_readme', 'dev/'), { 'dev/tool': 'sha-2' });
  assert.deepEqual(await state.getAll('github_readme', 'other/'), {});
});

test('exports keep the example post, posting frequency and platform avoid rules', () => {
  const md = buildMarkdown({
    context: {
      voice: { tone: 'calm', example_post: 'First line\nSecond line' },
      platforms: { twitter: { posting_frequency: '3/week', avoid: ['hype', 'threads'] }, telegram: { frequency: 'weekly' } },
    },
    posts: [], signals: [], sections: ['context'], generatedAt: NOW, options: {},
  });
  assert.match(md, /> First line\n> Second line/);
  assert.match(md, /Posting frequency:\*\* 3\/week/);
  assert.match(md, /Posting frequency:\*\* weekly/);
  assert.match(md, /Avoid:\*\* hype, threads/);
});

test('LinkedIn import keeps the media URL of a share', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-li-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'Shares.csv'),
    'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\r\n' +
    '2026-11-01 10:00:00,https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123,Hello,,https://media.licdn.com/img.jpg,MEMBER_NETWORK\r\n');
  const [post] = await new LinkedinImporter(dir).scrapeAccount('me');
  assert.equal(post.platform_id, '123');
  assert.deepEqual(post.media_urls, ['https://media.licdn.com/img.jpg']);
});

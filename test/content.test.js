import assert from 'node:assert/strict';
import test from 'node:test';
import { Sequelize } from 'sequelize';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { ContentService, parseFrequency } from '../src/core/services/ContentService.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';
import { validateAccounts } from '../src/config/accountConfig.js';
import { PROMPTS } from '../src/core/mcp/prompts.js';

const NOW = new Date('2026-11-17T12:00:00Z');
const DAY = 864e5;

async function fixture(t) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const accounts = validateAccounts([
    { username: 'brand_x', platform: 'twitter' },
    { username: 'brand_tg', platform: 'telegram', publish_enabled: true },
    { username: 'anime_x', platform: 'twitter' },
    { username: 'solo_li', platform: 'linkedin' },
    { username: 'dev', platform: 'github' },
  ]);
  const personas = [
    { slug: 'brand', name: 'Brand', accounts: [{ platform: 'twitter', username: 'brand_x' }, { platform: 'telegram', username: 'brand_tg' }],
      voice: {}, bio: {}, platforms: { twitter: { posting_frequency: '3 posts per week' } }, projects: null },
    { slug: 'anime', name: 'Anime', accounts: [{ platform: 'twitter', username: 'anime_x' }],
      voice: {}, bio: {}, platforms: { twitter: { posting_frequency: 'daily' } }, projects: null },
  ];
  const global = { platforms: { telegram: { posting_frequency: 'weekly' } }, projects: [] };
  const content = new ContentService(sequelizeExecutor(sequelize), {
    loadAccounts: async () => accounts, loadPersonas: async () => personas, loadGlobalContext: async () => global, now: () => NOW,
  });
  const row = {};
  for (const entry of accounts) {
    row[entry.username] = await models.Account.create({ username: entry.username, platform: entry.platform, last_scraped_at: new Date(NOW - 3600e3) });
  }
  return { sequelize, models, content, row };
}

test('drafts derive their persona, validate targets and record source signals', async t => {
  const { models, content, row } = await fixture(t);
  const release = await models.Signal.create({ account_id: row.dev.id, source: 'github', source_id: 'r1', signal_type: 'release', title: 'v2' });

  const draft = await content.createDraft({ platform: 'twitter', account: '@Brand_X', text: 'Shipped v2', signal_ids: [release.id] });
  assert.equal(draft.persona, 'brand');
  assert.equal(draft.account, 'brand_x');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.publishing, 'manual');
  assert.deepEqual(draft.signals.map(s => s.id), [release.id]);

  await assert.rejects(content.createDraft({ platform: 'twitter', account: 'anime_x', persona: 'brand', text: 'x' }), /belongs to persona "anime"/);
  await assert.rejects(content.createDraft({ platform: 'twitter', account: 'stranger', text: 'x' }), /not a configured account/);
  await assert.rejects(content.createDraft({ platform: 'github', text: 'x' }), /publishing platforms/);
  await assert.rejects(content.createDraft({ platform: 'telegram', account: 'brand_tg', text: 'x'.repeat(4097) }), /4096/);
  await assert.rejects(content.createDraft({ platform: 'twitter', persona: 'nobody', text: 'x' }), /Unknown persona/);
  await assert.rejects(content.createDraft({ platform: 'twitter', text: 'x', signal_ids: [999] }), /Unknown signal/);

  const long = await content.createDraft({ platform: 'twitter', persona: 'anime', text: 'y'.repeat(300) });
  assert.match(long.warning, /280/);
  assert.equal(long.account, null);

  const approved = await content.updateDraft(draft.id, { text: 'Shipped v2!', status: 'approved' });
  assert.equal(approved.status, 'approved');
  assert.deepEqual((await content.listDrafts({ status: ['approved', 'draft'] })).map(d => d.id), [draft.id, long.id]);

  // Manual publication marks the source signal used, once, and freezes the draft.
  const published = await content.markPublished(draft.id, { url: 'https://x.com/brand_x/status/1' });
  assert.equal(published.status, 'published');
  assert.ok((await release.reload()).used_for_content);
  await assert.rejects(content.updateDraft(draft.id, { text: 'edit' }), /cannot be changed/);
  await assert.rejects(content.markPublished(long.id, { url: 'javascript:alert(1)' }), /http/);
  await assert.rejects(content.updateDraft(long.id, { status: 'published' }), /draft_mark_published/);
});

test('Telegram drafts publish through the outbox and become published once sent', async t => {
  const { sequelize, content } = await fixture(t);
  const draft = await content.createDraft({ platform: 'telegram', account: 'brand_tg', text: 'Hello channel' });
  const first = await content.telegramRequestFor(draft.id);
  const again = await content.telegramRequestFor(draft.id);
  // Same text, same request id: preparing twice can never create two posts.
  assert.equal(first.request_id, again.request_id);

  await sequelize.query(`INSERT INTO telegram_outbox (request_id, account, text, content_hash, random_id, disable_preview, status, receipt, created_at, updated_at)
    VALUES (?, 'brand_tg', 'Hello channel', 'h', 'r', 1, 'sending', NULL, ?, ?)`, { replacements: [first.request_id, NOW.toISOString(), NOW.toISOString()] });
  await assert.rejects(content.updateDraft(draft.id, { text: 'changed' }), /being sent/);

  await sequelize.query("UPDATE telegram_outbox SET status = 'sent', receipt = ? WHERE request_id = ?", {
    replacements: [JSON.stringify({ url: 'https://t.me/brand_tg/5', sent_at: NOW.toISOString() }), first.request_id],
  });
  const done = await content.getDraft(draft.id);
  assert.equal(done.status, 'published');
  assert.equal(done.published_url, 'https://t.me/brand_tg/5');

  const x = await content.createDraft({ platform: 'twitter', account: 'brand_x', text: 'x' });
  await assert.rejects(content.telegramRequestFor(x.id), /Publish X and LinkedIn posts yourself/);
});

test('manual ideas are signals bound to a persona', async t => {
  const { content, sequelize } = await fixture(t);
  const idea = await content.addSignal({ kind: 'idea', title: 'Thread about local-first tools', persona: 'brand', url: 'https://example.com/a' });
  assert.equal(idea.source, 'note');
  assert.equal(idea.signal_type, 'idea');
  assert.deepEqual(JSON.parse(idea.metadata), { manual: true, persona: 'brand' });
  await assert.rejects(content.addSignal({ title: '' }), /title/);
  await assert.rejects(content.addSignal({ title: 'x', persona: 'ghost' }), /Unknown persona/);
  await assert.rejects(content.addSignal({ title: 'x', url: 'file:///etc/passwd' }), /http/);
  // A legacy signal with non-JSON metadata must not break persona queries.
  await sequelize.query("INSERT INTO signals (source, source_id, signal_type, title, metadata, scraped_at, created_at, updated_at) VALUES ('note', 'legacy', 'idea', 't', 'not json', ?, ?, ?)",
    { replacements: [NOW.toISOString(), NOW.toISOString(), NOW.toISOString()] });
  const plan = await content.contentPlan({ persona: 'brand' });
  assert.equal(plan.personas[0].unused_signals, 1);
});

test('content plan compares real posting with each persona\'s cadence', async t => {
  const { models, content, row } = await fixture(t);
  const post = (account, daysAgo, extra = {}) => models.Post.create({
    account_id: row[account].id, platform: row[account].platform, platform_id: `${account}-${daysAgo}-${Math.random()}`,
    text: 'p', posted_at: new Date(NOW - daysAgo * DAY), ...extra,
  });
  await post('brand_x', 1);            // 3/week → every 2.33 days: on track
  await post('anime_x', 2);            // daily: 2 days → overdue (≥ 1.5 days)
  await post('anime_x', 0.5, { is_repost: true }); // reposts do not count
  await post('brand_tg', 11);          // weekly (global rule) → overdue from 10.5 days
  await models.Account.update({ last_scraped_at: new Date(NOW - 5 * DAY) }, { where: { id: row.solo_li.id } });
  await content.createDraft({ platform: 'twitter', account: 'anime_x', text: 'waiting' });

  const plan = await content.contentPlan();
  const items = Object.fromEntries(plan.personas.flatMap(group => group.accounts.map(item => [item.account, item])));
  assert.equal(items['twitter/brand_x'].status, 'on_track');
  assert.equal(items['twitter/brand_x'].target.per_week, 3);
  assert.equal(items['twitter/anime_x'].status, 'overdue');
  assert.equal(items['twitter/anime_x'].days_since_last_post, 2);
  assert.equal(items['twitter/anime_x'].drafts_waiting, 1);
  assert.equal(items['telegram/brand_tg'].status, 'overdue');
  assert.equal(items['telegram/brand_tg'].publishing, 'auto');
  assert.equal(items['linkedin/solo_li'].status, 'no_target');
  assert.match(items['linkedin/solo_li'].data_warning, /36 hours/);
  assert.equal(items['github/dev'], undefined);
  assert.deepEqual(plan.due_now.map(item => item.account).sort(), ['telegram/brand_tg', 'twitter/anime_x']);
  assert.equal(plan.personas.find(group => group.persona === null).accounts[0].account, 'linkedin/solo_li');
  await assert.rejects(content.contentPlan({ persona: 'ghost' }), /Unknown persona/);
});

test('posting frequency is parsed from English and Ukrainian phrases', () => {
  const perWeek = text => parseFrequency(text)?.per_week ?? null;
  assert.equal(perWeek('daily'), 7);
  assert.equal(perWeek('Weekly'), 1);
  assert.equal(perWeek('2 posts per week'), 2);
  assert.equal(perWeek('3/week'), 3);
  assert.equal(perWeek('1 per day'), 7);
  assert.equal(perWeek('every 2 days'), 3.5);
  assert.equal(perWeek('щодня'), 7);
  assert.equal(perWeek('3 рази на тиждень'), 3);
  assert.equal(perWeek('5/тиждень'), 5);
  assert.equal(perWeek('4 posts a month'), 4 * 7 / 30);
  assert.equal(parseFrequency('weekly').interval_days, 7);
  for (const value of ['', 'whenever', null, undefined, 42, '0 per week']) assert.equal(parseFrequency(value), null);
});

test('MCP prompts describe complete, publish-safe workflows', () => {
  assert.deepEqual(PROMPTS.map(p => p.name), ['write_post', 'content_week', 'repurpose_signal', 'performance_review']);
  const write = PROMPTS[0].build({ persona: 'brand', platform: 'twitter' });
  assert.match(write, /context_get with persona "brand"/);
  assert.match(write, /draft_create/);
  assert.match(write, /Do not publish/);
  assert.match(PROMPTS[1].build({}), /content_plan_get/);
  assert.match(PROMPTS[2].build({ signal_id: '7' }), /signal_ids \[7\]/);
});

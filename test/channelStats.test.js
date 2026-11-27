import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Sequelize } from 'sequelize';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { UserContextRepository } from '../src/core/teapot/repositories/UserContextRepository.js';
import { ChannelStatsRepository } from '../src/core/teapot/repositories/ChannelStatsRepository.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';
import { readChannelStats } from '../src/platforms/telegram/TelegramChannelStats.js';
import { COLLECTORS } from '../src/platforms/collectors.js';

const serverPath = fileURLToPath(new URL('../src/core/mcp/start.js', import.meta.url));

// Minimal GramJS stand-ins: each request class records its arguments.
const request = name => class { constructor(args) { this.name = name; this.args = args; } };
const Api = {
  channels: { GetFullChannel: request('full') },
  messages: { GetAdminsWithInvites: request('admins'), GetExportedChatInvites: request('invites') },
};
const invite = (link, usage, extra = {}) => ({ link, usage, title: null, requested: 0, revoked: false, date: 1_700_000_000, ...extra });
// The normalized shape readChannelStats returns and the repository stores.
const link = (url, joins, title, createdAt = new Date('2026-01-01T00:00:00Z')) => ({ link: url, title, joins, requested: 0, revoked: false, created_at: createdAt });

function fakeClient({ admins, invites, adminError } = {}) {
  const calls = [];
  return {
    calls,
    getInputEntity: async channel => ({ peer: channel }),
    async invoke(req) {
      calls.push(req);
      if (req.name === 'full') return { fullChat: { participantsCount: 42 } };
      if (req.name === 'admins') {
        if (adminError) throw Object.assign(new Error(adminError), { errorMessage: adminError });
        return { admins };
      }
      return { invites: invites(req.args) };
    },
  };
}

test('channel stats read the subscriber count and every invite link of every admin', async () => {
  const page = Array.from({ length: 100 }, (_, i) => invite(`https://t.me/+p${i}`, 1));
  const client = fakeClient({
    admins: [{ adminId: 1, invitesCount: 101, revokedInvitesCount: 1 }, { adminId: 2, invitesCount: 0, revokedInvitesCount: 0 }],
    invites: ({ adminId, revoked, offsetLink }) => {
      assert.equal(adminId, 1, 'admins without links are not queried');
      if (revoked) return [invite('https://t.me/+old', 3, { revoked: true, title: 'example-old' })];
      return offsetLink ? [invite('https://t.me/+bio', 7, { title: 'example-bio', requested: 2 })] : page;
    },
  });
  const stats = await readChannelStats(client, 'example_channel', { Api });
  assert.equal(stats.subscribers, 42);
  assert.equal(stats.invites.length, 102);
  const bio = stats.invites.find(entry => entry.title === 'example-bio');
  assert.deepEqual({ ...bio, created_at: undefined }, {
    link: 'https://t.me/+bio', title: 'example-bio', joins: 7, requested: 2, revoked: false, created_at: undefined,
  });
  assert.ok(bio.created_at instanceof Date);
  assert.equal(stats.invites.find(entry => entry.revoked).joins, 3);
  const second = client.calls.filter(call => call.name === 'invites' && call.args.offsetLink);
  assert.equal(second.length, 1, 'a full page continues from its last link');
  assert.equal(second[0].args.offsetLink, 'https://t.me/+p99');
});

test('without admin rights the subscriber count is still returned', async () => {
  const stats = await readChannelStats(fakeClient({ adminError: 'CHAT_ADMIN_REQUIRED' }), 'example_channel', { Api });
  assert.equal(stats.subscribers, 42);
  assert.equal(stats.invites, null);
  assert.equal(stats.invites_admin_required, true);
  assert.match(stats.invites_error, /admin rights/);
});

async function database(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-audience-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers) await close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const storage = path.join(dir, 'test.sqlite');
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  closers.push(() => sequelize.close());
  return { dir, storage, sequelize, models, closers, db: sequelizeExecutor(sequelize) };
}

test('snapshots keep one row per day: a second run the same day replaces it', async t => {
  const { models, db } = await database(t);
  const account = await models.Account.create({ username: 'example_channel', platform: 'telegram' });
  const repo = new ChannelStatsRepository(db);
  const day = iso => new Date(`${iso}T12:00:00Z`);
  await repo.saveSnapshot(account.id, { subscribers: 10, invites: [link('L1', 1, 'example-bio')] }, day('2026-11-25'));
  await repo.saveSnapshot(account.id, { subscribers: 12, invites: [link('L1', 2, 'example-bio')] }, day('2026-11-26'));
  await repo.saveSnapshot(account.id, { subscribers: 13, invites: [link('L1', 4, 'example-bio')] }, day('2026-11-26'));
  assert.deepEqual(await repo.subscriberHistory(account.id), [
    { day: '2026-11-25', subscribers: 10 }, { day: '2026-11-26', subscribers: 13 },
  ]);
  assert.deepEqual((await repo.inviteHistory(account.id)).map(row => [row.day, row.joins]), [['2026-11-25', 1], ['2026-11-26', 4]]);
  assert.equal((await repo.latestInvites(account.id))[0].joins, 4);
});

test('Telegram collection stores the audience snapshot; a failure costs no posts', async t => {
  const { models, db } = await database(t);
  const account = (await models.Account.create({ username: 'example_channel', platform: 'telegram' })).toJSON();
  const channelStats = new ChannelStatsRepository(db);
  const post = { platform_id: '1', text: 'hello', posted_at: new Date() };
  const repos = { postRepo: { newestPostDate: async () => null }, stateRepo: null, channelStats };
  const scraper = statsFn => ({ collect: async () => ({ posts: [post], backfill: null }), channelStats: statsFn });

  const ok = await COLLECTORS.telegram.collect({
    account, session: 'default', repos,
    runtime: { telegramScraper: async () => scraper(async () => ({ subscribers: 5, invites: [link('L1', 2, 'example-bio')] })) },
  });
  assert.equal(ok.records.length, 1);
  assert.equal(ok.warning, undefined);
  assert.equal((await channelStats.latestSubscribers(account.id)).subscribers, 5);

  const readOnly = await COLLECTORS.telegram.collect({
    account, session: 'default', repos,
    runtime: { telegramScraper: async () => scraper(async () => ({ subscribers: 6, invites: null, invites_admin_required: true, invites_error: 'x' })) },
  });
  assert.equal(readOnly.warning, undefined, 'a channel the session only reads is not a problem');

  const failed = await COLLECTORS.telegram.collect({
    account, session: 'default', repos,
    runtime: { telegramScraper: async () => scraper(async () => { throw new Error('FLOOD_WAIT_30'); }) },
  });
  assert.equal(failed.records.length, 1);
  assert.match(failed.warning, /Channel stats not read: FLOOD_WAIT_30/);
});

test('telegram_channel_stats shows subscribers and invite-link joins, per persona and isolated', { timeout: 60000 }, async t => {
  const { dir, storage, sequelize, models, closers, db } = await database(t);
  const accounts = [
    { username: 'example_public_channel', platform: 'telegram' },
    { username: 'example_hidden_channel', platform: 'telegram' },
  ];
  const accountsPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsPath, JSON.stringify(accounts));
  const context = path.join(dir, 'context');
  await fs.mkdir(path.join(context, 'personas'), { recursive: true });
  await fs.mkdir(path.join(context, 'projects'), { recursive: true });
  await fs.writeFile(path.join(context, 'personas', 'example-public.yaml'), 'accounts: ["telegram/example_public_channel"]\nprojects: []\n');
  await fs.writeFile(path.join(context, 'personas', 'example-hidden.yaml'),
    'disclosure: isolated\naccounts: ["telegram/example_hidden_channel"]\nprojects: []\n');
  assert.deepEqual((await new UserContextRepository(models, context, accountsPath).sync()).errors, []);

  const repo = new ChannelStatsRepository(db);
  const today = new Date();
  const daysAgo = n => new Date(today.getTime() - n * 86_400_000);
  const pub = await models.Account.create(accounts[0]);
  const hidden = await models.Account.create(accounts[1]);
  const old = daysAgo(60);
  await repo.saveSnapshot(pub.id, { subscribers: 10, invites: [link('https://t.me/+bio', 3, 'example-bio', old), link('https://t.me/+other', 1, 'example-other', old)] }, daysAgo(3));
  await repo.saveSnapshot(pub.id, { subscribers: 21, invites: [link('https://t.me/+bio', 9, 'example-bio', old), link('https://t.me/+other', 2, 'example-other', old)] }, today);
  await repo.saveSnapshot(hidden.id, { subscribers: 99, invites: [] }, today);
  await sequelize.close();
  closers.length = 0;

  const env = { ...process.env, INSTANCE_DIR: dir, DB_PATH: storage, DATA_DIR: dir, ACCOUNTS_CONFIG_PATH: accountsPath,
    CONTEXT_DIR: context, MCP_TRANSPORT: 'stdio', TELEGRAM_PUBLISH_TRANSPORT: 'bot', TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', TELEGRAM_SESSION: '', GITHUB_TOKEN: '' };
  const client = new Client({ name: 'audience', version: '1.0' });
  closers.push(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: os.tmpdir(), env, stderr: 'pipe' }));
  const call = async args => JSON.parse((await client.callTool({ name: 'telegram_channel_stats', arguments: args })).content[0].text);

  const all = await call({});
  assert.deepEqual(all.channels.map(channel => channel.account), ['telegram/example_public_channel']);
  assert.doesNotMatch(JSON.stringify(all), /hidden/);
  const [channel] = all.channels;
  assert.equal(channel.persona, 'example-public');
  assert.equal(channel.subscribers, 21);
  assert.equal(channel.subscribers_change, 11);
  assert.equal(channel.history.length, 2);
  assert.equal(channel.invite_joins_total, 11);

  const bio = await call({ persona: 'example-public', link_title: 'EXAMPLE-BIO' });
  assert.deepEqual(bio.channels[0].invite_links.map(link => [link.title, link.joins, link.joins_in_window]), [['example-bio', 9, 6]]);

  const named = await call({ persona: 'example-hidden' });
  assert.equal(named.channels[0].subscribers, 99);
  assert.equal((await call({ account: 'telegram/example_hidden_channel' })).count, 0, 'an explicit account does not unlock an isolated persona');
});

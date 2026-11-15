import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize, QueryTypes } from 'sequelize';
import { z } from 'zod';
import { validateAccounts, normalizeSelection, sessionOf } from '../src/config/accountConfig.js';
import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { migrateAccountIdentity } from '../src/core/teapot/migrateAccountIdentity.js';
import { AccountRepository } from '../src/core/teapot/repositories/AccountRepository.js';
import { ScraperOrchestrator, orderForCollection } from '../src/core/orchestrator/ScraperOrchestrator.js';
import { acquireScrapeLock } from '../src/core/orchestrator/ScrapeLock.js';
import { ScrapeJobs } from '../src/core/mcp/ScrapeJobs.js';
import { buildCollectionTools } from '../src/core/mcp/tools/collection.js';
import { jsonSchemaToZod } from '../src/core/mcp/schema.js';
import { JobStore } from '../src/core/services/JobStore.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';

test('account validation normalizes platform identity and rejects invalid config', () => {
  assert.deepEqual(validateAccounts([
    { username: '@Example', platform: 'twitter' },
    { username: 'https://t.me/Example', platform: 'telegram' },
  ]).map(a => a.username), ['example', 'example']);
  for (const entries of [{}, [null], [{ username: 'x', platform: 'invalid' }],
    [{ username: 'x', active: 'false' }], [{ username: ' x ' }, { username: '@X' }]]) {
    assert.throws(() => validateAccounts(entries));
  }
});

test('migration preserves parent IDs, posts, signals and foreign keys when replacing legacy username uniqueness', async t => {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  await sequelize.query('CREATE UNIQUE INDEX legacy_username ON accounts (username)');
  const account = await models.Account.create({ username: 'same', platform: 'twitter' });
  const post = await models.Post.create({ account_id: account.id, platform: 'twitter', platform_id: '1', text: 'keep' });
  const signal = await models.Signal.create({ account_id: account.id, source: 'github', source_id: '1', signal_type: 'release', title: 'keep' });
  await migrateAccountIdentity(sequelize, 'test_rebuild');
  await models.Account.create({ username: 'same', platform: 'telegram' });
  await assert.rejects(models.Account.create({ username: 'same', platform: 'twitter' }));
  assert.equal((await post.reload()).account_id, account.id);
  assert.equal((await signal.reload()).account_id, account.id);
  const foreignKeys = await sequelize.query('PRAGMA foreign_keys', { type: QueryTypes.SELECT });
  assert.equal(foreignKeys[0].foreign_keys, 1);
  const violations = await sequelize.query('PRAGMA foreign_key_check', { type: QueryTypes.SELECT });
  assert.deepEqual(violations, []);
  await models.Account.destroy({ where: { id: account.id } });
  assert.equal(await models.Post.count(), 0);
});

test('sync keeps same username on two platforms separate and validates before writes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-accounts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'accounts.json');
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  await fs.writeFile(config, JSON.stringify([
    { username: 'same', platform: 'twitter' }, { username: 'same', platform: 'telegram' },
  ]));
  const repo = new AccountRepository(models.Account, config);
  await repo.syncFromConfig();
  await repo.syncFromConfig();
  assert.equal((await repo.findAllActive()).length, 2);
  await fs.writeFile(config, JSON.stringify([{ username: 'same' }, { username: 'bad', platform: 'broken' }]));
  await assert.rejects(repo.syncFromConfig(), /Unsupported platform/);
  assert.equal((await repo.findAllActive()).length, 2);
});

test('collection lock excludes another process and can be reacquired after release', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'scrape.lock');
  const release = await acquireScrapeLock(lock);
  await assert.rejects(acquireScrapeLock(lock), /Another scrape/);
  await release();
  await (await acquireScrapeLock(lock))();
});

test('collection lock reclaims only a lock whose owner process is gone', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'scrape.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: 424242, started_at: '2026-01-01T00:00:00.000Z' }));
  await assert.rejects(acquireScrapeLock(lock, { isAlive: () => true }), /Another scrape/);
  await fs.writeFile(lock, '');
  await assert.rejects(acquireScrapeLock(lock, { isAlive: () => false }), /Another scrape/);
  await fs.writeFile(lock, JSON.stringify({ pid: 424242, started_at: '2026-01-01T00:00:00.000Z' }));
  const release = await acquireScrapeLock(lock, { isAlive: () => false });
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, process.pid);
  await release();
  await assert.rejects(fs.access(`${lock}.reclaim`));
});

test('orchestrator validates selection before opening a run', async () => {
  const orchestrator = new ScraperOrchestrator({});
  await assert.rejects(orchestrator.run({ account: 'example' }), /platform is required/);
  await assert.rejects(orchestrator.run({ accounts: ['example'] }), /platform is required/);
  await assert.rejects(orchestrator.run({ platform: 'twitter', accounts: 'example' }), /array/);
  await assert.rejects(orchestrator.run({ platform: 'invalid' }), /Unknown platform/);
});

test('selection merges one and several accounts into a normalized unique list', () => {
  assert.deepEqual(normalizeSelection({ platform: 'twitter', account: '@First', accounts: ['second', 'twitter/first'] }),
    { platform: 'twitter', accounts: ['twitter/second', 'twitter/first'] });
  // A persona spans platforms: refs carry their own platform.
  assert.deepEqual(normalizeSelection({ accounts: ['twitter/One', 'linkedin/two', 'telegram/@three'] }),
    { platform: undefined, accounts: ['twitter/one', 'linkedin/two', 'telegram/three'] });
  assert.throws(() => normalizeSelection({ platform: 'twitter', accounts: ['linkedin/two'] }), /not on the selected platform/);
  assert.deepEqual(normalizeSelection({ platform: 'twitter' }), { platform: 'twitter', accounts: undefined });
  assert.throws(() => normalizeSelection({ platform: 'twitter', accounts: ['bad name'] }), /Invalid twitter username/);
});

test('X profiles run after other platforms, least recently collected first', () => {
  const order = orderForCollection([
    { username: 'recent', platform: 'twitter', last_scraped_at: '2026-10-26T10:00:00Z' },
    { username: 'repo', platform: 'github', last_scraped_at: null },
    { username: 'never', platform: 'twitter', last_scraped_at: null },
    { username: 'older', platform: 'twitter', last_scraped_at: '2026-10-20T10:00:00Z' },
    { username: 'channel', platform: 'telegram', last_scraped_at: null },
  ]).map(account => account.username);
  assert.deepEqual(order, ['repo', 'channel', 'never', 'older', 'recent']);
});

test('accounts name their own login session per platform', () => {
  const [x, tg, gh, li] = validateAccounts([
    { username: 'one', platform: 'twitter', session: 'brand_b' },
    { username: 'chan', platform: 'telegram', session: 'work', bot: 'news-bot', publish_transport: 'bot' },
    { username: 'dev', platform: 'github', session: 'work' },
    { username: 'me', platform: 'linkedin', import_file: 'Shares-me.csv' },
  ]);
  assert.equal(sessionOf(x), 'brand_b');
  assert.equal(sessionOf({ username: 'plain' }), 'default');
  assert.equal(tg.bot, 'news-bot');
  assert.equal(gh.session, 'work');
  assert.equal(li.import_file, 'Shares-me.csv');
  for (const entry of [
    { username: 'one', platform: 'twitter', session: 'Bad Name' },
    { username: 'one', platform: 'linkedin', session: 'default' },
    { username: 'one', platform: 'twitter', bot: 'x' },
    { username: 'one', platform: 'telegram', publish_transport: 'email' },
    { username: 'one', platform: 'linkedin', import_file: '../secrets.csv' },
    { username: 'one', platform: 'twitter', import_file: 'a.csv' },
  ]) assert.throws(() => validateAccounts([entry]), undefined, JSON.stringify(entry));
});

test('X profiles are grouped by login session after fast platforms', () => {
  const sessions = { a1: 'a', a2: 'a', b1: 'b', d1: 'default' };
  const order = orderForCollection([
    { username: 'a2', platform: 'twitter', last_scraped_at: '2026-10-22T10:00:00Z' },
    { username: 'b1', platform: 'twitter', last_scraped_at: null },
    { username: 'a1', platform: 'twitter', last_scraped_at: '2026-10-21T10:00:00Z' },
    { username: 'repo', platform: 'github', last_scraped_at: null },
    { username: 'd1', platform: 'twitter', last_scraped_at: '2026-10-23T10:00:00Z' },
  ], account => sessions[account.username]).map(account => account.username);
  assert.deepEqual(order, ['repo', 'b1', 'a1', 'a2', 'd1']);
});

async function jobStoreFixture(t, opts) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  return new JobStore(sequelizeExecutor(sequelize), opts);
}

test('MCP collection jobs are durable, record worker failures and allow the next run', async t => {
  const store = await jobStoreFixture(t, { isAlive: () => true });
  let child;
  const sent = [];
  const jobs = new ScrapeJobs({ store, getVaultKey: async () => ({ key: 'k', salt: 's' }), spawn: () => {
    child = new EventEmitter();
    child.send = (message, callback) => { sent.push(message); callback(); };
    child.kill = () => {};
    return child;
  } });
  const first = await jobs.start({ platform: 'telegram', account: '@Example' });
  assert.equal(first.status, 'queued');
  assert.deepEqual(first.accounts, ['telegram/example']);
  // The vault key reaches the worker only over IPC.
  assert.deepEqual(sent[0], {
    jobId: first.job_id, selection: { platform: 'telegram', accounts: ['telegram/example'] }, vaultKey: { key: 'k', salt: 's' },
  });
  await assert.rejects(jobs.start(), /already running/);

  // The worker records its own outcome; a clean exit changes nothing.
  await store.start(first.job_id, 4242);
  await store.finish(first.job_id, { status: 'partial', result: { run_id: 7, accounts_processed: 1 } });
  child.emit('exit', 0, null);
  const done = await jobs.get(first.job_id);
  assert.equal(done.status, 'partial');
  assert.equal(done.result.run_id, 7);

  // A worker that dies without reporting is marked failed by the requester.
  const second = await jobs.start();
  child.emit('error', new Error('spawn failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await jobs.get(second.job_id)).error, 'spawn failed');
  assert.equal((await jobs.list({ limit: 5 })).length, 2);
  await assert.rejects(jobs.get('missing'), /Unknown job_id/);
});

test('a locked vault fails the job request without spawning or blocking later runs', async t => {
  const store = await jobStoreFixture(t);
  let spawned = 0;
  const jobs = new ScrapeJobs({
    store,
    getVaultKey: async () => { throw new Error('The secrets vault is locked.'); },
    spawn: () => { spawned++; throw new Error('must not spawn'); },
  });
  await assert.rejects(jobs.start(), /locked/);
  await assert.rejects(jobs.start(), /locked/);
  assert.equal(spawned, 0);
  assert.deepEqual(await store.list(), []);
});

test('jobs whose worker died or never started are recovered as failed', async t => {
  let now = new Date('2026-11-16T10:00:00Z');
  const alive = new Set([1]);
  const store = await jobStoreFixture(t, { isAlive: pid => alive.has(pid), now: () => now });
  const running = await store.create({ type: 'scrape', source: 'cli' });
  await store.start(running.job_id, 1);
  const crashed = await store.create({ type: 'scrape', source: 'mcp' });
  await store.start(crashed.job_id, 2);
  const queued = await store.create({ type: 'scrape', source: 'web' });
  assert.equal(await store.recoverOrphans(), 1);
  assert.match((await store.get(crashed.job_id)).error, /Interrupted/);
  assert.equal((await store.get(queued.job_id)).status, 'queued');
  now = new Date('2026-11-16T10:05:00Z');
  assert.deepEqual((await store.active('scrape')).map(job => job.job_id), [running.job_id]);
  assert.match((await store.get(queued.job_id)).error, /Never started/);
  await store.finish(running.job_id, { status: 'success', result: { ok: true } });
  // First writer wins: a late failure report cannot overwrite the outcome.
  await store.finish(running.job_id, { status: 'failed', error: 'late' });
  assert.equal((await store.get(running.job_id)).status, 'success');
  await assert.rejects(store.create({ type: 'other', source: 'cli' }), /Unknown job type/);
});

test('MCP schemas enforce Telegram limits and required job ID', () => {
  const tools = buildCollectionTools({});
  const messages = z.object(jsonSchemaToZod(tools.find(t => t.name === 'telegram_messages_get').inputSchema));
  for (const args of [{ limit: -1 }, { limit: 0 }, { limit: 100000 }, { after_id: -1 }]) {
    assert.equal(messages.safeParse(args).success, false);
  }
  assert.equal(messages.safeParse({}).success, true);
  const job = z.object(jsonSchemaToZod(tools.find(t => t.name === 'scraper_job_get').inputSchema));
  assert.equal(job.safeParse({}).success, false);
});

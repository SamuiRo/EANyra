import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize, QueryTypes } from 'sequelize';
import { z } from 'zod';
import { validateAccounts } from '../src/config/accountConfig.js';
import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { migrateAccountIdentity } from '../src/core/teapot/migrateAccountIdentity.js';
import { AccountRepository } from '../src/core/teapot/repositories/AccountRepository.js';
import { ScraperOrchestrator } from '../src/core/orchestrator/ScraperOrchestrator.js';
import { acquireScrapeLock } from '../src/core/orchestrator/ScrapeLock.js';
import { ScrapeJobs } from '../src/core/mcp/ScrapeJobs.js';
import { buildCollectionTools } from '../src/core/mcp/tools/collection.js';
import { jsonSchemaToZod } from '../src/core/mcp/schema.js';

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
  await assert.rejects(orchestrator.run({ platform: 'invalid' }), /Unknown platform/);
});

test('MCP collection jobs report actual partial/failure outcomes and allow the next run', () => {
  let child;
  const jobs = new ScrapeJobs({ spawn: () => {
    child = new EventEmitter();
    child.send = (selection, callback) => callback();
    child.kill = () => {};
    return child;
  } });
  const first = jobs.start({ platform: 'telegram', account: '@Example' });
  assert.equal(first.account, 'example');
  assert.throws(() => jobs.start(), /already running/);
  child.emit('message', { result: { status: 'partial', accounts_processed: 1 } });
  assert.equal(jobs.get(first.job_id).status, 'running');
  child.emit('exit', 0, null);
  assert.equal(jobs.get(first.job_id).status, 'partial');
  const second = jobs.start();
  child.emit('error', new Error('spawn failed'));
  child.emit('exit', 1, null);
  assert.equal(jobs.get(second.job_id).error, 'spawn failed');
  assert.throws(() => jobs.get('missing'), /Unknown job_id/);
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

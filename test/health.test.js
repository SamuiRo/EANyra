import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize } from 'sequelize';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { ScraperOrchestrator } from '../src/core/orchestrator/ScraperOrchestrator.js';
import { Credentials } from '../src/core/secrets/Credentials.js';
import { StatusService } from '../src/core/services/StatusService.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';
import { PLATFORM_CATALOG, PLATFORM_IDS, SESSION_PLATFORMS } from '../src/platforms/catalog.js';
import { COLLECTORS } from '../src/platforms/collectors.js';
import { SUPPORTED_PLATFORMS } from '../src/config/app.config.js';

async function fixture(t, accounts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-health-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify(accounts));
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  return { dir, accountsConfigPath, sequelize, models };
}

test('the platform catalog is the single registry for config, sessions and collectors', () => {
  assert.deepEqual(SUPPORTED_PLATFORMS, PLATFORM_IDS);
  assert.deepEqual([...SESSION_PLATFORMS].sort(), ['github', 'telegram', 'twitter']);
  for (const id of PLATFORM_IDS) {
    assert.equal(typeof COLLECTORS[id]?.collect, 'function', id);
    assert.ok(['posts', 'signals'].includes(PLATFORM_CATALOG[id].output), id);
  }
});

test('runs record per-account outcomes, split post/signal counts and account health', async t => {
  const { dir, accountsConfigPath, sequelize, models } = await fixture(t, [
    { username: 'repo_owner', platform: 'github' },
    { username: 'channel', platform: 'telegram' },
    { username: 'broken', platform: 'linkedin' },
  ]);
  const post = id => ({ platform: 'telegram', platform_id: `channel:${id}`, text: `post ${id}`, posted_at: new Date('2026-11-15T10:00:00Z') });
  const collectors = {
    github: { collect: async () => ({ records: [{ source: 'github', source_id: 'release:a', signal_type: 'release', title: 'v1', occurred_at: new Date() }] }) },
    telegram: { collect: async () => ({ records: [post(1), post(2)], scrapedAt: new Date('2026-11-15T10:00:00Z') }) },
    linkedin: { collect: async () => { throw new Error('Shares.csv not found'); } },
  };
  // A run left "running" by a killed process is closed by the next run.
  const orphan = await models.ScraperRun.create({ status: 'running', started_at: new Date('2026-11-01T00:00:00Z') });

  const orchestrator = new ScraperOrchestrator(models, {
    credentials: new Credentials({ legacy: { telegram: {} } }),
    accountsConfigPath, lockPath: path.join(dir, 'lock'), pause: async () => {}, collectors,
  });
  const run = await orchestrator.run();
  assert.equal(run.status, 'partial');
  assert.equal(run.posts_saved, 2);
  assert.equal(run.signals_saved, 1);
  assert.equal((await orphan.reload()).status, 'failed');

  const db = sequelizeExecutor(sequelize);
  const status = new StatusService(db, { now: () => new Date('2026-11-16T10:00:00Z') });
  const outcomes = await status.runAccounts(run.id);
  assert.deepEqual(outcomes.map(row => [row.username, row.status, row.records_saved]), [
    ['broken', 'failed', 0], ['channel', 'success', 2], ['repo_owner', 'success', 1],
  ]);
  assert.match(outcomes[0].error, /Shares\.csv/);

  const overview = await status.overview();
  assert.equal(overview.health, 'degraded');
  assert.equal(overview.platforms.telegram.ok, 1);
  assert.equal(overview.platforms.telegram.freshest_age_hours, 24);
  assert.deepEqual(overview.accounts_needing_attention.map(row => [row.username, row.state]), [['broken', 'error']]);
  assert.equal(overview.recent_runs[0].signals_saved, 1);

  // The next success clears the error; last_scraped_at stays the Telegram watermark.
  collectors.linkedin.collect = async () => ({ records: [] });
  await orchestrator.run();
  const accounts = await status.accountHealth();
  assert.deepEqual(accounts.map(row => row.state), ['ok', 'ok', 'ok']);
  assert.equal(accounts.find(row => row.username === 'broken').last_error, null);
  assert.equal((await status.overview()).health, 'ok');
});

test('status reports stale and never-collected accounts and an empty instance as unknown', async t => {
  const { sequelize, models } = await fixture(t, []);
  const status = new StatusService(sequelizeExecutor(sequelize), { now: () => new Date('2026-11-16T10:00:00Z') });
  assert.equal((await status.overview()).health, 'unknown');
  await models.Account.create({ username: 'old', platform: 'twitter', last_scraped_at: new Date('2026-11-10T10:00:00Z') });
  await models.Account.create({ username: 'new', platform: 'twitter' });
  const overview = await status.overview();
  assert.equal(overview.health, 'degraded');
  assert.deepEqual(overview.accounts_needing_attention.map(row => [row.username, row.state]).sort(), [['new', 'never'], ['old', 'stale']]);
  assert.equal(overview.data_age_hours, null);
});

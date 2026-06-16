import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Sequelize } from 'sequelize';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { AccountRepository } from '../src/core/teapot/repositories/AccountRepository.js';
import { ExportRepository } from '../src/core/teapot/repositories/ExportRepository.js';
import { UserContextRepository } from '../src/core/teapot/repositories/UserContextRepository.js';
import { GithubClient } from '../src/platforms/github/client.js';

async function createModels(t) {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const models = registerModels(sequelize);
  await sequelize.sync({ force: true });
  t.after(() => sequelize.close());
  return models;
}

test('exports record exported_at without changing used_for_content', async t => {
  const models = await createModels(t);
  const account = await models.Account.create({
    username: 'example',
    platform: 'github',
  });
  const signal = await models.Signal.create({
    source: 'github',
    source_id: 'release:example/repo:1',
    signal_type: 'release',
    account_id: account.id,
    title: 'Release',
  });

  const repository = new ExportRepository(models);
  await repository.markAsExported({ signalIds: [signal.id] });
  await signal.reload();

  assert.ok(signal.exported_at instanceof Date);
  assert.equal(signal.used_for_content, null);
  assert.deepEqual(await repository.getSignals({ unusedOnly: true }), []);
});

test('schema migrations repair the legacy database without repeated ALTER sync', async t => {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => sequelize.close());

  registerModels(sequelize);
  await sequelize.sync({ force: true });

  await sequelize.query('DROP INDEX accounts_is_archived');
  await sequelize.query('DROP INDEX posts_exported_at');
  await sequelize.query('DROP INDEX signals_exported_at');
  await sequelize.query('ALTER TABLE accounts DROP COLUMN is_archived');
  await sequelize.query('ALTER TABLE posts DROP COLUMN exported_at');
  await sequelize.query('ALTER TABLE signals DROP COLUMN exported_at');
  await sequelize.query('CREATE TABLE accounts_backup AS SELECT * FROM accounts');

  const migrator = new SchemaMigrator(sequelize);
  assert.equal((await migrator.migrate()).length, 3);
  assert.deepEqual(await migrator.migrate(), []);

  const tables = await sequelize.getQueryInterface().showAllTables();
  const accountColumns = await sequelize.getQueryInterface().describeTable('accounts');
  const postColumns = await sequelize.getQueryInterface().describeTable('posts');
  const signalColumns = await sequelize.getQueryInterface().describeTable('signals');

  assert.equal(tables.includes('accounts_backup'), false);
  assert.ok(accountColumns.is_archived);
  assert.ok(postColumns.exported_at);
  assert.ok(signalColumns.exported_at);
});

test('schema migrations fully bootstrap a clean database for every model', async t => {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => sequelize.close());

  const models = registerModels(sequelize);
  const migrator = new SchemaMigrator(sequelize);

  assert.equal((await migrator.migrate()).length, 3);
  assert.deepEqual(await migrator.migrate(), []);

  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('accounts'));
  assert.ok(tables.includes('posts'));
  assert.ok(tables.includes('signals'));
  assert.ok(tables.includes('schema_migrations'));

  const account = await models.Account.create({ username: 'clean', platform: 'twitter' });
  await models.Post.create({
    platform: 'twitter',
    platform_id: 'post-1',
    account_id: account.id,
    text: 'Post',
  });
  await models.Signal.create({
    source: 'github',
    source_id: 'signal-1',
    signal_type: 'release',
    account_id: account.id,
    title: 'Signal',
  });
  await models.ScraperRun.create();
  await models.UserContext.create({ key: 'voice', value: { tone: 'direct' } });
  await models.Project.create({ slug: 'clean-project', name: 'Clean Project' });

  assert.equal(await models.Account.count(), 1);
  assert.equal(await models.Post.count(), 1);
  assert.equal(await models.Signal.count(), 1);
  assert.equal(await models.ScraperRun.count(), 1);
  assert.equal(await models.UserContext.count(), 1);
  assert.equal(await models.Project.count(), 1);
});

test('GitHub commit requests filter by the configured account author', async t => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async url => {
    requestedUrl = new URL(url);
    return {
      status: 200,
      ok: true,
      json: async () => [],
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new GithubClient('token');
  await client.getCommitsSince('ExampleUser', 'repo', new Date('2026-06-01T00:00:00Z'), 25);

  assert.equal(requestedUrl.searchParams.get('author'), 'ExampleUser');
  assert.equal(requestedUrl.searchParams.get('per_page'), '25');
});

test('account sync archives missing and explicitly archived accounts', async t => {
  const models = await createModels(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-accounts-'));
  const configPath = path.join(directory, 'accounts.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await models.Account.bulkCreate([
    { username: 'missing', platform: 'twitter', is_active: true },
    { username: 'archived', platform: 'github', is_active: true },
  ]);
  await fs.writeFile(configPath, JSON.stringify([
    { username: 'active', platform: 'twitter', active: true },
    { username: 'archived', platform: 'github', archive: true },
  ]));

  await new AccountRepository(models.Account, configPath).syncFromConfig();

  const active = await models.Account.findOne({ where: { username: 'active' } });
  const archived = await models.Account.findOne({ where: { username: 'archived' } });
  const missing = await models.Account.findOne({ where: { username: 'missing' } });

  assert.equal(active.is_active, true);
  assert.equal(active.is_archived, false);
  assert.equal(archived.is_active, false);
  assert.equal(archived.is_archived, true);
  assert.equal(missing.is_active, false);
  assert.equal(missing.is_archived, true);
});

test('context sync archives missing projects and honors archive true', async t => {
  const models = await createModels(t);
  const contextDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-context-'));
  const projectsDir = path.join(contextDir, 'projects');
  await fs.mkdir(projectsDir);
  t.after(() => fs.rm(contextDir, { recursive: true, force: true }));

  await models.Project.create({ slug: 'missing', name: 'Missing', status: 'active' });
  await models.UserContext.create({
    key: 'project.missing',
    value: { slug: 'missing', name: 'Missing', status: 'active' },
  });
  await fs.writeFile(
    path.join(projectsDir, 'explicit.yaml'),
    'slug: explicit\nname: Explicit\narchive: true\n',
  );
  await fs.writeFile(
    path.join(projectsDir, 'ignored.example.yaml'),
    'slug: ignored\nname: Ignored\n',
  );

  const result = await new UserContextRepository(models, contextDir).sync();
  const explicit = await models.Project.findOne({ where: { slug: 'explicit' } });
  const missing = await models.Project.findOne({ where: { slug: 'missing' } });
  const ignored = await models.Project.findOne({ where: { slug: 'ignored' } });
  const missingContext = await models.UserContext.findOne({ where: { key: 'project.missing' } });

  assert.deepEqual(result.errors, []);
  assert.equal(explicit.status, 'archived');
  assert.equal(missing.status, 'archived');
  assert.equal(missingContext.value.archive, true);
  assert.equal(ignored, null);
});

test('context sync does not archive projects when a project file fails to parse', async t => {
  const models = await createModels(t);
  const contextDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-context-error-'));
  const projectsDir = path.join(contextDir, 'projects');
  await fs.mkdir(projectsDir);
  t.after(() => fs.rm(contextDir, { recursive: true, force: true }));

  await models.Project.create({ slug: 'keep-active', name: 'Keep Active', status: 'active' });
  await fs.writeFile(path.join(projectsDir, 'broken.yaml'), 'slug: [not valid');

  const result = await new UserContextRepository(models, contextDir).sync();
  const project = await models.Project.findOne({ where: { slug: 'keep-active' } });

  assert.equal(result.errors.length, 1);
  assert.equal(project.status, 'active');
  assert.ok(result.skipped.includes('project deletion reconciliation (project sync errors)'));
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import dotenv from 'dotenv';
import { loadInstanceEnvironment } from '../src/config/instance.js';
import { initializeInstance, migrateLegacyInstance, rewriteLegacyPaths } from '../src/core/instance/InstanceManager.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-instance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, name, text) {
  const filename = path.join(root, name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, text);
}

test('instance init creates editable files outside src without overwriting existing content', async t => {
  const projectRoot = await fixture(t);
  await fs.cp(path.join(repository, 'instance_example'), path.join(projectRoot, 'instance_example'), { recursive: true });
  const instanceDir = path.join(projectRoot, 'instance');
  await write(instanceDir, 'context/voice.yaml', 'tone: personal');
  await write(projectRoot, '.env', 'TELEGRAM_BOT_TOKEN=keep-existing-test-token');
  const result = await initializeInstance({ projectRoot });
  assert.equal(result.created.includes('.env'), false);
  assert.equal(result.created.includes('context/voice.yaml'), false);
  assert.equal(await fs.readFile(path.join(instanceDir, 'context/voice.yaml'), 'utf8'), 'tone: personal');
  assert.equal(await fs.readFile(path.join(projectRoot, '.env'), 'utf8'), 'TELEGRAM_BOT_TOKEN=keep-existing-test-token');
  assert.deepEqual((await initializeInstance({ projectRoot })).created, []);
  assert.ok((await fs.stat(path.join(instanceDir, 'data/exports'))).isDirectory());
  assert.ok((await fs.stat(path.join(instanceDir, 'context/projects/_template.yaml'))).isFile());
  assert.deepEqual(
    await fs.readFile(path.join(projectRoot, 'instance_example/context/projects/eanyra.example.yaml')),
    await fs.readFile(path.join(repository, 'instance_example/context/projects/eanyra.example.yaml')),
  );
  await assert.rejects(fs.stat(path.join(instanceDir, 'context/projects/eanyra.yaml')), { code: 'ENOENT' });
});

test('legacy migration preserves account/context/database bytes and credentials while rebasing standard paths', async t => {
  const projectRoot = await fixture(t);
  const instanceDir = path.join(projectRoot, 'instance');
  const originalEnv = '# private settings\nGITHUB_TOKEN="fake-test-value"\nDATA_DIR=data\nDB_PATH=data/pot.sqlite\nCONTEXT_DIR=src/context\nACCOUNTS_CONFIG_PATH=src/config/accounts.json\nBROWSER_DATA_PATH=data/nyra\nBROWSER_COOKIES_PATH=data/cookies.json\nEXPORTS_DIR=data/exports\nLINKEDIN_IMPORTS_DIR=data/imports\n';
  const files = {
    '.env': originalEnv,
    'src/config/accounts.json': '[{"username":"example_channel","platform":"telegram"}]',
    'src/context/voice.yaml': 'tone: original\n',
    'src/context/projects/personal.yaml': 'name: personal\n',
    'data/pot.sqlite': Buffer.from([0, 1, 3, 8, 255]),
    'data/nyra/Default/session': 'test-browser-session',
    'data/cookies.json': '[{"name":"test-session"}]',
  };
  for (const [name, data] of Object.entries(files)) await write(projectRoot, name, data);
  const migrated = await migrateLegacyInstance({ projectRoot });
  assert.equal(migrated.moved.length, 3);
  const destinations = {
    'src/config/accounts.json': 'accounts.json',
    'src/context/voice.yaml': 'context/voice.yaml',
    'src/context/projects/personal.yaml': 'context/projects/personal.yaml',
    'data/pot.sqlite': 'data/pot.sqlite',
    'data/nyra/Default/session': 'data/nyra/Default/session',
    'data/cookies.json': 'data/cookies.json',
  };
  for (const [source, destination] of Object.entries(destinations)) {
    assert.deepEqual(await fs.readFile(path.join(instanceDir, destination)), Buffer.from(files[source]));
    await assert.rejects(fs.stat(path.join(projectRoot, source)), { code: 'ENOENT' });
  }
  const values = dotenv.parse(await fs.readFile(path.join(projectRoot, '.env')));
  assert.equal(values.GITHUB_TOKEN, 'fake-test-value');
  assert.equal(values.CONTEXT_DIR, 'context');
  assert.equal(values.ACCOUNTS_CONFIG_PATH, 'accounts.json');
  assert.equal(values.DB_PATH, 'data/pot.sqlite');
  assert.deepEqual((await migrateLegacyInstance({ projectRoot })).moved, []);
});

test('migration checks all conflicts and scrape locks before moving private files', async t => {
  const projectRoot = await fixture(t);
  await write(projectRoot, '.env', 'GITHUB_TOKEN=original-test-token');
  await write(projectRoot, 'data/pot.sqlite', 'source-db');
  await write(projectRoot, 'instance/data/pot.sqlite', 'destination-db');
  await assert.rejects(migrateLegacyInstance({ projectRoot }), /Migration conflict/);
  assert.equal(await fs.readFile(path.join(projectRoot, '.env'), 'utf8'), 'GITHUB_TOKEN=original-test-token');
  assert.equal(await fs.readFile(path.join(projectRoot, 'instance/data/pot.sqlite'), 'utf8'), 'destination-db');
  await assert.rejects(fs.stat(path.join(projectRoot, '.instance-migration.lock')), { code: 'ENOENT' });
  await fs.rename(path.join(projectRoot, 'instance'), path.join(projectRoot, 'existing-instance'));
  await write(projectRoot, 'data/pot.sqlite.scrape.lock', '{}');
  await assert.rejects(migrateLegacyInstance({ projectRoot }), /scrape lock/);
  assert.equal(await fs.readFile(path.join(projectRoot, '.env'), 'utf8'), 'GITHUB_TOKEN=original-test-token');
  await assert.rejects(migrateLegacyInstance({ projectRoot, instanceDir: path.dirname(projectRoot) }), /inside/);
  await assert.rejects(migrateLegacyInstance({ projectRoot, instanceDir: path.join(projectRoot, 'src', 'instance') }), /Invalid instance destination/);
  await assert.rejects(migrateLegacyInstance({ projectRoot, instanceDir: path.join(projectRoot, 'instance_example') }), /Invalid instance destination/);
});

test('migration preserves explicit custom paths and non-path environment values', () => {
  const projectRoot = path.resolve('test-project');
  const instanceDir = path.join(projectRoot, 'instance');
  const result = dotenv.parse(rewriteLegacyPaths('DB_PATH=custom.sqlite\nGITHUB_TOKEN=secret-with-data/path\nTELEGRAM_SESSION="test-session"\nCONTEXT_DIR=src/context\n', { projectRoot, instanceDir }));
  assert.equal(result.DB_PATH, path.join(projectRoot, 'custom.sqlite').split(path.sep).join('/'));
  assert.equal(result.GITHUB_TOKEN, 'secret-with-data/path');
  assert.equal(result.TELEGRAM_SESSION, 'test-session');
  assert.equal(result.CONTEXT_DIR, 'context');
});

test('root environment selects an instance while external settings take precedence', async t => {
  const projectRoot = await fixture(t);
  await write(projectRoot, '.env', 'INSTANCE_DIR=client-one\nTELEGRAM_BOT_TOKEN=root-test-token\n');
  await write(projectRoot, 'client-one/.env', 'TELEGRAM_BOT_TOKEN=must-not-load-nested-env\n');
  const env = {};
  const selected = loadInstanceEnvironment(projectRoot, env);
  assert.equal(selected.envFile, path.join(projectRoot, '.env'));
  assert.equal(selected.instanceDir, path.join(projectRoot, 'client-one'));
  assert.equal(env.TELEGRAM_BOT_TOKEN, 'root-test-token');
  const overridden = { INSTANCE_DIR: 'client-two', TELEGRAM_BOT_TOKEN: 'external-test-token' };
  assert.equal(loadInstanceEnvironment(projectRoot, overridden).instanceDir, path.join(projectRoot, 'client-two'));
  assert.equal(overridden.TELEGRAM_BOT_TOKEN, 'external-test-token');
});

test('runtime resolves root env and instance paths independent of cwd', async t => {
  const instanceDir = await fixture(t);
  const moduleUrl = pathToFileURL(path.join(repository, 'src/config/app.config.js')).href;
  const env = { ...process.env, INSTANCE_DIR: instanceDir, TELEGRAM_BOT_TOKEN: 'external-test-token' };
  for (const key of ['DB_PATH', 'ACCOUNTS_CONFIG_PATH', 'BROWSER_DATA_PATH', 'BROWSER_COOKIES_PATH', 'EXPORTS_DIR']) env[key] = '';
  env.DATA_DIR = 'storage';
  env.CONTEXT_DIR = 'my-context';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {PATHS,DB,BROWSER,TELEGRAM} = await import(' + JSON.stringify(moduleUrl) + '); console.log(JSON.stringify({PATHS,DB,BROWSER,token:TELEGRAM.botToken,workerInstance:process.env.INSTANCE_DIR}));'],
  { env, cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const config = JSON.parse(child.stdout);
  assert.equal(config.PATHS.envFile, path.join(repository, '.env'));
  assert.equal(config.PATHS.contextDir, path.join(instanceDir, 'my-context'));
  assert.equal(config.PATHS.accountsConfig, path.join(instanceDir, 'accounts.json'));
  assert.equal(config.DB.storagePath, path.join(instanceDir, 'storage', 'pot.sqlite'));
  assert.equal(config.BROWSER.dataPath, path.join(instanceDir, 'storage', 'nyra'));
  assert.equal(config.token, 'external-test-token');
  assert.equal(config.workerInstance, instanceDir);
});

test('migration restores intermediate instance env to the root unchanged and detects conflicts', async t => {
  const projectRoot = await fixture(t);
  const original = 'GITHUB_TOKEN=test-private-value\nDATA_DIR=data\n';
  await write(projectRoot, 'instance/.env', original);
  const result = await migrateLegacyInstance({ projectRoot });
  assert.equal(result.moved.length, 1);
  assert.equal(await fs.readFile(path.join(projectRoot, '.env'), 'utf8'), original);
  await assert.rejects(fs.stat(path.join(projectRoot, 'instance/.env')), { code: 'ENOENT' });
  await write(projectRoot, 'instance/.env', 'conflicting-settings');
  await assert.rejects(migrateLegacyInstance({ projectRoot }), /Migration conflict/);
  assert.equal(await fs.readFile(path.join(projectRoot, '.env'), 'utf8'), original);
});

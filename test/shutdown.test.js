import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize } from 'sequelize';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { ScraperOrchestrator } from '../src/core/orchestrator/ScraperOrchestrator.js';
import { Credentials } from '../src/core/secrets/Credentials.js';
import { Vault } from '../src/core/secrets/Vault.js';
import { ScrapeJobs } from '../src/core/mcp/ScrapeJobs.js';
import { JobStore } from '../src/core/services/JobStore.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';
import { abortableSleep } from '../src/shared/shutdown.js';
import { logLevel, print } from '../src/shared/utils.js';

async function fixture(t, accounts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-stop-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify(accounts));
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  return { dir, accountsConfigPath, sequelize, models };
}

test('a stop request ends the run after the current account and keeps the result', async t => {
  const { dir, accountsConfigPath, models } = await fixture(t, [
    { username: 'one', platform: 'linkedin' }, { username: 'two', platform: 'linkedin' }, { username: 'three', platform: 'linkedin' },
  ]);
  const stop = new AbortController();
  const collected = [];
  const orchestrator = new ScraperOrchestrator(models, {
    notify: false, credentials: new Credentials({ legacy: { telegram: {} } }),
    accountsConfigPath, lockPath: path.join(dir, 'lock'),
    collectors: {
      linkedin: { collect: async ({ account }) => {
        collected.push(account.username);
        stop.abort();   // Ctrl+C while the first account is being collected
        return { records: [{ platform: 'linkedin', platform_id: account.username, text: 'x' }] };
      } },
    },
  });
  const run = await orchestrator.run({}, { signal: stop.signal });
  assert.deepEqual(collected, ['one']);
  assert.equal(run.status, 'partial');
  assert.equal(run.accounts_processed, 1);
  assert.match(run.error_message, /Stopped on request: 2 account\(s\) not collected/);
  assert.equal(await models.Post.count(), 1);
  // The lock is released: the next run can start immediately.
  await assert.rejects(fs.access(path.join(dir, 'lock')));
});

test('a stop during the long X pause still saves the X session and closes the browser', async t => {
  const { dir, accountsConfigPath, models } = await fixture(t, [
    { username: 'a1', platform: 'twitter', session: 'brand' }, { username: 'a2', platform: 'twitter', session: 'brand' },
  ]);
  const vault = await new Vault(path.join(dir, 'secrets.vault')).create('correct horse battery');
  const loggedIn = value => ({ cookies: [{ name: 'auth_token', value, domain: '.x.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }], origins: [] });
  await vault.set('twitter', 'brand', loggedIn('old'));
  const stop = new AbortController();
  let browserClosed = false;
  let pauses = 0;
  const orchestrator = new ScraperOrchestrator(models, {
    notify: false, credentials: new Credentials({ vault, legacy: { telegram: {} } }),
    // Skip the random wake-up pause; the long pause between profiles is real.
    pause: (ms, signal) => (pauses++ === 0 ? Promise.resolve() : abortableSleep(ms, signal)),
    accountsConfigPath, lockPath: path.join(dir, 'lock'),
    browserFactory: () => ({
      async launch() {},
      async close() { browserClosed = true; },
      async openSession(name) {
        return { name, newPage: async () => ({ close: async () => {} }), hasAuth: async () => true,
          storageState: async () => loggedIn('refreshed'), close: async () => {} };
      },
    }),
    collectors: {
      twitter: { collect: async ({ session, runtime }) => {
        await runtime.twitterSession(session);
        // Stop arrives during the 5–15 min pause before the next profile.
        setTimeout(() => stop.abort(), 20);
        return { records: [] };
      } },
    },
  });
  const started = Date.now();
  const run = await orchestrator.run({}, { signal: stop.signal });
  assert.ok(Date.now() - started < 5_000, 'the human pause must be cut short');
  assert.equal(run.status, 'partial');
  assert.equal(browserClosed, true);
  assert.equal(vault.get('twitter', 'brand').cookies[0].value, 'refreshed');
});

test('stopping before any account records a clear failure, not "all accounts failed"', async t => {
  const { dir, accountsConfigPath, models } = await fixture(t, [{ username: 'one', platform: 'linkedin' }]);
  const stop = new AbortController();
  stop.abort();
  const run = await new ScraperOrchestrator(models, {
    notify: false, credentials: new Credentials({ legacy: { telegram: {} } }), accountsConfigPath,
    lockPath: path.join(dir, 'lock'), collectors: { linkedin: { collect: async () => ({ records: [] }) } },
  }).run({}, { signal: stop.signal });
  assert.equal(run.status, 'failed');
  assert.equal(run.error_message, 'Stopped on request before any account was collected.');
});

test('jobs are stopped through the worker, and shutdown waits before killing', async t => {
  const { sequelize } = await fixture(t, []);
  const store = new JobStore(sequelizeExecutor(sequelize), { isAlive: () => true });
  const children = [];
  const jobs = new ScrapeJobs({ store, getVaultKey: async () => null, spawn: () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.messages = [];
    child.killed = false;
    child.send = (message, callback) => { child.messages.push(message); callback?.(); if (message.type === 'stop' && child.stopsQuickly) setTimeout(() => { child.exitCode = 0; child.emit('exit', 0, null); }, 10); };
    child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM'); };
    children.push(child);
    return child;
  } });
  const job = await jobs.start({});
  const result = await jobs.stop(job.job_id);
  assert.equal(result.stopping, true);
  assert.deepEqual(children[0].messages.at(-1), { type: 'stop' });

  children[0].stopsQuickly = true;
  await jobs.shutdown({ timeoutMs: 1000 });
  assert.equal(children[0].killed, false, 'a worker that stops in time is not killed');

  await store.finish(job.job_id, { status: 'partial' });
  const second = await jobs.start({});
  await jobs.shutdown({ timeoutMs: 30 });   // ignores the stop request
  assert.equal(children[1].killed, true);
  assert.match((await jobs.stop(second.job_id)).note ?? '', /already finished|failed/);
});

test('abortable sleep and log levels', async t => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  await abortableSleep(10_000, controller.signal);
  assert.ok(Date.now() - started < 2_000);

  const previous = process.env.LOG_LEVEL;
  t.after(() => { if (previous === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previous; });
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(line);
  try {
    process.env.LOG_LEVEL = 'warn';
    print('info line', 'info');
    print('warn line', 'warning');
    process.env.LOG_LEVEL = 'nonsense';
    assert.equal(logLevel(), 1);
    print('back to info', 'system');
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /warn line/);
  assert.match(lines[1], /back to info/);
});

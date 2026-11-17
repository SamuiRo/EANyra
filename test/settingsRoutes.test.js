import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Vault } from '../src/core/secrets/Vault.js';
import { unlockSharedVault } from '../src/core/secrets/vaultAccess.js';

// Never let these tests reach the real instance (its vault may be unlocked by a remembered key).
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-settings-env-'));
process.env.VAULT_PATH = path.join(sandbox, 'secrets.vault');
process.env.NOTIFICATIONS_CONFIG_PATH = path.join(sandbox, 'notifications.json');
process.env.ACCOUNTS_CONFIG_PATH = path.join(sandbox, 'accounts.json');
test.after(() => fs.rm(sandbox, { recursive: true, force: true }));
const { buildSettingsRoutes } = await import('../src/web/settingsRoutes.js');

async function setup(t, { vault = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const accountsFile = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsFile, JSON.stringify([
    { username: 'me', platform: 'linkedin', import_file: 'me.csv' },
    { username: 'old', platform: 'linkedin', archive: true },
    { username: 'brand_x', platform: 'twitter' },
  ]));
  const started = [];
  const vaultFile = path.join(dir, 'secrets.vault');
  if (vault) {
    await new Vault(vaultFile).create('correct horse battery');
    await unlockSharedVault('correct horse battery', { filePath: vaultFile }); // what the web login does
  }
  const keyStore = { remembered: false, calls: [], available: () => true,
    isRemembered: async () => keyStore.remembered,
    remember: async () => { keyStore.calls.push('remember'); keyStore.remembered = true; },
    forget: async () => { keyStore.calls.push('forget'); keyStore.remembered = false; return true; } };
  const routes = buildSettingsRoutes({
    hasVault: vault, vaultFile, keyStore, jobs: { start: async selection => { started.push(selection); return { id: 'job-1' }; } },
    backupsDir: path.join(dir, 'backups'), efs: { available: () => false, status: async () => ({}) },
    notifyFile: path.join(dir, 'notifications.json'), accountsFile, importsDir: path.join(dir, 'imports'),
  });
  return { dir, routes, started, vaultFile, keyStore };
}

test('settings summary lists active LinkedIn accounts and backups', async t => {
  const { dir, routes } = await setup(t);
  await fs.mkdir(path.join(dir, 'backups', 'eanyra-1'), { recursive: true });
  await fs.writeFile(path.join(dir, 'backups', 'eanyra-1', 'manifest.json'),
    JSON.stringify({ created_at: '2026-11-17T10:00:00Z', app_version: '2.2.0', files: [{ bytes: 10 }, { bytes: 5 }] }));
  await fs.mkdir(path.join(dir, 'backups', 'not-a-backup'));
  const s = await routes['GET /api/settings']();
  assert.deepEqual(s.linkedin.accounts, [{ username: 'me', import_file: 'me.csv' }]);
  assert.deepEqual(s.backups, [{ name: 'eanyra-1', created_at: '2026-11-17T10:00:00Z', version: '2.2.0', files: 2, bytes: 15 }]);
  assert.equal(s.notify.configured, false);
  assert.equal(s.efs.available, false);
  assert.equal(s.vault.encrypted, false);
});

test('alert settings merge with the file and reject invalid changes', async t => {
  const { dir, routes } = await setup(t);
  const file = path.join(dir, 'notifications.json');
  await routes['POST /api/settings/notify']({ body: { telegram: { enabled: true, bot: 'default', chat_id: '42' } } });
  await routes['POST /api/settings/notify']({ body: { telegram: { enabled: false }, rules: { stale_hours: 12 } } });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.telegram, { enabled: false, bot: 'default', chat_id: '42' });
  assert.equal(saved.rules.stale_hours, 12);
  await assert.rejects(routes['POST /api/settings/notify']({ body: { rules: { stale_hours: -1 } } }), error => error.status === 400);
  await routes['POST /api/settings/notify']({ body: { telegram: null } });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).telegram, null);
});

test('a Discord webhook is validated before touching the vault', async t => {
  const { routes } = await setup(t);
  for (const url of ['', 'http://discord.com/api/webhooks/1/x', 'https://evil.example/api/webhooks/1/x']) {
    await assert.rejects(routes['POST /api/settings/notify/discord-webhook']({ body: { url } }), error => error.status === 400, url);
  }
  await assert.rejects(routes['POST /api/settings/notify/discord-webhook']({ body: { url: 'https://discord.com/api/webhooks/1/x' } }),
    error => error.status === 409 && /Створити сховище/.test(error.message));
});

test('LinkedIn upload checks the account and the CSV, saves it and starts an import', async t => {
  const { dir, routes, started } = await setup(t);
  const upload = body => routes['POST /api/settings/linkedin/upload']({ body });
  const csv = 'Date,ShareLink,ShareCommentary\n2026-11-01 10:00:00,https://www.linkedin.com/feed/update/urn:li:share:1,Hello\n';
  await assert.rejects(upload({ account: 'old', content: csv }), error => error.status === 404);
  await assert.rejects(upload({ account: 'brand_x', content: csv }), error => error.status === 404);
  await assert.rejects(upload({ account: 'me', content: 'Name,Email\nx,y\n' }), error => error.status === 400 && /Date/.test(error.message));
  const result = await upload({ account: 'me', content: csv });
  assert.deepEqual(result, { saved: 'me.csv', job: { id: 'job-1' } });
  assert.equal(await fs.readFile(path.join(dir, 'imports', 'me.csv'), 'utf8'), csv);
  assert.deepEqual(started, [{ platform: 'linkedin', accounts: ['me'] }]);
});

test('operations that need the vault or the database say so', async t => {
  const { routes } = await setup(t);
  await assert.rejects(routes['POST /api/settings/backup']({ body: {} }), error => error.status === 501);
  await assert.rejects(routes['POST /api/settings/mcp-token']({ body: {} }), error => error.status === 409);
  await assert.rejects(routes['POST /api/settings/vault/password']({ body: { current: 'x', next: 'y', repeat: 'y' } }), error => error.status === 403);
});

test('with a vault: webhook, MCP token shown once, remember and password change', async t => {
  const { dir, routes, vaultFile, keyStore } = await setup(t, { vault: true });
  const url = 'https://discord.com/api/webhooks/1/x';
  await routes['POST /api/settings/notify/discord-webhook']({ body: { url } });
  const opened = new Vault(vaultFile);
  await opened.unlock('correct horse battery');
  assert.equal(opened.get('discord-webhook', 'default').url, url);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'notifications.json'), 'utf8')).discord, { enabled: true, webhook: 'default' });
  const summary = await routes['GET /api/settings']();
  assert.equal(summary.notify.discord.webhook_set, true);
  assert.equal(JSON.stringify(summary).includes(url), false, 'secrets never leave the server');

  const first = await routes['POST /api/settings/mcp-token']({ body: {} });
  assert.match(first.header, /^Authorization: Bearer [\w-]{43}$/);
  await assert.rejects(routes['POST /api/settings/mcp-token']({ body: {} }), error => error.status === 409);
  const second = await routes['POST /api/settings/mcp-token']({ body: { rotate: true } });
  assert.notEqual(second.token, first.token);

  await routes['POST /api/settings/vault/remember']();
  const change = body => routes['POST /api/settings/vault/password']({ body });
  await assert.rejects(change({ current: 'wrong password!', next: 'another long one', repeat: 'another long one' }), error => error.status === 403);
  await assert.rejects(change({ current: 'correct horse battery', next: 'another long one', repeat: 'different one!!' }), error => error.status === 400);
  assert.deepEqual(await change({ current: 'correct horse battery', next: 'another long one', repeat: 'another long one' }),
    { changed: true, remembered_refreshed: true });
  assert.deepEqual(keyStore.calls, ['remember', 'remember']);
  await new Vault(vaultFile).unlock('another long one');
  await routes['POST /api/settings/vault/forget']();
  assert.equal(keyStore.remembered, false);
});

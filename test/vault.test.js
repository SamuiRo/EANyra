import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize } from 'sequelize';

import { Vault } from '../src/core/secrets/Vault.js';
import { open, seal } from '../src/core/secrets/crypto.js';
import { Credentials } from '../src/core/secrets/Credentials.js';
import { blankEnvKeys, importLegacySecrets } from '../src/core/secrets/migrateLegacy.js';
import { sessionReport } from '../src/core/cli/vaultCommands.js';
import { validateAccounts } from '../src/config/accountConfig.js';
import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { ScraperOrchestrator } from '../src/core/orchestrator/ScraperOrchestrator.js';
import { TelegramPublisher } from '../src/platforms/telegram/TelegramPublisher.js';

const PASSWORD = 'correct horse battery';
const loggedIn = (value = 'token') => ({
  cookies: [{ name: 'auth_token', value, domain: '.x.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }],
  origins: [],
});

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-vault-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('vault encrypts at rest, rejects a wrong password and detects tampering', async t => {
  const file = path.join(await tempDir(t), 'secrets.vault');
  const vault = await new Vault(file).create(PASSWORD);
  await vault.set('github', 'work', { token: 'ghp_super_secret_value' });
  await vault.set('twitter', 'brand-a', loggedIn('cookie-secret'));

  const raw = await fs.readFile(file, 'utf8');
  for (const secret of ['ghp_super_secret_value', 'cookie-secret', 'github/work', 'brand-a']) {
    assert.equal(raw.includes(secret), false, `${secret} must not be stored in plaintext`);
  }

  const reopened = await new Vault(file).unlock(PASSWORD);
  assert.equal(reopened.get('github', 'work').token, 'ghp_super_secret_value');
  assert.deepEqual(reopened.list().map(item => `${item.kind}/${item.name}`), ['github/work', 'twitter/brand-a']);
  await assert.rejects(new Vault(file).unlock('wrong password!!'), error => error.code === 'VAULT_DECRYPT_FAILED');

  const envelope = JSON.parse(raw);
  await assert.rejects(new Vault(file).create(PASSWORD), /already exists/);
  // Weakening the KDF in the header breaks authentication.
  assert.throws(() => open(Buffer.alloc(32), { ...envelope }), /Wrong master password/);
  const key = Buffer.from(reopened.exportKey().key, 'base64');
  assert.throws(() => open(key, { ...envelope, kdf: { ...envelope.kdf, N: 2 ** 14 } }), /Wrong master password/);
  const flipped = Buffer.from(envelope.ciphertext, 'base64');
  flipped[0] ^= 1;
  assert.throws(() => open(key, { ...envelope, ciphertext: flipped.toString('base64') }), /Wrong master password/);
  assert.deepEqual(open(key, seal(key, envelope.kdf, { a: 1 })), { a: 1 });
});

test('concurrent writers through separate handles keep each other\'s secrets', async t => {
  const file = path.join(await tempDir(t), 'secrets.vault');
  const first = await new Vault(file).create(PASSWORD);
  const second = await new Vault(file).unlockWithKey(first.exportKey());
  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) => first.set('github', `a${i}`, { token: `a${i}` })),
    ...Array.from({ length: 5 }, (_, i) => second.set('telegram', `b${i}`, { session: `b${i}` })),
  ]);
  const check = await new Vault(file).unlock(PASSWORD);
  assert.equal(check.list().length, 10);
  assert.equal(await check.delete('github', 'a0'), true);
  assert.equal(await check.delete('github', 'a0'), false);
});

test('changing the password invalidates handed-over and remembered keys', async t => {
  const file = path.join(await tempDir(t), 'secrets.vault');
  const vault = await new Vault(file).create(PASSWORD);
  await vault.set('github', 'default', { token: 't' });
  const oldKey = vault.exportKey();
  await vault.changePassword('another long password');
  await assert.rejects(new Vault(file).unlockWithKey(oldKey), /older master password/);
  await assert.rejects(new Vault(file).unlock(PASSWORD), /Wrong master password/);
  assert.equal((await new Vault(file).unlock('another long password')).get('github').token, 't');
  await assert.rejects(new Vault(path.join(path.dirname(file), 'x.vault')).create('short'), /at least 10/);
});

test('credentials resolve each named session and refuse named sessions without a vault', async t => {
  const dir = await tempDir(t);
  const legacy = {
    telegram: { apiId: 1, apiHash: 'h', session: 'env-session', botToken: 'env-bot' },
    githubToken: 'env-gh', cookiesPath: path.join(dir, 'cookies.json'), envFile: path.join(dir, '.env'),
  };
  const plain = new Credentials({ legacy });
  assert.equal(plain.encrypted, false);
  assert.equal(plain.telegramConfig().session, 'env-session');
  assert.equal(plain.githubToken(), 'env-gh');
  assert.throws(() => plain.githubToken('work'), /needs the encrypted vault/);
  assert.equal(await plain.twitterState(), null);

  const vault = await new Vault(path.join(dir, 'secrets.vault')).create(PASSWORD);
  const credentials = new Credentials({ vault, legacy });
  await vault.set('telegram', 'work', { session: 'work-session' });
  await vault.set('telegram-api', 'default', { api_id: 42, api_hash: 'vault-hash' });
  await vault.set('telegram-bot', 'news', { token: 'news-bot' });
  await vault.set('github', 'work', { token: 'work-gh' });
  await credentials.saveTwitterState('brand-a', loggedIn('a'));
  await assert.rejects(credentials.saveTwitterState('brand-b', { cookies: [], origins: [] }), /auth_token/);

  assert.deepEqual(
    (({ apiId, apiHash, session, sessionName }) => ({ apiId, apiHash, session, sessionName }))(credentials.telegramConfig('work')),
    { apiId: 42, apiHash: 'vault-hash', session: 'work-session', sessionName: 'work' },
  );
  assert.equal(credentials.telegramConfig('missing').session, '');
  // The default session falls back to not-yet-migrated .env values.
  assert.equal(credentials.telegramConfig().session, 'env-session');
  assert.equal(credentials.botToken('news'), 'news-bot');
  assert.equal(credentials.botToken('other'), '');
  assert.equal(credentials.githubToken('work'), 'work-gh');
  assert.equal((await credentials.twitterState('brand-a')).cookies[0].value, 'a');
  assert.equal(await credentials.twitterState('brand-b'), null);
});

test('legacy migration imports plaintext secrets once and blanking .env keeps other values', async t => {
  const dir = await tempDir(t);
  const cookiesPath = path.join(dir, 'cookies.json');
  await fs.writeFile(cookiesPath, JSON.stringify(loggedIn('cache').cookies));
  const vault = await new Vault(path.join(dir, 'secrets.vault')).create(PASSWORD);
  const options = {
    telegram: { session: 'tg', apiId: 5, apiHash: 'hash', botToken: 'bot' }, githubToken: 'gh',
    cookiesPath, profileDir: path.join(dir, 'missing-profile'),
  };
  const imported = await importLegacySecrets(vault, options);
  assert.equal(imported.length, 5);
  assert.equal(vault.get('twitter').cookies[0].value, 'cache');
  assert.deepEqual(vault.get('telegram-api'), { api_id: 5, api_hash: 'hash' });
  assert.deepEqual(await importLegacySecrets(vault, { ...options, githubToken: 'changed' }), []);
  assert.equal(vault.get('github').token, 'gh');

  const raw = '# comment\r\nGITHUB_TOKEN=gh\r\nexport TELEGRAM_SESSION="tg"\r\nOTHER="a # b"\r\nDB_PATH=x.sqlite\r\n';
  const updated = blankEnvKeys(raw, ['GITHUB_TOKEN', 'TELEGRAM_SESSION']);
  assert.equal(updated, '# comment\r\nGITHUB_TOKEN=\r\nTELEGRAM_SESSION=\r\nOTHER="a # b"\r\nDB_PATH=x.sqlite\r\n');
});

test('session report shows missing, expired and unused logins per account', async t => {
  const vault = await new Vault(path.join(await tempDir(t), 'secrets.vault')).create(PASSWORD);
  const now = Date.parse('2026-11-16T00:00:00Z');
  await vault.set('twitter', 'brand-a', { cookies: [{ name: 'auth_token', expires: now / 1000 + 3 * 86_400 }] });
  await vault.set('twitter', 'old', { cookies: [{ name: 'auth_token', expires: now / 1000 - 10 }] });
  await vault.set('github', 'spare', { token: 't' });
  const entries = validateAccounts([
    { username: 'one', platform: 'twitter', session: 'brand-a' },
    { username: 'two', platform: 'twitter', session: 'old' },
    { username: 'three', platform: 'twitter', session: 'brand-c' },
    { username: 'chan', platform: 'telegram', publish_enabled: true, bot: 'news' },
  ]);
  const rows = Object.fromEntries(sessionReport(entries, vault, now).map(row => [`${row.kind}/${row.name}`, row]));
  assert.match(rows['twitter/brand-a'].state, /3 more day/);
  assert.equal(rows['twitter/old'].state, 'EXPIRED');
  assert.equal(rows['twitter/brand-c'].state, 'MISSING');
  assert.deepEqual(rows['telegram-bot/news'].accounts, ['telegram/chan (publish)']);
  assert.deepEqual(rows['telegram/default'].accounts, ['telegram/chan']);
  assert.deepEqual(rows['github/spare'].accounts, []);
});

test('orchestrator isolates a failing login to its own accounts', async t => {
  const dir = await tempDir(t);
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify([
    { username: 'good_one', platform: 'telegram', session: 'good' },
    { username: 'bad_one', platform: 'telegram', session: 'bad' },
    { username: 'bad_two', platform: 'telegram', session: 'bad' },
    { username: 'x_one', platform: 'twitter', session: 'nologin' },
    { username: 'x_two', platform: 'twitter', session: 'nologin' },
  ]));
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();

  const vault = await new Vault(path.join(dir, 'secrets.vault')).create(PASSWORD);
  await vault.set('telegram', 'good', { session: 'good-string' });
  await vault.set('telegram', 'bad', { session: 'bad-string' });
  const connects = [];
  const opened = [];
  const orchestrator = new ScraperOrchestrator(models, {
    credentials: new Credentials({ vault, legacy: { telegram: { apiId: 1, apiHash: 'h' } } }),
    accountsConfigPath,
    lockPath: path.join(dir, 'scrape.lock'),
    pause: async () => {},
    telegramFactory: config => ({
      async connect() {
        connects.push(config.session);
        if (config.session === 'bad-string') throw new Error('AUTH_KEY_UNREGISTERED');
      },
      async disconnect() {},
      async scrapeAccount() { return []; },
    }),
    browserFactory: () => ({
      async launch() {},
      async close() {},
      async openSession(name, state) {
        opened.push([name, state]);
        throw Object.assign(new Error(`X session "${name}" is not logged in.`), { code: 'TWITTER_SESSION_MISSING' });
      },
    }),
  });
  const run = await orchestrator.run();
  const saved = await models.ScraperRun.findByPk(run.id);
  assert.equal(saved.status, 'partial');
  assert.equal(saved.accounts_processed, 1);
  // One connection attempt per login, not per account.
  assert.deepEqual(connects.sort(), ['bad-string', 'good-string']);
  assert.deepEqual(opened, [['nologin', null]]);
  assert.match(saved.error_message, /bad_two \(telegram\) skipped: AUTH_KEY_UNREGISTERED/);
  assert.match(saved.error_message, /x_two \(twitter\) skipped: X session "nologin" is not logged in/);
});

test('each Telegram channel publishes through its own configured bot', async () => {
  const used = [];
  const publisher = new TelegramPublisher({
    outbox: {},
    loadAccounts: async () => validateAccounts([
      { username: 'chan_a', platform: 'telegram', publish_enabled: true, bot: 'bot-a' },
      { username: 'chan_b', platform: 'telegram', publish_enabled: true },
    ]),
    gatewayFor: entry => ({
      async identity() { used.push(entry.bot ?? 'default'); return { username: entry.bot ?? 'default' }; },
      async close() {},
    }),
  });
  assert.deepEqual(await publisher.identity({ account: 'chan_a' }), { username: 'bot-a' });
  assert.deepEqual(await publisher.identity({ account: 'chan_b' }), { username: 'default' });
  assert.deepEqual(await publisher.identity(), { username: 'default' });
  await assert.rejects(publisher.identity({ account: 'chan_c' }), /not enabled/);
  assert.deepEqual((await publisher.targets()).map(target => target.bot ?? null), ['bot-a', null]);
});

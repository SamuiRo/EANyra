import assert from 'node:assert/strict';
import test from 'node:test';
import { Sequelize } from 'sequelize';

import { validateNotifyConfig, DEFAULT_RULES } from '../src/config/notifyConfig.js';
import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';
import { detectProblems } from '../src/core/notify/problems.js';
import { Notifier, formatDigest } from '../src/core/notify/Notifier.js';
import { telegramChannel, discordChannel, telegramChatsOf, assertDiscordWebhook } from '../src/core/notify/channels.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const HOUR = 36e5;

async function database(t) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  return { sequelize, models, db: sequelizeExecutor(sequelize) };
}

test('notification config is validated and filled with default rules', () => {
  const config = validateNotifyConfig({ telegram: { chat_id: 12345 }, discord: { webhook: 'ops' }, rules: { stale_hours: 72 } });
  assert.deepEqual(config.telegram, { enabled: true, bot: 'default', chat_id: '12345' });
  assert.deepEqual(config.discord, { enabled: true, webhook: 'ops' });
  assert.deepEqual(config.rules, { ...DEFAULT_RULES, stale_hours: 72 });
  assert.throws(() => validateNotifyConfig({ telegram: { chat_id: 'me' } }), /chat_id/);
  assert.throws(() => validateNotifyConfig({ rules: { spam: true } }), /not a known rule/);
  assert.throws(() => validateNotifyConfig({ rules: { notify_resolved: 'yes' } }), /true or false/);
  assert.throws(() => validateNotifyConfig([]), /JSON object/);
});

test('problems cover logins, failing and stale accounts, failed runs and uncertain posts', async t => {
  const { models, db, sequelize } = await database(t);
  await models.Account.create({ username: 'a', platform: 'twitter', last_error: 'X session "brand" is not logged in.' });
  await models.Account.create({ username: 'b', platform: 'twitter', last_error: 'skipped: X session "brand" is not logged in.' });
  await models.Account.create({ username: 'old', platform: 'telegram', last_scraped_at: new Date(NOW - 5 * 24 * HOUR) });
  await models.Account.create({ username: 'fresh', platform: 'telegram', last_scraped_at: new Date(NOW - HOUR) });
  await models.Account.create({ username: 'new', platform: 'telegram' });
  await models.ScraperRun.create({ status: 'failed', started_at: new Date(NOW - HOUR), error_message: 'Another scrape is running.' });
  await sequelize.query(`INSERT INTO telegram_outbox (request_id, account, text, content_hash, random_id, disable_preview, status, created_at, updated_at)
    VALUES ('r1', 'chan', 't', 'h', 'r', 1, 'unknown', ?, ?), ('r2', 'chan', 't', 'h', 'r', 1, 'sending', ?, ?)`,
  { replacements: [new Date(NOW - HOUR).toISOString(), new Date(NOW - HOUR).toISOString(), NOW.toISOString(), NOW.toISOString()] });

  const problems = await detectProblems(db, {
    rules: DEFAULT_RULES, now: NOW,
    sessions: [
      { kind: 'twitter', name: 'brand', state: 'EXPIRED', ok: false, accounts: ['twitter/a', 'twitter/b'] },
      { kind: 'twitter', name: 'soon', state: 'ok · auth cookie valid 2 more day(s)', ok: true, accounts: ['twitter/c'] },
      { kind: 'twitter', name: 'later', state: 'ok · auth cookie valid 40 more day(s)', ok: true, accounts: ['twitter/d'] },
      { kind: 'github', name: 'spare', state: 'MISSING', ok: false, accounts: [] },
    ],
  });
  const keys = problems.map(problem => problem.key);
  assert.deepEqual(keys.filter(key => !key.startsWith('error:')), [
    'session:twitter/brand', 'expiring:twitter/soon', 'stale:telegram/old', 'run-failed', 'publish:r1',
  ]);
  // Both accounts failing for the same reason become one problem.
  const errors = problems.filter(problem => problem.key.startsWith('error:'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /Акаунти: twitter\/a, twitter\/b/);
  assert.match(problems.find(p => p.key === 'expiring:twitter/soon').text, /2 дн.*import-cookies -- --session soon/);
});

test('alerts are sent once, repeated after repeat_hours, and resolved once', async t => {
  const { db } = await database(t);
  let now = NOW;
  const sent = [];
  const notifier = new Notifier(db, { channels: [{ name: 'fake', send: async text => { sent.push(text); } }], rules: DEFAULT_RULES, now: () => now });
  const login = { key: 'session:twitter/brand', text: '🔑 X login expired' };
  const stale = { key: 'stale:telegram/old', text: '🕒 old stale' };

  assert.equal((await notifier.notify([login, stale])).sent, true);
  assert.match(sent[0], /Нові проблеми \(2\):\n• 🔑 X login expired\n• 🕒 old stale/);

  now = new Date(NOW.getTime() + HOUR);
  assert.equal((await notifier.notify([login, stale])).sent, false);   // no spam
  assert.equal(sent.length, 1);

  now = new Date(NOW.getTime() + 25 * HOUR);
  await notifier.notify([login]);                                     // stale fixed, login still broken
  assert.match(sent[1], /Досі не вирішено \(1\):\n• 🔑 X login expired/);
  assert.match(sent[1], /✅ Вирішено \(1\):\n• 🕒 old stale/);

  now = new Date(NOW.getTime() + 26 * HOUR);
  await notifier.notify([]);
  assert.match(sent[2], /✅ Вирішено \(1\):\n• 🔑 X login expired/);
  await notifier.notify([]);
  assert.equal(sent.length, 3);
  assert.equal(formatDigest({ fresh: [], repeat: [], resolved: [] }), '');
});

test('a failed delivery is retried; one working channel is enough', async t => {
  const { db } = await database(t);
  let telegramUp = false;
  const sent = [];
  const channels = [
    { name: 'telegram', send: async text => { if (!telegramUp) throw new Error('timeout'); sent.push(['telegram', text]); } },
  ];
  const notifier = new Notifier(db, { channels, rules: DEFAULT_RULES, now: () => NOW });
  const problem = { key: 'run-failed', text: '⛔ failed' };

  const first = await notifier.notify([problem]);
  assert.deepEqual(first, { sent: false, delivered: [], failed: ['telegram: timeout'], digest: first.digest });
  telegramUp = true;
  assert.equal((await notifier.notify([problem])).sent, true);   // still "new": retried
  assert.equal(sent.length, 1);

  channels.push({ name: 'discord', send: async () => { throw new Error('HTTP 404'); } });
  const resolved = await notifier.notify([]);
  assert.deepEqual([resolved.delivered, resolved.failed], [['telegram'], ['discord: HTTP 404']]);

  // Without channels nothing is recorded, so alerts start once one is set up.
  const silent = new Notifier(db, { channels: [], rules: DEFAULT_RULES, now: () => NOW });
  assert.equal((await silent.notify([problem])).sent, false);
  assert.equal((await notifier.notify([problem])).digest.fresh.length, 1);
});

test('channels send plain text without leaking secrets or pinging everyone', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.includes('fail')) return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }), { status: 403 });
    if (url.endsWith('/getUpdates')) {
      return new Response(JSON.stringify({ ok: true, result: [
        { message: { chat: { id: 42, type: 'private', first_name: 'Me' } } },
        { message: { chat: { id: 42, type: 'private', first_name: 'Me' } } },
        { my_chat_member: { chat: { id: -100, type: 'group', title: 'Ops' } } },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await telegramChannel({ token: 'TOKEN', chatId: '42', fetchImpl }).send('x'.repeat(5000));
  assert.equal(calls[0].body.chat_id, '42');
  assert.equal(calls[0].body.text.length, 4000);
  await assert.rejects(telegramChannel({ token: 'fail-TOKEN', chatId: '42', fetchImpl }).send('x'),
    error => /bot was blocked/.test(error.message) && !error.message.includes('TOKEN'));
  assert.throws(() => telegramChannel({ token: '', chatId: '1' }), /No Telegram bot token/);

  await discordChannel({ url: 'https://discord.com/api/webhooks/1/abc', fetchImpl }).send('@everyone hi');
  assert.deepEqual(calls.at(-1).body.allowed_mentions, { parse: [] });
  for (const bad of ['http://discord.com/api/webhooks/1/a', 'https://evil.example/api/webhooks/1/a', 'https://discord.com/other']) {
    assert.throws(() => assertDiscordWebhook(bad), /discord\.com\/api\/webhooks/);
  }
  assert.deepEqual(await telegramChatsOf('TOKEN', fetchImpl), [
    { id: '42', type: 'private', title: 'Me' }, { id: '-100', type: 'group', title: 'Ops' },
  ]);
});

test('every collection run checks for problems; alert failures never fail the run', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { ScraperOrchestrator } = await import('../src/core/orchestrator/ScraperOrchestrator.js');
  const { Credentials } = await import('../src/core/secrets/Credentials.js');
  const { models } = await database(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-notify-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify([{ username: 'me', platform: 'linkedin' }]));
  const checks = [];
  const make = notify => new ScraperOrchestrator(models, {
    credentials: new Credentials({ legacy: { telegram: {} } }), accountsConfigPath, lockPath: path.join(dir, 'lock'),
    pause: async () => {}, collectors: { linkedin: { collect: async () => ({ records: [] }) } }, notify,
  });
  await make(async args => { checks.push(args); return { configured: true, result: { sent: true, delivered: ['fake'], failed: [] } }; }).run();
  assert.equal(checks.length, 1);
  assert.ok(checks[0].db && checks[0].credentials);
  assert.equal(checks[0].accountsConfigPath, accountsConfigPath);
  const run = await make(async () => { throw new Error('Telegram is down'); }).run();
  assert.equal(run.status, 'success');
});

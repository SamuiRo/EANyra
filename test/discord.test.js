import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize, QueryTypes } from 'sequelize';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { ScraperOrchestrator } from '../src/core/orchestrator/ScraperOrchestrator.js';
import { Credentials } from '../src/core/secrets/Credentials.js';
import { Vault } from '../src/core/secrets/Vault.js';
import { COLLECTORS } from '../src/platforms/collectors.js';
import { DiscordClient, isQuestion, messageToSignal, newerId } from '../src/platforms/discord/DiscordClient.js';
import { validateAccounts } from '../src/config/accountConfig.js';
import { sessionReport } from '../src/core/secrets/sessionReport.js';

const CHANNEL = '111111111111111111';
const msg = (id, content, extra = {}) => ({ id: String(id), content, type: 0, timestamp: '2026-11-15T10:00:00Z', author: { username: 'fan', global_name: 'Fan' }, ...extra });

/** A fake Discord API: newest-first pages, `after` support, call log. */
function fakeDiscord(messages, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    const parsed = new URL(url);
    calls.push(parsed.pathname + parsed.search);
    if (status !== 200) return new Response('{}', { status });
    if (parsed.pathname.endsWith(`/channels/${CHANNEL}`)) {
      return Response.json({ id: CHANNEL, guild_id: '999999999999999999', name: 'feedback' });
    }
    const after = parsed.searchParams.get('after');
    const limit = Number(parsed.searchParams.get('limit'));
    const sorted = [...messages].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
    const page = after
      ? sorted.filter(m => BigInt(m.id) > BigInt(after)).slice(-limit)   // the oldest ones right after `after`
      : sorted.slice(0, limit);
    return Response.json(page);
  };
  return { fetchImpl, calls };
}

test('only real questions become signals by default; bots and system messages never do', () => {
  assert.equal(isQuestion('How do you handle sessions for 10 accounts?'), true);
  assert.equal(isQuestion('ok?'), false);
  assert.equal(isQuestion('https://example.com/?a=1'), false);
  const opts = { channelId: CHANNEL, guildId: '9', channelName: 'feedback' };
  const signal = messageToSignal(msg(5, 'Does the vault work on Linux too?', { reactions: [{ count: 3 }, { count: 2 }] }), opts);
  assert.equal(signal.signal_type, 'question');
  assert.equal(signal.source_id, `${CHANNEL}:5`);
  assert.equal(signal.url, `https://discord.com/channels/9/${CHANNEL}/5`);
  assert.deepEqual(signal.metadata, { channel: 'feedback', author: 'Fan', reactions: 5, reply: false });
  assert.equal(messageToSignal(msg(6, 'Love the new release'), opts), null);
  assert.equal(messageToSignal(msg(6, 'Love the new release'), { ...opts, filter: 'all' }).signal_type, 'community_message');
  assert.equal(messageToSignal(msg(7, 'Am I a bot? Yes I am really', { author: { bot: true } }), opts), null);
  assert.equal(messageToSignal(msg(8, 'Pinned a message somewhere?', { type: 6 }), opts), null);
  assert.equal(newerId('1311000000000000001', '1311000000000000002'), '1311000000000000002');
});

test('channels are configured by numeric id and the bot token is its own session kind', () => {
  assert.throws(() => validateAccounts([{ username: 'feedback', platform: 'discord' }]), /numeric channel id/);
  assert.throws(() => validateAccounts([{ username: CHANNEL, platform: 'discord', discord_filter: 'everything' }]), /questions" or "all/);
  assert.throws(() => validateAccounts([{ username: 'x', platform: 'twitter', discord_filter: 'all' }]), /only for Discord/);
  const entries = validateAccounts([{ username: CHANNEL, platform: 'discord', session: 'community' }]);
  const rows = sessionReport(entries, null);
  assert.deepEqual(rows.map(row => [row.kind, row.name, row.accounts]), [['discord-bot', 'community', [`discord/${CHANNEL}`]]]);
});

test('collection is incremental from the last seen message and pages forward', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-discord-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify([{ username: CHANNEL, platform: 'discord' }]));
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const vault = await new Vault(path.join(dir, 'secrets.vault')).create('correct horse battery');
  await vault.set('discord-bot', 'default', { token: 'BOT-TOKEN' });

  const base = 1311000000000000000n;
  const messages = [msg(base + 1n, 'Is there a web UI for drafts already?'), msg(base + 2n, 'nice')];
  const api = fakeDiscord(messages);
  const collectors = { discord: { collect: args => COLLECTORS.discord.collect({ ...args, fetchImpl: api.fetchImpl }) } };
  const orchestrator = new ScraperOrchestrator(models, {
    notify: false, credentials: new Credentials({ vault, legacy: { telegram: {} } }),
    accountsConfigPath, lockPath: path.join(dir, 'lock'), pause: async () => {}, collectors,
  });

  let run = await orchestrator.run();
  assert.equal(run.signals_saved, 1);
  assert.equal(api.calls.filter(call => call.includes('/messages')).length, 1);
  const [state] = await sequelize.query("SELECT value FROM source_state WHERE source = 'discord_last_id'", { type: QueryTypes.SELECT });
  assert.equal(state.value, String(base + 2n));

  // 150 new messages: two forward pages after the checkpoint.
  for (let i = 3n; i < 153n; i++) messages.push(msg(base + i, i % 2n ? `Question number ${i} about the content plan?` : 'thanks'));
  api.calls.length = 0;
  run = await orchestrator.run();
  assert.equal(run.signals_saved, 75);
  assert.deepEqual(api.calls.filter(call => call.includes('/messages')).map(call => new URL(`https://x${call}`).searchParams.get('after')),
    [String(base + 2n), String(base + 102n)]);
  const [{ n }] = await sequelize.query("SELECT COUNT(*) AS n FROM signals WHERE source = 'discord'", { type: QueryTypes.SELECT });
  assert.equal(n, 76);
});

test('a revoked token is a session error; 429 is retried once', async () => {
  const sleeps = [];
  let first = true;
  const client = new DiscordClient({
    token: 'T', sleep: async ms => { sleeps.push(ms); },
    fetchImpl: async () => {
      if (first) { first = false; return Response.json({ retry_after: 2.5 }, { status: 429 }); }
      return Response.json({ id: CHANNEL });
    },
  });
  assert.deepEqual(await client.channel(CHANNEL), { id: CHANNEL });
  assert.deepEqual(sleeps, [2500]);
  await assert.rejects(new DiscordClient({ token: 'T', fetchImpl: fakeDiscord([], { status: 401 }).fetchImpl }).channel(CHANNEL),
    error => error.code === 'DISCORD_UNAUTHORIZED');
  await assert.rejects(new DiscordClient({ token: 'T', fetchImpl: fakeDiscord([], { status: 403 }).fetchImpl }).channel(CHANNEL),
    /Read Message History/);
  assert.throws(() => new DiscordClient({ token: '' }), error => error.code === 'DISCORD_TOKEN_MISSING');
});

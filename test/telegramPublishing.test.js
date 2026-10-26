import assert from 'node:assert/strict';
import test from 'node:test';
import { Sequelize } from 'sequelize';
import { Api } from 'telegram';
import { readBigIntFromBuffer } from 'telegram/Helpers.js';
import { z } from 'zod';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { TelegramOutboxRepository } from '../src/core/teapot/repositories/TelegramOutboxRepository.js';
import { TelegramPublisher } from '../src/platforms/telegram/TelegramPublisher.js';
import { TelegramPublishGateway } from '../src/platforms/telegram/TelegramPublishGateway.js';
import { TelegramBotGateway } from '../src/platforms/telegram/TelegramBotGateway.js';
import { validateAccounts } from '../src/config/accountConfig.js';
import { buildTelegramPublishingTools } from '../src/core/mcp/tools/telegramPublishing.js';
import { jsonSchemaToZod } from '../src/core/mcp/schema.js';

async function fixture(t) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  await new SchemaMigrator(sequelize).migrate();
  const outbox = new TelegramOutboxRepository(sequelize);
  let accounts = validateAccounts([{ username: 'channel_one', platform: 'telegram', publish_enabled: true }]);
  const sends = [];
  const gateway = {
    async resolve(account) { return { account }; },
    async send(target, draft) {
      sends.push({ target, draft });
      return { channel_id: '123', message_id: 12, url: 'https://t.me/channel_one/12' };
    },
    async close() {},
  };
  const publisher = new TelegramPublisher({ outbox, gateway, loadAccounts: async () => accounts });
  return { publisher, gateway, sends, outbox, sequelize, setAccounts(value) { accounts = validateAccounts(value); } };
}

const input = { request_id: 'launch_001', account: '@channel_one', text: 'Привіт! Exact **plain** text 😀' };

test('Telegram drafts are durable, exact, and idempotent by publication request_id', async t => {
  const { publisher, sends, outbox, sequelize } = await fixture(t);
  const draft = await publisher.prepare(input);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.text, input.text);
  assert.equal(draft.account, 'channel_one');
  assert.equal(sends.length, 0);
  assert.deepEqual(await publisher.prepare(input), draft);
  await assert.rejects(publisher.prepare({ ...input, text: 'changed' }), /different content/);
  assert.equal((await new TelegramOutboxRepository(sequelize).get(input.request_id)).content_hash, draft.content_hash);
  const receipt = await publisher.publish({ request_id: input.request_id, content_hash: draft.content_hash });
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.receipt.message_id, 12);
  assert.equal(sends.length, 1);
  assert.deepEqual(await publisher.publish({ request_id: input.request_id, content_hash: draft.content_hash }), receipt);
  assert.equal(sends.length, 1);
  assert.equal((await outbox.get(input.request_id)).status, 'sent');
});

test('Telegram posting validates policy, channel, text, and exact draft hash before sending', async t => {
  const { publisher, sends, setAccounts } = await fixture(t);
  for (const text of ['', '   ', 'x'.repeat(4097)]) {
    await assert.rejects(publisher.prepare({ ...input, text }), /4096/);
  }
  await assert.rejects(publisher.prepare({ ...input, request_id: '../../x' }), /request_id/);
  await assert.rejects(publisher.prepare({ ...input, disable_preview: 'false' }), /boolean/);
  await assert.rejects(publisher.prepare({ ...input, account: 'not_allowed' }), /not enabled/);
  const draft = await publisher.prepare(input);
  await assert.rejects(publisher.publish({ request_id: input.request_id, content_hash: 'wrong' }), /content_hash/);
  for (const policy of [
    { username: 'channel_one', platform: 'telegram' },
    { username: 'channel_one', platform: 'telegram', publish_enabled: true, active: false },
    { username: 'channel_one', platform: 'telegram', publish_enabled: true, archive: true },
  ]) {
    setAccounts([policy]);
    await assert.rejects(publisher.publish({ request_id: input.request_id, content_hash: draft.content_hash }), /not enabled/);
  }
  assert.equal(sends.length, 0);
  assert.throws(() => validateAccounts([{ username: 'example', platform: 'twitter', publish_enabled: true }]), /only for Telegram/);
  assert.throws(() => validateAccounts([{ username: 'channel_one', platform: 'telegram', publish_enabled: 'true' }]), /boolean/);
});

test('a network failure after claim never automatically resends, even with another repository instance', async t => {
  const { publisher, gateway, sends, sequelize } = await fixture(t);
  gateway.send = async () => { sends.push('attempt'); throw new Error('Connection lost after sending'); };
  const draft = await publisher.prepare(input);
  const args = { request_id: input.request_id, content_hash: draft.content_hash };
  const result = await publisher.publish(args);
  assert.equal(result.status, 'unknown');
  assert.match(result.next_action, /Check this channel/);
  const restarted = new TelegramPublisher({
    outbox: new TelegramOutboxRepository(sequelize), gateway,
    loadAccounts: async () => { throw new Error('Must not try to publish again'); },
  });
  assert.equal((await restarted.publish(args)).status, 'unknown');
  assert.equal(sends.length, 1);
});

test('an explicit Telegram rejection marks the post failed and allows a retry with the same request_id', async t => {
  const { publisher, gateway, sends } = await fixture(t);
  const send = gateway.send;
  gateway.send = async () => {
    sends.push('rejected');
    throw Object.assign(new Error('Telegram Bot API sendMessage failed: Forbidden'), { notSent: true });
  };
  const draft = await publisher.prepare(input);
  const args = { request_id: input.request_id, content_hash: draft.content_hash };
  const result = await publisher.publish(args);
  assert.equal(result.status, 'failed');
  assert.match(result.next_action, /same request_id/);
  gateway.send = send;
  const retried = await publisher.publish(args);
  assert.equal(retried.status, 'sent');
  assert.equal(retried.error, null);
  assert.equal(sends.length, 2);
});

test('concurrent publication calls claim a draft only once', async t => {
  const { publisher, sends } = await fixture(t);
  const draft = await publisher.prepare(input);
  const args = { request_id: input.request_id, content_hash: draft.content_hash };
  await Promise.all([publisher.publish(args), publisher.publish(args), publisher.publish(args)]);
  assert.equal(sends.length, 1);
  assert.equal((await publisher.get({ request_id: input.request_id })).status, 'sent');
});

test('authentication or channel resolution failure leaves an unsent draft retryable', async t => {
  const { publisher, gateway, sends } = await fixture(t);
  const draft = await publisher.prepare(input);
  gateway.resolve = async () => { throw new Error('Admin permission missing'); };
  await assert.rejects(publisher.publish({ request_id: input.request_id, content_hash: draft.content_hash }), /Admin permission/);
  assert.equal((await publisher.get({ request_id: input.request_id })).status, 'draft');
  assert.equal(sends.length, 0);
});

test('publish gateway restricts destinations to channels with posting rights and serializes exact text', async () => {
  const id = readBigIntFromBuffer(Buffer.from('0100000000000000', 'hex'));
  let entity = { className: 'User', id };
  const calls = [];
  const client = {
    async getEntity() { return entity; },
    async getInputEntity() { return new Api.InputPeerChannel({ channelId: id, accessHash: id }); },
    async invoke(request) {
      calls.push(request);
      assert.ok(request.getBytes().length > 0);
      return { className: 'UpdateShortSentMessage', id: 42 };
    },
    async disconnect() {},
  };
  const gateway = new TelegramPublishGateway({ clientManager: { client, async connect() { return client; } } });
  await assert.rejects(gateway.resolve('channel_one'), /broadcast Telegram channels/);
  entity = { className: 'Channel', broadcast: false, id, creator: true };
  await assert.rejects(gateway.resolve('channel_one'), /broadcast Telegram channels/);
  entity = { className: 'Channel', broadcast: true, id };
  await assert.rejects(gateway.resolve('channel_one'), /permission/);
  entity.adminRights = { postMessages: true };
  const target = await gateway.resolve('channel_one');
  const draft = { text: input.text, random_id: '1234567890abcdef', disable_preview: 1 };
  const receipt = await gateway.send(target, draft);
  assert.equal(receipt.message_id, 42);
  assert.equal(calls[0].message, input.text);
  assert.equal(calls[0].noWebpage, true);
  await gateway.send(target, draft);
  assert.equal(calls[0].randomId.toString(), calls[1].randomId.toString());
  client.invoke = async () => ({ className: 'Updates', updates: [] });
  await assert.rejects(gateway.send(target, draft), /no identifiable post/);
});

test('MCP publication schemas limit text and require an exact draft hash', () => {
  const tools = buildTelegramPublishingTools({});
  const prepare = z.object(jsonSchemaToZod(tools.find(t => t.name === 'telegram_post_prepare').inputSchema));
  assert.equal(prepare.safeParse(input).success, true);
  assert.equal(prepare.safeParse({ ...input, text: 'x'.repeat(4097) }).success, false);
  const publish = z.object(jsonSchemaToZod(tools.find(t => t.name === 'telegram_post_publish').inputSchema));
  assert.equal(publish.safeParse({ request_id: 'x' }).success, false);
  assert.equal(publish.safeParse({ request_id: 'x', content_hash: 'x' }).success, false);
});

test('bot publishing identifies the bot, checks channel rights and sends plain text to a resolved channel ID', async () => {
  const calls = [];
  const gateway = new TelegramBotGateway({ token: '123:test-secret', fetchImpl: async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    const results = {
      getMe: { id: 123, is_bot: true, username: 'example_bot', first_name: 'Example' },
      getChat: { id: -100123456, type: 'channel', username: 'channel_one' },
      getChatMember: { status: 'administrator', can_post_messages: true },
      sendMessage: { message_id: 77, chat: { id: -100123456 } },
    };
    return { ok: true, json: async () => ({ ok: true, result: results[method] }) };
  } });
  const identity = await gateway.identity();
  assert.equal(identity.username, 'example_bot');
  assert.equal(JSON.stringify(identity).includes('test-secret'), false);
  const target = await gateway.resolve('channel_one');
  assert.equal(calls.some(call => call.method === 'sendMessage'), false);
  const receipt = await gateway.send(target, { text: input.text, disable_preview: true });
  assert.equal(receipt.message_id, 77);
  assert.deepEqual(calls.at(-1).body, {
    chat_id: -100123456, text: input.text, link_preview_options: { is_disabled: true },
  });
});

test('bot identity handles missing configuration, refuses non-channels/rights and redacts token errors', async () => {
  const missing = new TelegramBotGateway({ token: '', fetchImpl: () => { throw new Error('Must not access network'); } });
  assert.equal((await missing.identity()).configured, false);
  await assert.rejects(missing.resolve('channel_one'), /TELEGRAM_BOT_TOKEN/);
  let type = 'private';
  const token = '123:very-secret';
  const gateway = new TelegramBotGateway({ token, fetchImpl: async url => {
    if (url.endsWith('/getMe')) return { ok: true, json: async () => ({ ok: true, result: { id: 123, is_bot: true, username: 'example_bot' } }) };
    if (url.endsWith('/getChat')) return { ok: true, json: async () => ({ ok: true, result: { id: -100123456, type } }) };
    return { ok: true, json: async () => ({ ok: true, result: { status: 'member' } }) };
  } });
  await assert.rejects(gateway.resolve('channel_one'), /broadcast Telegram channels/);
  type = 'channel';
  await assert.rejects(gateway.resolve('channel_one'), /Add @example_bot/);
  const failed = new TelegramBotGateway({ token, fetchImpl: async url => { throw new Error(`fetch failed ${url}`); } });
  await assert.rejects(failed.identity(), error => {
    assert.equal(error.message.includes(token), false);
    assert.match(error.message, /\[redacted\]/);
    assert.equal(error.notSent, undefined);
    return true;
  });
  const reply = (status, body) => new TelegramBotGateway({ token, fetchImpl: async () => ({ ok: false, status, json: async () => body }) });
  await assert.rejects(reply(403, { ok: false, error_code: 403, description: 'Forbidden: bot is not a member' })
    .send({ id: -100123456 }, { text: 'x' }), error => error.notSent === true);
  await assert.rejects(reply(502, { ok: false, error_code: 502, description: 'Bad Gateway' })
    .send({ id: -100123456 }, { text: 'x' }), error => error.notSent === undefined);
});

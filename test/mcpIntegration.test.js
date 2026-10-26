import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Sequelize } from 'sequelize';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';

const serverPath = fileURLToPath(new URL('../src/core/mcp/start.js', import.meta.url));
const parseResult = result => {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-mcp-'));
  const storage = path.join(dir, 'test.sqlite');
  const config = path.join(dir, 'accounts.json');
  await fs.writeFile(config, '[]');
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const accounts = await models.Account.bulkCreate([
    { username: 'same', platform: 'telegram' },
    { username: 'same', platform: 'twitter' },
    { username: 'other', platform: 'telegram' },
  ]);
  for (let i = 0; i < 8; i++) {
    const account = accounts[i % 3];
    await models.Post.create({
      account_id: account.id, platform: account.platform, platform_id: `post-${i}`,
      text: `Message ${i}`, is_repost: i === 0, is_reply: i === 3,
      likes: i, posted_at: new Date(Date.now() - (8 - i) * 60000),
    });
  }
  await sequelize.close();
  return { env: { ...process.env, INSTANCE_DIR: dir, DB_PATH: storage, DATA_DIR: dir, ACCOUNTS_CONFIG_PATH: config, MCP_TRANSPORT: 'stdio',
    TELEGRAM_PUBLISH_TRANSPORT: 'bot', TELEGRAM_BOT_TOKEN: '', TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', TELEGRAM_SESSION: '' },
    cleanup: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test('stdio MCP reads scoped Telegram messages, validates inputs and runs a real background worker', { timeout: 30000 }, async t => {
  const { env, cleanup } = await fixture();
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: os.tmpdir(), env, stderr: 'pipe' });
  const client = new Client({ name: 'integration', version: '1.0' });
  t.after(async () => { await client.close(); await cleanup(); });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['scraper_run', 'scraper_job_get', 'scraper_status',
    'telegram_messages_get', 'posts_get', 'posts_search',
    'telegram_post_prepare', 'telegram_post_publish', 'telegram_post_get']) assert.ok(names.includes(name));
  const read = async args => parseResult(await client.callTool({ name: 'telegram_messages_get', arguments: args }));
  const initial = await read({ account: '@same', limit: 2 });
  assert.equal(initial.messages.length, 2);
  assert.ok(initial.messages.every(row => row.account === 'same'));
  const fromStart = await read({ account: 'same', after_id: 0, limit: 1 });
  assert.equal(fromStart.messages[0].is_repost, 1);
  const next = await read({ account: 'same', after_id: fromStart.next_after_id, limit: 1 });
  assert.equal(next.messages[0].is_reply, 1);
  const sample = parseResult(await client.callTool({ name: 'posts_get', arguments: {
    platform: 'telegram', account: 'same', type: 'sample', limit: 1, include_replies: true,
  } }));
  assert.ok(sample.count <= 1);
  assert.ok(sample.posts.every(row => row.platform === 'telegram' && row.account === 'same'));
  const bad = await client.callTool({ name: 'telegram_messages_get', arguments: { limit: -1 } });
  assert.equal(bad.isError, true);
  const job = parseResult(await client.callTool({ name: 'scraper_run', arguments: { platform: 'telegram' } }));
  let completed;
  for (let i = 0; i < 150; i++) {
    completed = parseResult(await client.callTool({ name: 'scraper_job_get', arguments: { job_id: job.job_id } }));
    if (completed.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(completed.status, 'success', JSON.stringify(completed));
  assert.equal(completed.result.accounts_processed, 0);
});

test('MCP prepares durable Telegram posts and identifies missing bot setup without sending', { timeout: 30000 }, async t => {
  const { env, cleanup } = await fixture();
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await cleanup(); });
  const connect = async () => {
    const client = new Client({ name: 'publishing-test', version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'pipe' }));
    return client;
  };
  const client = await connect();
  const call = async (name, args = {}) => parseResult(await client.callTool({ name, arguments: args }));
  const info = await call('telegram_publisher_info');
  assert.equal(info.configured, false);
  assert.deepEqual(await call('telegram_publish_targets'), []);
  const args = { request_id: 'integration_001', account: 'channel_one', text: 'Local draft only.' };
  const denied = await client.callTool({ name: 'telegram_post_prepare', arguments: args });
  assert.equal(denied.isError, true);
  await fs.writeFile(env.ACCOUNTS_CONFIG_PATH, JSON.stringify([{ username: 'channel_one', platform: 'telegram', publish_enabled: true }]));
  const draft = await call('telegram_post_prepare', args);
  assert.equal(draft.status, 'draft');
  assert.deepEqual(await call('telegram_post_prepare', args), draft);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'telegram_post_publish').annotations.destructiveHint, true);
  const hashDenied = await client.callTool({ name: 'telegram_post_publish', arguments: {
    request_id: args.request_id, content_hash: 'a'.repeat(64),
  } });
  assert.equal(hashDenied.isError, true);
  // The token is explicitly empty; this verifies setup rejection before any send.
  const noToken = await client.callTool({ name: 'telegram_post_publish', arguments: {
    request_id: args.request_id, content_hash: draft.content_hash,
  } });
  assert.equal(noToken.isError, true);
  assert.match(noToken.content[0].text, /TELEGRAM_BOT_TOKEN/);
  await client.close();
  const restarted = await connect();
  const stored = parseResult(await restarted.callTool({ name: 'telegram_post_get', arguments: { request_id: args.request_id } }));
  assert.deepEqual(stored, draft);
});

test('HTTP MCP maintains independent sessions and rejects browser origins', { timeout: 30000 }, async t => {
  const { env, cleanup } = await fixture();
  const portProbe = net.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...env, MCP_TRANSPORT: 'http', MCP_PORT: String(port), MCP_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.close()));
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    await cleanup();
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
    child.stderr.on('data', data => { if (data.toString().includes('HTTP transport ready')) resolve(); });
  });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  clients.push(new Client({ name: 'one', version: '1' }), new Client({ name: 'two', version: '1' }));
  for (const client of clients) {
    try {
      await client.connect(new StreamableHTTPClientTransport(url));
    } catch (error) {
      throw new Error(`${error.message}: ${error.cause?.message}`, { cause: error });
    }
  }
  for (const client of clients) assert.ok((await client.listTools()).tools.length > 0);
  assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(url, { headers: { 'mcp-session-id': 'unknown' } })).status, 400);
});

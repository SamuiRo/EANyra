import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createWebServer } from '../src/web/server.js';
import { WebAuth, tokenVerifier } from '../src/web/auth.js';

async function start(t, { auth = new WebAuth({ verifyPassword: tokenVerifier('secret-token') }), routes = {} } = {}) {
  const calls = [];
  const tools = [{
    name: 'echo_tool',
    description: 'Echo',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 }, limit: { type: 'integer', default: 5 } } },
    handler: async args => { calls.push(args); return { echoed: args }; },
  }];
  const server = createWebServer({ port: 0, auth, mode: 'token', tools, routes, info: { version: 'test' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (path, { method = 'GET', body, headers = {}, raw = false } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-EANyra': '1' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return raw ? response : { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  };
  return { request, calls, base, auth };
}

test('static UI is served with a strict security policy', async t => {
  const { request } = await start(t);
  const page = await request('/', { raw: true });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script type="module" src="\/app.js">/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await request('/../secrets.vault', { raw: true })).status, 404);
  assert.equal((await request('/app.js', { raw: true })).headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('API requires login, a local Host, the custom header and same origin', async t => {
  const { request, base } = await start(t);
  assert.deepEqual((await request('/api/session')).body, { authenticated: false, mode: 'token', version: 'test' });
  const rawStatus = headers => new Promise((resolve, reject) => {
    http.get(`${base}/api/session`, { headers }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal((await request('/api/tools/echo_tool', { method: 'POST', body: { text: 'x' } })).status, 401);
  // DNS rebinding: a foreign Host is rejected even on the loopback socket.
  assert.equal(await rawStatus({ Host: 'evil.example:80' }), 421);
  assert.equal(await rawStatus({}), 200);
  // CSRF: a plain form post cannot set the custom header or a JSON content type.
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'secret-token' }, headers: { 'X-EANyra': '' } })).status, 403);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'secret-token' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'secret-token' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/login', { method: 'POST', body: 'password=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await request('/api/login', { method: 'POST', body: 'x'.repeat(5200 * 1024) })).status, 413);
  assert.equal((await request('/api/session', { method: 'DELETE' })).status, 405);
});

test('login sets an HttpOnly SameSite cookie and tools run with schema validation', async t => {
  const { request, calls } = await start(t);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const login = await request('/api/login', { method: 'POST', body: { password: 'secret-token' } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/session')).body.authenticated, true);

  const ok = await request('/api/tools/echo_tool', { method: 'POST', body: { text: 'hi' } });
  assert.deepEqual(ok.body, { echoed: { text: 'hi', limit: 5 } });
  const invalid = await request('/api/tools/echo_tool', { method: 'POST', body: { text: '' } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Invalid text/);
  assert.equal((await request('/api/tools/missing_tool', { method: 'POST', body: {} })).status, 404);
  assert.deepEqual(calls, [{ text: 'hi', limit: 5 }]);
  assert.deepEqual((await request('/api/tools')).body, [{ name: 'echo_tool', description: 'Echo' }]);

  await request('/api/logout', { method: 'POST' });
  assert.equal((await request('/api/tools/echo_tool', { method: 'POST', body: { text: 'hi' } })).status, 401);
});

test('repeated wrong passwords throttle login and sessions expire when idle', async t => {
  let now = 1_000_000;
  const auth = new WebAuth({ verifyPassword: tokenVerifier('secret-token'), now: () => now, idleTimeoutMs: 60_000 });
  const { request } = await start(t, { auth });
  for (let i = 0; i < 5; i++) assert.equal((await request('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'secret-token' } })).status, 429);
  now += 61_000;
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'secret-token' } })).status, 200);
  assert.equal((await request('/api/session')).body.authenticated, true);
  now += 61_000;
  assert.equal((await request('/api/session')).body.authenticated, false);
});

test('a vault-backed verifier treats a wrong master password as a failed login', async () => {
  const auth = new WebAuth({ verifyPassword: async () => { throw Object.assign(new Error('bad'), { code: 'VAULT_DECRYPT_FAILED' }); } });
  await assert.rejects(auth.login('whatever'), error => error.status === 401);
  const broken = new WebAuth({ verifyPassword: async () => { throw new Error('disk failure'); } });
  await assert.rejects(broken.login('whatever'), /disk failure/);
});

test('the server refuses to bind beyond loopback', () => {
  assert.throws(() => createWebServer({ host: '0.0.0.0', auth: {}, tools: [] }), /local-only/);
});

test('serve mounts MCP at /mcp behind a Bearer token and refuses browsers', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createMcpServer, McpHttpSessions } = await import('../src/core/mcp/mcpServer.js');
  const tools = [{
    name: 'echo_tool', description: 'Echo',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    handler: async ({ text }) => ({ echoed: text }),
  }];
  let token = 'correct-token';
  const sessions = new McpHttpSessions({ createServer: () => createMcpServer({ tools }) });
  const server = createWebServer({
    port: 0, auth: new WebAuth({ verifyPassword: tokenVerifier('x') }), mode: 'token', tools,
    mcp: { handle: (req, res) => sessions.handle(req, res), token: async () => token },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await sessions.close(); await new Promise(resolve => server.close(resolve)); });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) });

  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post({ Authorization: 'Bearer correct-token', Origin: 'https://evil.example' })).status, 403);
  // The web session cookie is not a substitute for the token.
  assert.equal((await post({ Cookie: 'eanyra_session=anything' })).status, 401);

  const client = new Client({ name: 'serve-test', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer correct-token' } } }));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo_tool']);
  const result = await client.callTool({ name: 'echo_tool', arguments: { text: 'hi' } });
  assert.deepEqual(JSON.parse(result.content[0].text), { echoed: 'hi' });
  assert.ok((await client.listPrompts()).prompts.some(prompt => prompt.name === 'write_post'));

  // Without a configured token (or with a locked vault) the endpoint is closed.
  token = '';
  assert.equal((await post({ Authorization: 'Bearer correct-token' })).status, 503);
});

test('/mcp is absent unless enabled', async t => {
  const { request } = await start(t);
  assert.equal((await request('/mcp', { raw: true })).status, 404);
});

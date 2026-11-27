/**
 * Local web server: browser UI + JSON API over the same tools the AI uses.
 *
 * Security model (local single-user):
 *   - binds to a loopback address only; the Host header must match it
 *     (blocks DNS rebinding). Inside a container (EANYRA_CONTAINER=1) it may
 *     bind 0.0.0.0 so the host can publish the port, but only as
 *     127.0.0.1:<port> on the host: the Host check still accepts loopback names only
 *   - every API call except login needs a session cookie (HttpOnly,
 *     SameSite=Strict); every POST needs the X-EANyra header and, when the
 *     browser sends one, a same-origin Origin (blocks CSRF)
 *   - strict Content-Security-Policy without inline scripts, no framing
 *   - request bodies are JSON and capped at 5 MiB
 *   - optional /mcp for AI clients: Bearer token instead of the cookie, and
 *     browser requests (any Origin) are refused
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callTool, AUTHOR } from '../core/mcp/toolRegistry.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
// Large enough for cookie exports, context files and LinkedIn Shares.csv.
const MAX_BODY = 5 * 1024 * 1024;
const STATIC = {
  '/':           ['index.html', 'text/html; charset=utf-8'],
  '/app.js':     ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css':  ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{
 *   host?: string, port?: number,
 *   auth: import('./auth.js').WebAuth,
 *   mode: 'vault'|'token'|(() => 'vault'|'token'),
 *   tools: Array<{ name: string, handler: Function, inputSchema: object }>,
 *   routes?: Record<string, (ctx: { body: object, query: URLSearchParams }) => Promise<unknown>>,
 *   info?: object,
 *   onLogin?: () => Promise<void>|void,
 *   mcp?: { handle: (req, res) => Promise<void>, token: () => Promise<string>|string },
 * }} options
 *   mcp.token returns the expected Bearer token ('' disables /mcp).
 */
export function createWebServer({ host = '127.0.0.1', port = 4450, auth, mode, tools, routes = {}, info = {}, onLogin, mcp, container = false }) {
  if (!LOOPBACK.includes(host) && !(container && host === '0.0.0.0')) {
    throw new Error('The web server is local-only. Bind WEB_HOST to 127.0.0.1, localhost or ::1' +
      ' (0.0.0.0 only inside a container with EANYRA_CONTAINER=1, published as 127.0.0.1:<port>).');
  }
  const toolMap = new Map(tools.map(tool => [tool.name, tool]));

  const server = http.createServer(async (req, res) => {
    try {
      const actualPort = server.address()?.port ?? port;
      const url = new URL(req.url, 'http://placeholder');
      assertHost(req, actualPort);

      if (url.pathname === '/mcp') {
        if (!mcp) throw new HttpError(404, 'MCP is not enabled. Start with `npm run serve -- --mcp`.');
        // AI clients are not browsers; a page must never reach the agent tools.
        if (req.headers.origin) throw new HttpError(403, 'Browser requests to /mcp are not allowed.');
        await assertBearer(req, await mcp.token());
        await mcp.handle(req, res);
        return;
      }

      if (req.method === 'GET' && STATIC[url.pathname]) {
        await sendStatic(res, ...STATIC[url.pathname]);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');

      if (req.method === 'POST') assertSameOrigin(req, actualPort);
      else if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');

      if (url.pathname === '/api/session' && req.method === 'GET') {
        return sendJson(res, 200, { authenticated: Boolean(auth.check(req)), mode: typeof mode === 'function' ? mode() : mode, ...info });
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const { password } = await readJson(req);
        const id = await auth.login(password);
        await onLogin?.();
        return sendJson(res, 200, { authenticated: true }, { 'Set-Cookie': auth.cookie(id) });
      }

      const sessionId = auth.check(req);
      if (!sessionId) throw new HttpError(401, 'Log in first.');

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        auth.logout(sessionId);
        return sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': auth.clearCookie() });
      }

      const toolMatch = url.pathname.match(/^\/api\/tools\/([a-z_]+)$/);
      if (toolMatch && req.method === 'POST') {
        const tool = toolMap.get(toolMatch[1]);
        if (!tool) throw new HttpError(404, `Unknown tool ${toolMatch[1]}`);
        // A logged-in author sees every persona, isolated ones included.
        return sendJson(res, 200, await callTool(tool, await readJson(req), AUTHOR));
      }
      if (url.pathname === '/api/tools' && req.method === 'GET') {
        return sendJson(res, 200, tools.map(({ name, description }) => ({ name, description })));
      }

      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const body = req.method === 'POST' ? await readJson(req) : {};
        return sendJson(res, 200, await route({ body, query: url.searchParams }));
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error.status ?? 500;
      if (!error.status) process.stderr.write(`[eanyra-web] ${req.method} ${req.url}: ${error.stack ?? error.message}\n`);
      if (!res.headersSent) sendJson(res, status, { error: error.message });
      else res.end();
    }
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  return server;
}

async function assertBearer(req, expected) {
  if (!expected) {
    throw new HttpError(503, 'No MCP token is available: create one with `npm run nyra -- mcp token`, and unlock the vault (log in to the web UI or `vault remember`).');
  }
  const given = String(req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  // Compare digests so the comparison time does not depend on the length.
  const digest = value => createHash('sha256').update(value).digest();
  if (!given || !timingSafeEqual(digest(given), digest(expected))) {
    throw new HttpError(401, 'Invalid or missing MCP token.');
  }
}

function assertHost(req, port) {
  const host = String(req.headers.host ?? '');
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!allowed.includes(host)) throw new HttpError(421, 'Unexpected Host header.');
}

function assertSameOrigin(req, port) {
  if (req.headers['x-eanyra'] !== '1') throw new HttpError(403, 'Missing X-EANyra header.');
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin)) {
    throw new HttpError(403, 'Cross-origin request rejected.');
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'Cross-site request rejected.');
}

async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function sendStatic(res, file, type) {
  const body = await fs.readFile(path.join(PUBLIC_DIR, file));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

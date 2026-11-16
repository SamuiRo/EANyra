import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import http                     from 'node:http';

import { MCP, PKG } from '../../config/app.config.js';
import { buildTools } from './toolRegistry.js';
import { ScrapeJobs } from './ScrapeJobs.js';
import { closeDb } from './db.js';
import { TelegramPublishRequests } from './TelegramPublishRequests.js';
import { migrateInWorker } from './migrateWorker.js';
import { createMcpServer, McpHttpSessions } from './mcpServer.js';
import { onShutdown } from '../../shared/shutdown.js';

// ── Config ────────────────────────────────────────────────────────────────────
//
//  MCP_TRANSPORT=stdio   → stdio (default; Claude Desktop, OpenClaw local)
//  MCP_TRANSPORT=http    → Streamable HTTP (loopback only)
//  MCP_PORT              → HTTP port (default: 3001)
//  MCP_HOST              → bind address (default: 127.0.0.1)
//
//  `eanyra serve` can also expose the same server at /mcp with a token; see
//  src/web/start.js.

const TRANSPORT = MCP.transport;
const PORT      = MCP.port;
const HOST      = MCP.host;

// The job table and other new columns must exist before tools use them.
try {
  const applied = await migrateInWorker();
  if (applied.length) log(`Applied ${applied.length} schema migration(s).`);
} catch (error) {
  log(`Schema migration failed: ${error.message}. Read tools may still work.`);
}

const jobs = new ScrapeJobs();
const publications = new TelegramPublishRequests();
const tools = buildTools({ jobs, publications });
const createServer = () => createMcpServer({ tools, log });
const servers = new Set();
let httpSessions = null;

// ── Transport ─────────────────────────────────────────────────────────────────

if (TRANSPORT === 'http') {
  await startHttp();
} else {
  await startStdio();
}

async function startStdio() {
  const server = createServer();
  servers.add(server);
  await server.connect(new StdioServerTransport());
  log('stdio transport ready');
}

async function startHttp() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    throw new Error('HTTP MCP is local-only. Use stdio or bind MCP_HOST to a loopback address.');
  }
  httpSessions = new McpHttpSessions({ createServer, log });

  const httpServer = http.createServer(async (req, res) => {
    try {
      // This unauthenticated local endpoint does not accept browser origins.
      if (req.headers.origin || !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(`http://${req.headers.host}`).hostname)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === MCP.healthRoute) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: PKG.name, version: PKG.version }));
        return;
      }
      if (url.pathname === MCP.route) {
        await httpSessions.handle(req, res);
        return;
      }
      res.writeHead(404).end('Not found');
    } catch (error) {
      log(`HTTP request failed: ${error.message}`);
      if (!res.headersSent) res.writeHead(500).end('MCP request failed');
      else res.end();
    }
  });

  httpServer.listen(PORT, HOST, () => {
    log(`HTTP transport ready  → http://${HOST}:${PORT}${MCP.route}`);
    log(`Health check          → http://${HOST}:${PORT}${MCP.healthRoute}`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[eanyra-mcp] ${msg}\n`);
}

// Collection workers stop after their current account (sessions saved);
// in-flight Telegram publications may finish so their state is never lost.
async function shutdown() {
  await jobs.shutdown({ timeoutMs: 90_000 });
  await publications.drain({ timeoutMs: 35_000 });
  await Promise.allSettled([...servers].map(server => server.close()));
  await httpSessions?.close();
  await closeDb();
}
onShutdown({ graceful: shutdown, timeoutMs: 150_000, log });
if (TRANSPORT === 'stdio') process.stdin.once('end', () => shutdown().finally(() => process.exit(0)));

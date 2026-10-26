import { McpServer }                    from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http                              from 'node:http';
import { randomUUID } from 'node:crypto';

import { postTools }         from './tools/posts.js';
import { signalTools }       from './tools/signals.js';
import { statusTools }       from './tools/status.js';
import { buildContextTools } from './context.js';
import { MCP, PKG } from '../../config/app.config.js';
import { jsonSchemaToZod } from './schema.js';
import { ScrapeJobs } from './ScrapeJobs.js';
import { buildCollectionTools } from './tools/collection.js';
import { closeDb } from './db.js';
import { TelegramPublishRequests } from './TelegramPublishRequests.js';
import { buildTelegramPublishingTools } from './tools/telegramPublishing.js';

// ── Config ────────────────────────────────────────────────────────────────────
//
//  MCP_TRANSPORT=stdio   → stdio (default; Claude Desktop, OpenClaw local)
//  MCP_TRANSPORT=http    → Streamable HTTP (Docker, OpenClaw remote)
//  MCP_PORT              → HTTP port (default: 3001)
//  MCP_HOST              → bind address (default: 127.0.0.1)
//                          HTTP is limited to loopback addresses.

const TRANSPORT = MCP.transport;
const PORT      = MCP.port;
const HOST      = MCP.host;

// ── Server ────────────────────────────────────────────────────────────────────

const jobs = new ScrapeJobs();
const publications = new TelegramPublishRequests();
const servers = new Set();
function createServer() {
  const server = new McpServer({
    name:    PKG.name,
    version: PKG.version,
    description:
      'EANyra — multi-platform social media pipeline for AI-assisted content creation. ' +
      'Collects posts (Twitter, LinkedIn, Telegram) and GitHub activity into a local SQLite database. ' +
      'Exposes unified tools for querying posts, signals, user context, and export files. ' +
      'Recommended call order: context_get → signals_get → posts_get → write → signals_mark_used.',
  });

  // ── Tool registry ─────────────────────────────────────────────────────────────
  //
  //  posts.js    → posts_get, posts_search, posts_stats, accounts_list
  //  signals.js  → signals_get, signals_mark_used
  //  context.js  → context_get, export_get
  //  status.js   → scraper_status

  const allTools = [
    ...postTools,
    ...signalTools,
    ...buildContextTools(),
    ...statusTools,
    ...buildCollectionTools(jobs),
    ...buildTelegramPublishingTools(publications),
  ];

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchemaToZod(tool.inputSchema),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args) => {
        try {
          const result = await tool.handler(args);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          log(`Tool "${tool.name}" error: ${err.message}`);
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
            isError: true,
          };
        }
      },
    );
  }
  servers.add(server);
  server.server.onclose = () => servers.delete(server);
  return server;
}

// ── Transport ─────────────────────────────────────────────────────────────────

if (TRANSPORT === 'http') {
  await startHttp();
} else {
  await startStdio();
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  log('stdio transport ready');
}

async function startHttp() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    throw new Error('HTTP MCP is local-only. Use stdio or bind MCP_HOST to a loopback address.');
  }
  const sessions = new Map();

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
        const sessionId = req.headers['mcp-session-id'];

        if (req.method === 'POST' || req.method === 'GET') {
          let transport = sessionId ? sessions.get(sessionId) : null;

          if (!transport) {
            if (sessionId || req.method !== 'POST') {
              res.writeHead(400).end('Unknown or missing MCP session');
              return;
            }
            if (sessions.size >= 100) {
              res.writeHead(503).end('Too many MCP sessions');
              return;
            }
            const sessionServer = createServer();
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => {
                sessions.set(id, transport);
                log(`Session opened: ${id}`);
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) {
                sessions.delete(transport.sessionId);
                log(`Session closed: ${transport.sessionId}`);
              }
            };
            await sessionServer.connect(transport);
            res.on('finish', () => {
              if (!transport.sessionId) void sessionServer.close();
            });
          }

          await transport.handleRequest(req, res);
          return;
        }

        if (req.method === 'DELETE' && sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId).close();
          sessions.delete(sessionId);
          res.writeHead(200).end();
          return;
        }

        res.writeHead(405).end('Method not allowed');
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

async function shutdown() {
  jobs.close();
  publications.close();
  await Promise.allSettled([...servers].map(server => server.close()));
  await closeDb();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
if (TRANSPORT === 'stdio') process.stdin.once('end', shutdown);

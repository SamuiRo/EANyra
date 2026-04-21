import { McpServer }                    from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z }                             from 'zod';
import http                              from 'node:http';

import { postTools }         from './tools/posts.js';
import { signalTools }       from './tools/signals.js';
import { statusTools }       from './tools/status.js';
import { buildContextTools } from './tools/context.js';
import { MCP_PORT, MCP_HOST, MCP_TRANSPORT, PKG } from '../../config/app.config.js';

// ── Config ────────────────────────────────────────────────────────────────────
//
//  MCP_TRANSPORT=stdio   → stdio (default; Claude Desktop, OpenClaw local)
//  MCP_TRANSPORT=http    → Streamable HTTP (Docker, OpenClaw remote)
//  MCP_PORT              → HTTP port (default: 3001)
//  MCP_HOST              → bind address (default: 127.0.0.1)
//                          Set to 0.0.0.0 only inside Docker.

const TRANSPORT = MCP_TRANSPORT;
const PORT      = MCP_PORT;
const HOST      = MCP_HOST;

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    PKG.name,
  version: PKG.version,
  description:
    'EANyra — multi-platform social media pipeline for AI-assisted content creation. ' +
    'Collects posts (Twitter, LinkedIn) and GitHub activity into a local SQLite database. ' +
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
];

for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    jsonSchemaToZod(tool.inputSchema),
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

// ── Transport ─────────────────────────────────────────────────────────────────

if (TRANSPORT === 'http') {
  await startHttp();
} else {
  await startStdio();
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('stdio transport ready');
}

async function startHttp() {
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: PKG.name, version: PKG.version }));
      return;
    }

    if (url.pathname === '/mcp') {
      const sessionId = req.headers['mcp-session-id'];

      if (req.method === 'POST' || req.method === 'GET') {
        let transport = sessionId ? sessions.get(sessionId) : null;

        if (!transport) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
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
          await server.connect(transport);
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
  });

  httpServer.listen(PORT, HOST, () => {
    log(`HTTP transport ready  → http://${HOST}:${PORT}/mcp`);
    log(`Health check          → http://${HOST}:${PORT}/health`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[eanyra-mcp] ${msg}\n`);
}

/**
 * Minimal JSON Schema → Zod shape converter.
 * Handles: string (+ enum), integer, boolean, array, oneOf (union).
 */
function jsonSchemaToZod(schema) {
  if (!schema?.properties) return {};

  const required = new Set(schema.required ?? []);
  const shape    = {};

  for (const [key, def] of Object.entries(schema.properties)) {
    let field;

    if (def.oneOf) {
      field = z.union([z.number().int(), z.array(z.number().int())]);
    } else {
      switch (def.type) {
        case 'integer':
          field = z.number().int();
          if (def.default !== undefined) field = field.default(def.default);
          break;
        case 'boolean':
          field = z.boolean();
          if (def.default !== undefined) field = field.default(def.default);
          break;
        case 'array':
          field = z.array(z.any());
          break;
        case 'string':
          field = def.enum ? z.enum(def.enum) : z.string();
          if (def.default !== undefined) field = field.default(def.default);
          break;
        default:
          field = z.any();
      }
    }

    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }

  return shape;
}
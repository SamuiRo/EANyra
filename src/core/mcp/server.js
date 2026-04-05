import { McpServer }              from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }   from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z }                      from 'zod';
import http                       from 'node:http';

import { twitterTools } from './tools/twitter.js';
import { statusTools }  from './tools/status.js';
import { buildContextTools } from './tools/context.js';
import {MCP_PORT, MCP_HOST, MCP_TRANSPORT, PKG} from "../../config/app.config.js"

// ── Config ────────────────────────────────────────────────────────────────
//
//  MCP_TRANSPORT=stdio   → stdio mode  (default, Claude Desktop / mcporter local)
//  MCP_TRANSPORT=http    → Streamable HTTP mode (Docker / remote OpenClaw)
//  MCP_PORT              → HTTP port when transport=http (default: 3001)
//  MCP_HOST              → bind address (default: 127.0.0.1)
//                          set to 0.0.0.0 only inside Docker — never expose
//                          this port to the public internet without auth.

const TRANSPORT = MCP_TRANSPORT;
const PORT      = MCP_PORT;
const HOST      = MCP_HOST;

// ── Build server ──────────────────────────────────────────────────────────

const server = new McpServer({
  name:        PKG.name,
  version:     PKG.version,
  description: 'EANyra — Twitter/X monitoring pipeline. ' +
               'Provides read access to scraped posts, account stats, and scraper health. ' +
               'Data is collected automatically on a daily schedule via Playwright. ' +
               'Use twitter_get_scraper_status first to verify data freshness before querying posts.',
});

// ── Register all tools ────────────────────────────────────────────────────

const allTools = [...twitterTools, ...statusTools, ...contextTools];

for (const tool of allTools) {
  const zodShape = jsonSchemaToZod(tool.inputSchema);

  server.tool(
    tool.name,
    tool.description,
    zodShape,
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

// ── Start transport ───────────────────────────────────────────────────────

if (TRANSPORT === 'http') {
  await startHttp();
} else {
  await startStdio();
}

// ── Transport: stdio ──────────────────────────────────────────────────────

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('stdio transport ready');
}

// ── Transport: Streamable HTTP ────────────────────────────────────────────
//
//  Single endpoint  POST /mcp  — handles all JSON-RPC requests.
//  GET  /mcp                  — optional SSE stream for server-initiated msgs.
//  GET  /health               — simple liveness check for Docker healthcheck.
//
//  mcporter.json (inside OpenClaw container) should reference:
//    { "transport": "streamable-http", "url": "http://host.docker.internal:3001/mcp" }
//
//  Or for legacy SSE-only clients:
//    { "transport": "sse", "url": "http://host.docker.internal:3001/mcp" }

async function startHttp() {
  // One transport instance per active session (keyed by sessionId header)
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ── Health check ──────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'eanyra', transport: 'http' }));
      return;
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────
    if (url.pathname === '/mcp') {
      // Re-use existing transport for this session if present
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

      // DELETE — explicit session teardown
      if (req.method === 'DELETE' && sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId);
        await transport.close();
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
    log(`HTTP transport ready → http://${HOST}:${PORT}/mcp`);
    log(`Health check       → http://${HOST}:${PORT}/health`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[eanyra-mcp] ${msg}\n`);
}

/**
 * Minimal JSON Schema → zod shape converter.
 * Handles the subset used in our tool definitions:
 *   string, integer, boolean — all optional unless listed in `required`.
 */
function jsonSchemaToZod(schema) {
  if (!schema?.properties) return {};

  const required = new Set(schema.required ?? []);
  const shape    = {};

  for (const [key, def] of Object.entries(schema.properties)) {
    let field;

    switch (def.type) {
      case 'integer':
        field = z.number().int();
        if (def.default !== undefined) field = field.default(def.default);
        break;
      case 'boolean':
        field = z.boolean();
        if (def.default !== undefined) field = field.default(def.default);
        break;
      case 'string':
        field = def.enum ? z.enum(def.enum) : z.string();
        if (def.default !== undefined) field = field.default(def.default);
        break;
      default:
        field = z.any();
    }

    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }

  return shape;
}
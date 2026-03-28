import { McpServer }           from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                    from 'zod';

import { twitterTools } from './tools/twitter.js';
import { statusTools }  from './tools/status.js';

// ── Build server ──────────────────────────────────────────────────────────

const server = new McpServer({
  name:        'eanyra',
  version:     '1.0.0',
  description: 'EANyra — Twitter/X monitoring pipeline. ' +
               'Provides read access to scraped posts, account stats, and scraper health. ' +
               'Data is collected automatically on a daily schedule via Playwright. ' +
               'Use twitter_get_scraper_status first to verify data freshness before querying posts.',
});

// ── Register all tools ────────────────────────────────────────────────────

const allTools = [...twitterTools, ...statusTools];

for (const tool of allTools) {
  // Convert JSON Schema properties to a zod shape for the MCP SDK
  const zodShape = jsonSchemaToZod(tool.inputSchema);

  server.tool(
    tool.name,
    tool.description,
    zodShape,
    async (args) => {
      try {
        const result = await tool.handler(args);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        process.stderr.write(`[eanyra-mcp] Tool "${tool.name}" error: ${err.message}\n`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: err.message }),
          }],
          isError: true,
        };
      }
    },
  );
}

// ── Start transport ───────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write('[eanyra-mcp] Server ready\n');

// ── Helpers ───────────────────────────────────────────────────────────────

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
        field = def.enum
          ? z.enum(def.enum)
          : z.string();
        if (def.default !== undefined) field = field.default(def.default);
        break;
      default:
        field = z.any();
    }

    // Make optional unless explicitly required
    if (!required.has(key)) {
      field = field.optional();
    }

    shape[key] = field;
  }

  return shape;
}
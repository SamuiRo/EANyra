/**
 * Every EANyra tool, shared by the MCP server and the local web server.
 *
 * Tools are the service layer over the local database: the AI agent (MCP)
 * and the browser UI (web) call the same handlers with the same validation,
 * so both always see and do the same thing.
 */

import { z } from 'zod';

import { postTools }         from './tools/posts.js';
import { signalTools }       from './tools/signals.js';
import { statusTools }       from './tools/status.js';
import { buildContextTools } from './context.js';
import { buildCollectionTools } from './tools/collection.js';
import { buildTelegramPublishingTools } from './tools/telegramPublishing.js';
import { buildContentTools } from './tools/content.js';
import { jsonSchemaToZod } from './schema.js';

/**
 * @param {{ jobs: import('./ScrapeJobs.js').ScrapeJobs,
 *           publications: import('./TelegramPublishRequests.js').TelegramPublishRequests }} deps
 */
export function buildTools({ jobs, publications }) {
  return [
    ...postTools,
    ...signalTools,
    ...buildContextTools(),
    ...statusTools,
    ...buildCollectionTools(jobs),
    ...buildTelegramPublishingTools(publications),
    ...buildContentTools({ publications }),
  ];
}

/** Validate arguments against the tool's schema, then run it. */
export async function callTool(tool, args = {}) {
  const parsed = z.object(jsonSchemaToZod(tool.inputSchema)).safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw Object.assign(new Error(`Invalid ${issue.path.join('.') || 'arguments'}: ${issue.message}`), { status: 400 });
  }
  return tool.handler(parsed.data);
}

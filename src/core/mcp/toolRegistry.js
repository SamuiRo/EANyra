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
import { buildContentTools, createContentService } from './tools/content.js';
import { buildAudienceTools } from './tools/audience.js';
import { jsonSchemaToZod } from './schema.js';

/** What an AI client may see: never the author scope. */
export const AGENT = Object.freeze({ author: false });
export const AUTHOR = Object.freeze({ author: true });

/**
 * @param {{ jobs: import('./ScrapeJobs.js').ScrapeJobs,
 *           publications: import('./TelegramPublishRequests.js').TelegramPublishRequests }} deps
 */
export function buildTools({ jobs, publications }) {
  const content = createContentService();
  return [
    ...postTools,
    ...signalTools,
    ...buildContextTools(),
    ...statusTools,
    ...buildCollectionTools(jobs),
    ...buildAudienceTools(),
    ...buildTelegramPublishingTools(publications, { content }),
    ...buildContentTools({ publications, content }),
  ];
}

/**
 * Validate arguments against the tool's schema, then run it.
 * `scope` is `{ author: true }` only for the author's own web UI: it may see
 * isolated personas without naming them. MCP clients never pass it.
 */
export async function callTool(tool, args = {}, scope = AGENT) {
  const parsed = z.object(jsonSchemaToZod(tool.inputSchema)).safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw Object.assign(new Error(`Invalid ${issue.path.join('.') || 'arguments'}: ${issue.message}`), { status: 400 });
  }
  return tool.handler(parsed.data, scope);
}

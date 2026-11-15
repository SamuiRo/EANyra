import * as mcpDb from '../db.js';
import { MCP } from '../../../config/app.config.js';
import { StatusService } from '../../services/StatusService.js';
import { mcpExecutor } from '../../services/sql.js';

/**
 * src/core/mcp/tools/status.js
 *
 * Tools:
 *   scraper_status — collection health, per-platform freshness, failing accounts
 */

const status = new StatusService(mcpExecutor(mcpDb));

export const statusTools = [
  {
    name: 'scraper_status',
    description:
      'Check collection health and data freshness. Returns overall health (ok, degraded, error, running), ' +
      'data_age_hours since the last successful collection, per-platform freshness, accounts needing ' +
      'attention (failed login, error, stale or never collected, with the last error), any active job ' +
      'and recent runs with new post and signal counts. Pass run_id to see per-account outcomes of one run. ' +
      'Call this before a content session to verify the data is current.',
    inputSchema: {
      type: 'object',
      properties: {
        history_limit: {
          type:        'integer',
          description:
            `Number of recent runs to include in history ` +
            `(default ${MCP.defaultStatusHistory}, max ${MCP.maxStatusHistory}).`,
          default:     MCP.defaultStatusHistory,
        },
        run_id: {
          type: 'integer', minimum: 1,
          description: 'Optional: return per-account outcomes (status, new records, error) of this run.',
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler({ history_limit = MCP.defaultStatusHistory, run_id } = {}) {
      const cap = Math.max(1, Math.min(Number(history_limit) || MCP.defaultStatusHistory, MCP.maxStatusHistory));
      const overview = await status.overview({ historyLimit: cap });
      return run_id ? { ...overview, run_accounts: await status.runAccounts(run_id) } : overview;
    },
  },
];

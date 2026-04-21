import { query, queryOne } from '../db.js';

/**
 * src/core/mcp/tools/status.js
 *
 * Tools:
 *   scraper_status — health check for all scrapers (platform-agnostic)
 */

export const statusTools = [
  {
    name: 'scraper_status',
    description:
      'Check the health and data freshness of the EANyra scrapers. ' +
      'Returns the latest run result, data age in hours, and recent run history. ' +
      'Call this before a content session if you want to verify data is up to date.',
    inputSchema: {
      type: 'object',
      properties: {
        history_limit: {
          type:        'integer',
          description: 'Number of recent runs to include in history (default 5, max 20).',
          default:     5,
        },
      },
    },
    async handler({ history_limit = 5 } = {}) {
      const cap = Math.min(Number(history_limit), 20);

      const latest = await queryOne(`
        SELECT *
        FROM   scraper_runs
        ORDER  BY started_at DESC
        LIMIT  1
      `);

      const history = await query(`
        SELECT
          id,
          started_at,
          finished_at,
          status,
          accounts_processed,
          posts_saved,
          error_message,
          ROUND(
            (JULIANDAY(finished_at) - JULIANDAY(started_at)) * 86400
          ) AS duration_seconds
        FROM   scraper_runs
        ORDER  BY started_at DESC
        LIMIT  ?
      `, [cap]);

      let health = 'unknown';
      if (latest) {
        if      (latest.status === 'success') health = 'ok';
        else if (latest.status === 'partial') health = 'degraded';
        else if (latest.status === 'failed')  health = 'error';
        else if (latest.status === 'running') health = 'running';
      }

      let data_age_hours = null;
      if (latest?.finished_at) {
        data_age_hours = Math.round(
          (Date.now() - new Date(latest.finished_at).getTime()) / 36e5 * 10,
        ) / 10;
      }

      return {
        health,
        data_age_hours,
        latest_run:  latest ?? null,
        recent_runs: history,
      };
    },
  },
];
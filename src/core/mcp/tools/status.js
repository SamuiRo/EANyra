import { query, queryOne } from '../db.js';

export const statusTools = [

  {
    name: 'twitter_get_scraper_status',
    description:
      'Check the current health of the EANyra scraper. ' +
      'Returns the last run result, timing, and recent run history. ' +
      'Use this to verify whether fresh data is available before querying posts.',
    inputSchema: {
      type:       'object',
      properties: {
        history_limit: {
          type:        'integer',
          description: 'Number of recent runs to include in history (default 5).',
          default:     5,
        },
      },
    },
    async handler({ history_limit = 5 }) {
      const cap = Math.min(Number(history_limit), 20);

      // Most recent run
      const latest = await queryOne(`
        SELECT *
        FROM scraper_runs
        ORDER BY started_at DESC
        LIMIT 1
      `);

      // Recent run history
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
        FROM scraper_runs
        ORDER BY started_at DESC
        LIMIT ?
      `, [cap]);

      // Quick health summary
      let health = 'unknown';
      if (latest) {
        if (latest.status === 'success')  health = 'ok';
        else if (latest.status === 'partial') health = 'degraded';
        else if (latest.status === 'failed')  health = 'error';
        else if (latest.status === 'running') health = 'running';
      }

      // How stale is the data?
      let data_age_hours = null;
      if (latest?.finished_at) {
        const finished  = new Date(latest.finished_at);
        const nowMs     = Date.now();
        data_age_hours  = Math.round((nowMs - finished.getTime()) / 36e5 * 10) / 10;
      }

      return {
        health,
        data_age_hours,
        latest_run: latest ?? null,
        recent_runs: history,
      };
    },
  },
];
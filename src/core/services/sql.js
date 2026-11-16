/**
 * Minimal SQL executor shared by every front end.
 *
 * CLI, scheduler and workers use Sequelize; the MCP server (and the planned
 * web server) use a direct sqlite3 connection. Services written against this
 * interface run unchanged on both:
 *
 *   all(sql, params) → rows
 *   get(sql, params) → first row or null
 *   run(sql, params) → { lastID?: number } (lastID for INSERT)
 *
 * Parameters are positional "?" placeholders; never interpolate values.
 */

import { QueryTypes } from 'sequelize';

export function sequelizeExecutor(sequelize) {
  return {
    all: (sql, params = []) => sequelize.query(sql, { replacements: params, type: QueryTypes.SELECT }),
    get: async (sql, params = []) => (await sequelize.query(sql, { replacements: params, type: QueryTypes.SELECT }))[0] ?? null,
    run: async (sql, params = []) => {
      if (/^\s*INSERT\b/i.test(sql)) {
        const [lastID] = await sequelize.query(sql, { replacements: params, type: QueryTypes.INSERT });
        return { lastID };
      }
      await sequelize.query(sql, { replacements: params });
      return {};
    },
  };
}

/** Adapter for core/mcp/db.js (query, queryOne, run). */
export function mcpExecutor({ query, queryOne, run }) {
  return { all: query, get: queryOne, run: async (sql, params) => ({ lastID: (await run(sql, params))?.lastID }) };
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Minimal SQL executor shared by every front end.
 *
 * CLI, scheduler and workers use Sequelize; the MCP server (and the planned
 * web server) use a direct sqlite3 connection. Services written against this
 * interface run unchanged on both:
 *
 *   all(sql, params) → rows
 *   get(sql, params) → first row or null
 *   run(sql, params) → void
 *
 * Parameters are positional "?" placeholders; never interpolate values.
 */

import { QueryTypes } from 'sequelize';

export function sequelizeExecutor(sequelize) {
  return {
    all: (sql, params = []) => sequelize.query(sql, { replacements: params, type: QueryTypes.SELECT }),
    get: async (sql, params = []) => (await sequelize.query(sql, { replacements: params, type: QueryTypes.SELECT }))[0] ?? null,
    run: async (sql, params = []) => { await sequelize.query(sql, { replacements: params }); },
  };
}

/** Adapter for core/mcp/db.js (query, queryOne, run). */
export function mcpExecutor({ query, queryOne, run }) {
  return { all: query, get: queryOne, run: async (sql, params) => { await run(sql, params); } };
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

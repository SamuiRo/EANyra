import sqlite3 from 'sqlite3';
import { DB }   from '../config/app.config.js';

/**
 * src/core/mcp/db.js
 *
 * Lightweight SQLite helper for MCP tools.
 * Uses OPEN_READWRITE so signals_mark_used can write.
 */

const DB_PATH = DB.storagePath;

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      process.stderr.write(`[eanyra-mcp] Failed to open DB at ${DB_PATH}: ${err.message}\n`);
      process.exit(1);
    }
  });

  return _db;
}

/** Run a SELECT, return all rows. */
export function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else     resolve(rows ?? []);
    });
  });
}

/** Run a SELECT, return the first row or null. */
export function queryOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else     resolve(row ?? null);
    });
  });
}

/** Run an INSERT / UPDATE / DELETE, return { lastID, changes }. */
export function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) reject(err);
      else     resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
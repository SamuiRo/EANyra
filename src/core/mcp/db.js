import sqlite3 from 'sqlite3';

import { DB } from '../config/app.config.js';

const DB_PATH = DB.storagePath;

// ── Singleton connection ──────────────────────────────────────────────────

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
      process.stderr.write(`[eanyra-mcp] Failed to open DB at ${DB_PATH}: ${err.message}\n`);
      process.exit(1);
    }
  });

  return _db;
}

// ── Public helpers ────────────────────────────────────────────────────────

/**
 * Run a SELECT and return all rows.
 * @param {string}   sql
 * @param {any[]}    [params=[]]
 * @returns {Promise<object[]>}
 */
export function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else     resolve(rows ?? []);
    });
  });
}

/**
 * Run a SELECT and return the first row only (or null).
 * @param {string}   sql
 * @param {any[]}    [params=[]]
 * @returns {Promise<object|null>}
 */
export function queryOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else     resolve(row ?? null);
    });
  });
}
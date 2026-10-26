import sqlite3 from 'sqlite3';
import { DB }   from '../../config/app.config.js';

/**
 * src/core/mcp/db.js
 *
 * Lightweight SQLite helper for MCP tools.
 * Uses OPEN_READWRITE so signals_mark_used can write.
 */

const DB_PATH = DB.storagePath;

let _db = null;
let opening = null;

async function getDb() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      _db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, error => {
        if (error) {
          _db = null;
          opening = null;
          reject(new Error('Cannot open EANyra database. Run a CLI scrape to initialize it first.'));
        } else {
          _db.configure('busyTimeout', DB.busyTimeoutMs);
          resolve(_db);
        }
      });
    });
  }
  return opening;
}

export async function closeDb() {
  if (!opening) return;
  const db = await opening;
  await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  _db = null;
  opening = null;
}

/** Run a SELECT, return all rows. */
export async function query(sql, params = []) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else     resolve(rows ?? []);
    });
  });
}

/** Run a SELECT, return the first row or null. */
export async function queryOne(sql, params = []) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else     resolve(row ?? null);
    });
  });
}

/** Run an INSERT / UPDATE / DELETE, return { lastID, changes }. */
export async function run(sql, params = []) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else     resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

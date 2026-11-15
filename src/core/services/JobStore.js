/**
 * Durable background jobs (table `jobs`).
 *
 * A job is a request to do something in the background — today a collection
 * run — made by MCP, the CLI, the scheduler or the web UI. Job state survives
 * restarts of the process that requested it, so any front end can show it.
 *
 * Lifecycle: queued → running → success | partial | failed
 * A running job whose worker process no longer exists is marked failed by
 * recoverOrphans(), so a crash never leaves a job "running" forever.
 */

import { randomUUID } from 'node:crypto';
import { parseJson } from './sql.js';

export const JOB_TYPES = ['scrape'];
export const JOB_SOURCES = ['mcp', 'cli', 'scheduler', 'web'];
const ACTIVE = ['queued', 'running'];
const FINAL = ['success', 'partial', 'failed'];

export class JobStore {
  /**
   * @param {import('./sql.js').Executor} db
   * @param {{ isAlive?: (pid: number) => boolean, now?: () => Date }} [opts]
   */
  constructor(db, { isAlive = isProcessAlive, now = () => new Date() } = {}) {
    this.db = db;
    this.isAlive = isAlive;
    this.now = now;
  }

  async create({ type, source, params = {} }) {
    if (!JOB_TYPES.includes(type)) throw new Error(`Unknown job type: ${type}`);
    if (!JOB_SOURCES.includes(source)) throw new Error(`Unknown job source: ${source}`);
    const id = randomUUID();
    await this.db.run(
      'INSERT INTO jobs (id, type, source, status, params, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, type, source, 'queued', JSON.stringify(params), this.#ts()],
    );
    return this.get(id);
  }

  async start(id, pid = process.pid) {
    const ts = this.#ts();
    await this.db.run(
      "UPDATE jobs SET status = 'running', pid = ?, started_at = ?, heartbeat_at = ? WHERE id = ? AND status = 'queued'",
      [pid, ts, ts, id],
    );
  }

  /** Final state; ignored when the job already finished (first writer wins). */
  async finish(id, { status, result = null, error = null }) {
    if (!FINAL.includes(status)) throw new Error(`Invalid final job status: ${status}`);
    await this.db.run(
      `UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
      [status, result === null ? null : JSON.stringify(result), error, this.#ts(), id],
    );
  }

  async get(id) {
    const row = await this.db.get('SELECT * FROM jobs WHERE id = ?', [id]);
    return row ? format(row) : null;
  }

  async list({ limit = 20, status } = {}) {
    const rows = status
      ? await this.db.all('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?', [status, limit])
      : await this.db.all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map(format);
  }

  /** Active jobs of a type after crash recovery. */
  async active(type) {
    await this.recoverOrphans();
    const rows = await this.db.all(
      `SELECT * FROM jobs WHERE type = ? AND status IN (${ACTIVE.map(() => '?').join(', ')}) ORDER BY created_at`,
      [type, ...ACTIVE],
    );
    return rows.map(format);
  }

  /**
   * Fail running jobs whose worker died, and queued jobs never picked up
   * within `queuedTimeoutMs` (their requester died before spawning a worker).
   */
  async recoverOrphans({ queuedTimeoutMs = 2 * 60_000 } = {}) {
    const rows = await this.db.all(
      `SELECT id, status, pid, created_at FROM jobs WHERE status IN (${ACTIVE.map(() => '?').join(', ')})`,
      ACTIVE,
    );
    const now = this.now().getTime();
    let recovered = 0;
    for (const row of rows) {
      const dead = row.status === 'running'
        ? !(Number.isInteger(row.pid) && this.isAlive(row.pid))
        : now - new Date(row.created_at).getTime() > queuedTimeoutMs;
      if (!dead) continue;
      await this.finish(row.id, {
        status: 'failed',
        error: row.status === 'running'
          ? 'Interrupted: the worker process ended before finishing. Check scraper_status for the collection run.'
          : 'Never started: the requesting process ended before launching the worker.',
      });
      recovered++;
    }
    return recovered;
  }

  #ts() {
    return this.now().toISOString();
  }
}

function format(row) {
  return {
    job_id: row.id,
    type: row.type,
    source: row.source,
    status: row.status,
    ...parseJson(row.params, {}),
    ...(row.result ? { result: parseJson(row.result) } : {}),
    ...(row.error ? { error: row.error } : {}),
    created_at: iso(row.created_at),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
  };
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

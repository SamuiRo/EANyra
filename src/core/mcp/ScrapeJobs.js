import { fork } from 'node:child_process';
import { normalizeSelection } from '../../config/accountConfig.js';
import { vaultKeyForWorker } from '../secrets/vaultAccess.js';
import { JobStore } from '../services/JobStore.js';
import { mcpExecutor } from '../services/sql.js';
import * as mcpDb from './db.js';

/**
 * Starts collection jobs in a separate worker process and tracks them in the
 * durable `jobs` table, so job state survives an MCP restart and is visible
 * to every front end. The worker marks the job running and records the
 * outcome itself; this class only fills in when the worker dies silently.
 */
export class ScrapeJobs {
  /**
   * @param {{ spawn?: typeof fork, getVaultKey?: () => Promise<object|null>,
   *           store?: JobStore, source?: string }} [deps]
   *   getVaultKey unlocks the vault non-interactively; the key reaches the
   *   worker only over IPC, never through argv or the environment.
   */
  constructor({ spawn = fork, getVaultKey = vaultKeyForWorker, store, source = 'mcp' } = {}) {
    this.spawn = spawn;
    this.getVaultKey = getVaultKey;
    this.store = store ?? new JobStore(mcpExecutor(mcpDb));
    this.source = source;
    this.children = new Set();
    this.starting = false;
  }

  async start(args = {}) {
    const selection = normalizeSelection(args);
    // Guards this process; the scrape lock and the job table guard the rest.
    if (this.starting) throw new Error('A scrape is already being started.');
    this.starting = true;
    try {
      const [active] = await this.store.active('scrape');
      if (active) throw new Error(`Scrape already running: ${active.job_id}`);
      const vaultKey = await this.getVaultKey();
      const job = await this.store.create({ type: 'scrape', source: this.source, params: selection });
      this.#spawn(job.job_id, selection, vaultKey);
      return job;
    } finally {
      this.starting = false;
    }
  }

  async get(jobId) {
    await this.store.recoverOrphans();
    const job = await this.store.get(jobId);
    if (!job) throw new Error('Unknown job_id. Use scraper_jobs_list or scraper_status for collection history.');
    return job;
  }

  async list(opts) {
    await this.store.recoverOrphans();
    return this.store.list(opts);
  }

  #spawn(jobId, selection, vaultKey) {
    const fail = message => this.store.finish(jobId, { status: 'failed', error: message }).catch(() => {});
    let child;
    try {
      child = this.spawn(new URL('./scrapeWorker.js', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
        execArgv: [],
      });
    } catch (error) {
      void fail(`Could not start the scrape worker: ${error.message}`);
      throw error;
    }
    this.children.add(child);
    let exited = false;
    const done = message => {
      if (exited) return;
      exited = true;
      this.children.delete(child);
      // No-op when the worker already recorded its outcome.
      if (message) void fail(message);
    };
    child.on('error', error => done(error.message));
    child.on('exit', (code, signal) => done(code === 0
      ? null : `Scrape worker exited (${signal ?? code}). Check scraper_status and the scrape lock if it was interrupted.`));
    try {
      child.send({ jobId, selection, vaultKey }, error => { if (error) { child.kill(); done(error.message); } });
    } catch (error) {
      child.kill();
      done(error.message);
    }
  }

  close() {
    for (const child of this.children) child.kill();
  }
}

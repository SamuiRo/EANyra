import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { normalizeSelection } from '../../config/accountConfig.js';

export class ScrapeJobs {
  constructor({ spawn = fork } = {}) {
    this.spawn = spawn;
    this.jobs = new Map();
    this.active = null;
  }

  start(args = {}) {
    const selection = normalizeSelection(args);
    if (this.active) throw new Error(`Scrape already running: ${this.active}`);
    const job = { job_id: randomUUID(), status: 'running', started_at: new Date().toISOString(), ...selection };
    // Keep a bounded history; durable collection results live in scraper_runs.
    if (this.jobs.size >= 50) this.jobs.delete(this.jobs.keys().next().value);
    const child = this.spawn(new URL('./scrapeWorker.js', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      execArgv: [],
    });
    this.active = job.job_id;
    this.jobs.set(job.job_id, job);
    this.child = child;
    let outcome;
    child.on('message', message => { outcome = message; });
    const finish = error => {
      if (job.status !== 'running') return;
      job.finished_at = new Date().toISOString();
      job.status = error || outcome?.error ? 'failed' : (outcome?.result?.status ?? 'failed');
      if (outcome?.result) job.result = outcome.result;
      if (error || outcome?.error) job.error = outcome?.error ?? error;
      this.active = null;
      this.child = null;
    };
    child.on('error', error => finish(error.message));
    child.on('exit', (code, signal) => finish(code === 0 && outcome
      ? null : `Scrape worker exited (${signal ?? code}). Check scraper_status and the scrape lock if it was interrupted.`));
    try {
      child.send(selection, error => { if (error) { child.kill(); finish(error.message); } });
    } catch (error) {
      child.kill();
      finish(error.message);
    }
    return { ...job };
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Unknown job_id. Job history is local to this MCP process; use scraper_status for persisted run history.');
    return { ...job };
  }

  close() {
    this.child?.kill();
  }
}

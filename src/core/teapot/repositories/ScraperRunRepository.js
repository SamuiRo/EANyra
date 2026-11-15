/**
 * src/teapot/repositories/ScraperRunRepository.js
 *
 * Thin wrapper around the ScraperRun model.
 * Keeps all run-lifecycle DB calls in one place so the orchestrator
 * stays focused on coordination logic.
 */

import { QueryTypes } from 'sequelize';
import { print } from '../../../shared/utils.js';

export class ScraperRunRepository {
  /** @param {import('sequelize').ModelStatic} ScraperRunModel */
  constructor(ScraperRunModel) {
    this.ScraperRun = ScraperRunModel;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Close runs left "running" by a killed process. Call only while holding the
   * scrape lock: then no other collection can be in progress.
   * @returns {Promise<number>} number of recovered runs
   */
  async failOrphans() {
    const orphans = await this.ScraperRun.findAll({ where: { status: 'running' } });
    for (const run of orphans) {
      await run.update({
        finished_at:   new Date(),
        status:        'failed',
        error_message: 'Interrupted: the process ended before this run finished.',
      });
      print(`Marked interrupted run #${run.id} as failed.`, 'warning');
    }
    return orphans.length;
  }

  /**
   * Per-account outcome of one run (table scraper_run_accounts).
   * @param {{ status: 'success'|'failed'|'skipped', found?: number, saved?: number,
   *           error?: string|null, startedAt: Date, session?: string|null }} outcome
   */
  async recordAccount(run, account, { status, found = 0, saved = 0, error = null, startedAt, session = null }) {
    await this.ScraperRun.sequelize.query(
      `INSERT INTO scraper_run_accounts
         (run_id, account_id, platform, username, session, status, records_found, records_saved, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [run.id, account.id, account.platform, account.username, session, status,
          found, saved, error, startedAt.toISOString(), new Date().toISOString()],
        type: QueryTypes.INSERT,
      },
    );
  }

  /**
   * Insert a new run record with status "running".
   * @returns {Promise<import('sequelize').Model>} The created run instance.
   */
  async start() {
    const run = await this.ScraperRun.create({
      started_at:          new Date(),
      status:              'running',
      accounts_processed:  0,
      posts_saved:         0,
      signals_saved:       0,
    });
    print(`Scraper run #${run.id} started.`, 'system');
    return run;
  }

  /**
   * Mark a run as successfully finished.
   * @param {import('sequelize').Model} run
   * @param {{ accountsProcessed: number, postsSaved: number, signalsSaved?: number }} stats
   */
  async finish(run, { accountsProcessed, postsSaved, signalsSaved = 0 }) {
    await run.update({
      finished_at:         new Date(),
      status:              'success',
      accounts_processed:  accountsProcessed,
      posts_saved:         postsSaved,
      signals_saved:       signalsSaved,
    });
    print(
      `Run #${run.id} finished — accounts: ${accountsProcessed}, new posts: ${postsSaved}, new signals: ${signalsSaved}.`,
      'success',
    );
  }

  /**
   * Mark a run as partially succeeded (some accounts failed, some succeeded).
   * @param {import('sequelize').Model} run
   * @param {{ accountsProcessed: number, postsSaved: number, errorMessage: string }} stats
   */
  async partialFinish(run, { accountsProcessed, postsSaved, signalsSaved = 0, errorMessage }) {
    await run.update({
      finished_at:         new Date(),
      status:              'partial',
      accounts_processed:  accountsProcessed,
      posts_saved:         postsSaved,
      signals_saved:       signalsSaved,
      error_message:       errorMessage,
    });
    print(`Run #${run.id} finished with partial success. Errors: ${errorMessage}`, 'warning');
  }

  /**
   * Mark a run as completely failed.
   * @param {import('sequelize').Model} run
   * @param {string|Error} error
   */
  async fail(run, error) {
    const message = error instanceof Error ? error.message : String(error);
    await run.update({
      finished_at:   new Date(),
      status:        'failed',
      error_message: message,
    });
    print(`Run #${run.id} failed: ${message}`, 'error');
  }
}
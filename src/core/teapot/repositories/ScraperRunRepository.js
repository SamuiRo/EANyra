/**
 * src/teapot/repositories/ScraperRunRepository.js
 *
 * Thin wrapper around the ScraperRun model.
 * Keeps all run-lifecycle DB calls in one place so the orchestrator
 * stays focused on coordination logic.
 */

import { print } from '../../../shared/utils.js';

export class ScraperRunRepository {
  /** @param {import('sequelize').ModelStatic} ScraperRunModel */
  constructor(ScraperRunModel) {
    this.ScraperRun = ScraperRunModel;
  }

  // ── Public API ────────────────────────────────────────────────────────────

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
    });
    print(`Scraper run #${run.id} started.`, 'system');
    return run;
  }

  /**
   * Mark a run as successfully finished.
   * @param {import('sequelize').Model} run
   * @param {{ accountsProcessed: number, postsSaved: number }} stats
   */
  async finish(run, { accountsProcessed, postsSaved }) {
    await run.update({
      finished_at:         new Date(),
      status:              'success',
      accounts_processed:  accountsProcessed,
      posts_saved:         postsSaved,
    });
    print(
      `Run #${run.id} finished — accounts: ${accountsProcessed}, new posts: ${postsSaved}.`,
      'success',
    );
  }

  /**
   * Mark a run as partially succeeded (some accounts failed, some succeeded).
   * @param {import('sequelize').Model} run
   * @param {{ accountsProcessed: number, postsSaved: number, errorMessage: string }} stats
   */
  async partialFinish(run, { accountsProcessed, postsSaved, errorMessage }) {
    await run.update({
      finished_at:         new Date(),
      status:              'partial',
      accounts_processed:  accountsProcessed,
      posts_saved:         postsSaved,
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
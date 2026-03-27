import cron              from 'node-cron';
import { SCHEDULER }     from '../../config/app.config.js';
import { print }         from '../../shared/utils.js';

/**
 * Scheduler
 *
 * Wraps node-cron to trigger ScraperOrchestrator on a configurable schedule.
 * Default: once per day at 08:00 (set CRON_SCHEDULE in .env to override).
 *
 * Cron format: second(optional) minute hour day-of-month month day-of-week
 * Examples:
 *   "0 8 * * *"    → every day at 08:00
 *   "0 8,20 * * *" → 08:00 and 20:00 every day
 */
export class Scheduler {
  /** @param {() => Promise<void>} runFn – async function to call on each tick */
  constructor(runFn) {
    this.runFn = runFn;
    this.task  = null;
    this.#validateSchedule();
  }

  /**
   * Start the cron scheduler.
   * If SCHEDULER.runOnStartup is true, executes immediately before scheduling.
   */
  async start() {
    if (SCHEDULER.runOnStartup) {
      print('RUN_ON_STARTUP=true — executing initial run now.', 'system');
      await this.#execute();
    }

    this.task = cron.schedule(SCHEDULER.cronSchedule, () => this.#execute(), {
      scheduled: true,
      timezone:  'UTC',
    });

    print(`Scheduler started. Next runs: ${SCHEDULER.cronSchedule} (UTC)`, 'system');
  }

  /**
   * Stop the cron scheduler gracefully.
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      print('Scheduler stopped.', 'system');
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  async #execute() {
    print('Cron tick — starting scrape run.', 'system');
    try {
      await this.runFn();
    } catch (error) {
      // Already logged inside the orchestrator; catch here to keep cron alive
      print(`Scheduled run failed: ${error.message}`, 'error');
    }
  }

  #validateSchedule() {
    if (!cron.validate(SCHEDULER.cronSchedule)) {
      throw new Error(
        `[Scheduler] Invalid CRON_SCHEDULE: "${SCHEDULER.cronSchedule}". ` +
        'Use standard 5-field cron syntax, e.g. "0 8 * * *".',
      );
    }
  }
}
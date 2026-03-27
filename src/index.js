/**
 * src/index.js — EANyra entry point
 *
 * Modes:
 *   node src/index.js          → daemon mode (runs on cron schedule)
 *   node src/index.js scrape   → single run then exit
 */

import database                  from './teapot/database.js';
import { registerModels }        from './teapot/models/index.js';
import { ScraperOrchestrator }   from './module/orchestrator/ScraperOrchestrator.js';
import { Scheduler }             from './module/scheduler/Scheduler.js';
import { PKG, NODE_ENV, SCHEDULER } from './config/app.config.js';
import { banner, print }         from './shared/utils.js';
import { WELCOME_MESSAGE, SUB_TITLE } from './shared/message.js';

class Nyra {
  /** @type {{ Account, Post, ScraperRun }} */
  #models = null;

  // ── Initialisation ────────────────────────────────────────────────────────

  async #bootstrap() {
    banner(WELCOME_MESSAGE, SUB_TITLE);
    print(`EANyra v${PKG.version}`, 'info');
    print(
      `Mode: ${process.argv[2] ?? 'daemon'} · NODE_ENV=${NODE_ENV ?? 'unset'}`,
      'system',
    );

    print('Connecting to database…', 'system');
    await database.connect();

    print('Registering Sequelize models…', 'system');
    this.#models = registerModels(database.sequelize);

    print('Synchronising schema (ALTER)…', 'system');
    await database.sequelize.sync({ alter: true });
  }

  // ── Run modes ─────────────────────────────────────────────────────────────

  /**
   * Single scrape run — used by `npm run scrape` and cron ticks.
   * Delegates entirely to ScraperOrchestrator.
   */
  async #scrapeOnce() {
    const orchestrator = new ScraperOrchestrator(this.#models);
    await orchestrator.run();
  }

  async runOnce() {
    print('Mode: single run', 'system');
    try {
      await this.#scrapeOnce();
    } finally {
      await database.disconnect();
    }
  }

  async runDaemon() {
    // Normalise runOnStartup to boolean (env vars arrive as strings)
    if (typeof SCHEDULER.runOnStartup === 'string') {
      SCHEDULER.runOnStartup = SCHEDULER.runOnStartup.toLowerCase() === 'true';
    }

    print('Mode: scheduler daemon', 'system');
    const scheduler = new Scheduler(() => this.#scrapeOnce());
    await scheduler.start();

    // ── Graceful shutdown ──────────────────────────────────────────────────
    const shutdown = async signal => {
      print(`Received ${signal} — shutting down…`, 'system');
      scheduler.stop();
      await database.disconnect();
      process.exit(0);
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  // ── Main ──────────────────────────────────────────────────────────────────

  async main() {
    try {
      await this.#bootstrap();

      const mode = process.argv[2];
      if (mode === 'scrape') {
        await this.runOnce();
      } else {
        await this.runDaemon();
      }
    } catch (error) {
      print(`Startup failed: ${error.message}`, 'error');
      console.error(error);
      try { await database.disconnect(); } catch { /* ignore */ }
      process.exit(1);
    }
  }
}

const nyra = new Nyra();
nyra.main();
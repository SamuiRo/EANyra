#!/usr/bin/env node
/**
 * src/core/cli/index.js — EANyra CLI entry point
 *
 * Commands:
 *   eanyra start                → daemon mode (runs on cron schedule)
 *   eanyra scrape               → single run across all platforms, then exit
 *   eanyra scrape twitter       → single run for Twitter/X only, then exit
 *
 * The old `node src/core/cli/index.js scrape` invocation still works
 * because `scrape` without a sub-argument defaults to all platforms.
 */

import { Command }               from 'commander';
import database                  from '../teapot/database.js';
import { registerModels }        from '../teapot/models/index.js';
import { ScraperOrchestrator }   from '../orchestrator/ScraperOrchestrator.js';
import { Scheduler }             from '../scheduler/Scheduler.js';
import { PKG, NODE_ENV }         from '../../config/app.config.js';
import { banner, print }         from '../../shared/utils.js';
import { WELCOME_MESSAGE, SUB_TITLE } from '../../shared/message.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

class Nyra {
  /** @type {{ Account, Post, ScraperRun }} */
  #models = null;

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

    await this.#syncSchema();
  }

  /**
   * SQLite + Sequelize alter mode can rebuild tables via DROP/CREATE.
   * Temporarily disable FK checks only for schema sync.
   */
  async #syncSchema() {
    const isSqlite = database.sequelize.getDialect() === 'sqlite';

    print('Synchronising schema (ALTER)…', 'system');
    if (isSqlite) {
      print('SQLite detected: temporarily disabling FK checks for ALTER sync.', 'system');
      await database.sequelize.query('PRAGMA foreign_keys = OFF;');
    }

    try {
      await database.sequelize.sync({ alter: true });
    } catch (error) {
      const isSqliteConstraint =
        isSqlite &&
        (
          error?.name?.includes('ConstraintError') ||
          error?.name?.includes('ValidationError') ||
          String(error?.message ?? '').includes('SQLITE_CONSTRAINT') ||
          String(error?.original?.code ?? '').includes('SQLITE_CONSTRAINT') ||
          String(error?.parent?.code ?? '').includes('SQLITE_CONSTRAINT')
        );

      if (!isSqliteConstraint) throw error;

      print(
        'SQLite ALTER sync failed on constraints. Falling back to safe sync without ALTER.',
        'warning',
      );
      await database.sequelize.sync();
    } finally {
      if (isSqlite) {
        await database.sequelize.query('PRAGMA foreign_keys = ON;');
      }
    }
  }

  // ── Run modes ─────────────────────────────────────────────────────────────

  /**
   * Single scrape run. If `platformId` is provided, only that platform runs.
   * Currently only 'twitter' exists; the param is reserved for future platforms.
   *
   * @param {{ platform?: string }} [opts]
   */
  async #scrapeOnce({ platform } = {}) {
    const orchestrator = new ScraperOrchestrator(this.#models);
    await orchestrator.run({ platform });
  }

  async runOnce(opts = {}) {
    print(`Mode: single run${opts.platform ? ` (platform: ${opts.platform})` : ''}`, 'system');
    try {
      await this.#scrapeOnce(opts);
    } finally {
      await database.disconnect();
    }
  }

  async runDaemon() {
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

      const program = buildCLI(this);
      await program.parseAsync(process.argv);

    } catch (error) {
      print(`Startup failed: ${error.message}`, 'error');
      console.error(error);
      try { await database.disconnect(); } catch { /* ignore */ }
      process.exit(1);
    }
  }
}

// ─── Commander setup ──────────────────────────────────────────────────────────

/**
 * Build the Commander program.
 * Separated from Nyra so it's easy to unit-test without a real DB.
 *
 * @param {Nyra} nyra
 * @returns {import('commander').Command}
 */
function buildCLI(nyra) {
  const program = new Command();

  program
    .name('eanyra')
    .description('Twitter/X monitoring pipeline for AI agent data pipelines')
    .version(PKG.version, '-v, --version', 'Print version and exit');

  // ── eanyra start ─────────────────────────────────────────────────────────
  program
    .command('start')
    .description('Start the daemon — scrapes on the configured cron schedule (default: 08:00 UTC daily)')
    .action(async () => {
      await nyra.runDaemon();
    });

  // ── eanyra scrape [platform] ──────────────────────────────────────────────
  const scrapeCmd = program
    .command('scrape [platform]')
    .description(
      'Run a single scrape then exit.\n' +
      '  eanyra scrape            → all platforms\n' +
      '  eanyra scrape twitter    → Twitter/X only',
    )
    .action(async (platform) => {
      const validPlatforms = ['twitter'];

      if (platform && !validPlatforms.includes(platform)) {
        print(
          `Unknown platform "${platform}". Valid options: ${validPlatforms.join(', ')}`,
          'error',
        );
        process.exit(1);
      }

      await nyra.runOnce({ platform });
    });

  // ── Default: no command provided → start daemon (backwards-compat) ────────
  // When users run `node src/core/cli/index.js` with no args, act as daemon.
  program
    .action(async () => {
      await nyra.runDaemon();
    });

  return program;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const nyra = new Nyra();
nyra.main();
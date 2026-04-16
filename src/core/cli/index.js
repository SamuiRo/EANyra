#!/usr/bin/env node
/**
 * src/core/cli/index.js — EANyra CLI entry point
 *
 * Commands:
 *   eanyra start                → daemon mode (runs on cron schedule)
 *   eanyra scrape               → single run across all platforms, then exit
 *   eanyra scrape twitter       → Twitter/X only
 *   eanyra scrape github        → GitHub only
 *   eanyra scrape linkedin      → LinkedIn CSV import only
 *   eanyra context sync         → sync YAML context files into DB
 *   eanyra context show         → print current context from DB
 *   eanyra export               → export data to Markdown for AI content creation
 */

import { Command }                    from 'commander';
import database                       from '../teapot/database.js';
import { registerContextCommands }    from './contextCommands.js';
import { registerExportCommands }     from './exportCommands.js';
import { registerModels }             from '../teapot/models/index.js';
import { ScraperOrchestrator }        from '../orchestrator/ScraperOrchestrator.js';
import { Scheduler }                  from '../scheduler/Scheduler.js';
import { PKG, NODE_ENV }              from '../../config/app.config.js';
import { banner, print }              from '../../shared/utils.js';
import { WELCOME_MESSAGE, SUB_TITLE } from '../../shared/message.js';

/** All recognised platform identifiers. Add new platforms here. */
const VALID_PLATFORMS = ['twitter', 'github', 'linkedin'];

// ─── Bootstrap ────────────────────────────────────────────────────────────────

class Nyra {
  /** @type {{ Account, Post, Signal, ScraperRun, UserContext, Project }} */
  #models = null;

  get models() { return this.#models; }

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

    const shutdown = async signal => {
      print(`Received ${signal} — shutting down…`, 'system');
      scheduler.stop();
      await database.disconnect();
      process.exit(0);
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

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

function buildCLI(nyra) {
  const program = new Command();

  program
    .name('eanyra')
    .description('Social media monitoring pipeline for AI agent data pipelines')
    .version(PKG.version, '-v, --version', 'Print version and exit');

  program
    .command('start')
    .description('Start the daemon — scrapes on the configured cron schedule (default: 08:00 UTC daily)')
    .action(async () => {
      await nyra.runDaemon();
    });

  program
    .command('scrape [platform]')
    .description(
      'Run a single scrape then exit.\n' +
      '  eanyra scrape            → all platforms\n' +
      '  eanyra scrape twitter    → Twitter/X only\n' +
      '  eanyra scrape github     → GitHub only\n' +
      '  eanyra scrape linkedin   → LinkedIn CSV import only',
    )
    .action(async (platform) => {
      if (platform && !VALID_PLATFORMS.includes(platform)) {
        print(
          `Unknown platform "${platform}". Valid options: ${VALID_PLATFORMS.join(', ')}`,
          'error',
        );
        process.exit(1);
      }
      await nyra.runOnce({ platform });
    });

  registerContextCommands(program, nyra.models);
  registerExportCommands(program, nyra.models);

  // Default: no command → daemon (backwards-compat)
  program.action(async () => {
    await nyra.runDaemon();
  });

  return program;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const nyra = new Nyra();
nyra.main();
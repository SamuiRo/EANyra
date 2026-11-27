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
 *   eanyra scrape telegram      → Telegram polling only
 *   eanyra sources collect      → read persona sources (GitHub, Reddit, RSS) into signals
 *   eanyra context sync         → sync YAML context files into DB
 *   eanyra context show         → print current context from DB
 *   eanyra export               → export data to Markdown for AI content creation
 *   eanyra vault …              → encrypted credentials (init, status, migrate, remember)
 *   eanyra secrets …            → store GitHub / bot tokens and Telegram API keys
 *   eanyra sessions             → which login each account uses and its state
 *   eanyra serve [--schedule]   → local web UI on 127.0.0.1
 *   eanyra notify …             → problem alerts via Telegram bot / Discord webhook
 */

import { Command }                    from 'commander';
import database                       from '../teapot/database.js';
import { registerContextCommands }    from './contextCommands.js';
import { registerExportCommands }     from './exportCommands.js';
import { registerVaultCommands }      from './vaultCommands.js';
import { registerNotifyCommands }     from './notifyCommands.js';
import { registerLinkedinCommands }   from './linkedinCommands.js';
import { registerSourcesCommands }    from './sourcesCommands.js';
import { Credentials }                from '../secrets/Credentials.js';
import { registerModels }             from '../teapot/models/index.js';
import { SchemaMigrator }             from '../teapot/SchemaMigrator.js';
import { ScraperOrchestrator }        from '../orchestrator/ScraperOrchestrator.js';
import { Scheduler }                  from '../scheduler/Scheduler.js';
import { PKG, NODE_ENV, SUPPORTED_PLATFORMS, PATHS, DB, INSTANCE_DIR, PROJECT_ROOT } from '../../config/app.config.js';
import { initializeInstance } from '../instance/InstanceManager.js';
import { createBackup, timestamp } from '../instance/Backup.js';
import { onShutdown }             from '../../shared/shutdown.js';
import path                       from 'node:path';
import { banner, print }              from '../../shared/utils.js';
import { WELCOME_MESSAGE, SUB_TITLE } from '../../shared/message.js';

// --quiet / --debug apply before Commander parses, so startup output obeys them too.
if (process.argv.includes('--quiet')) process.env.LOG_LEVEL = 'warn';
if (process.argv.includes('--debug')) process.env.LOG_LEVEL = 'debug';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

class Nyra {
  /** @type {{ Account, Post, Signal, ScraperRun, UserContext, Project }} */
  #models = null;
  /** Unlocked once for the daemon so cron runs do not prompt. */
  #credentials = null;

  get models() { return this.#models; }

  async #bootstrap() {
    banner(WELCOME_MESSAGE, SUB_TITLE);
    print(`EANyra v${PKG.version}`, 'info');
    print(
      `Mode: ${process.argv[2] ?? 'daemon'} · NODE_ENV=${NODE_ENV ?? 'unset'}`,
      'system',
    );

    if (process.argv[2] === 'serve') {
      // Web-first setup: a missing instance is created empty; the rest is done in the browser.
      const { created } = await initializeInstance({ projectRoot: PROJECT_ROOT, instanceDir: INSTANCE_DIR, withEnv: false, exampleAccounts: false });
      if (created.length) print(`New instance ${INSTANCE_DIR}: created ${created.join(', ')}`, 'success');
    }

    print('Connecting to database…', 'system');
    await database.connect();

    print('Registering Sequelize models…', 'system');
    this.#models = registerModels(database.sequelize);

    await this.#syncSchema();
  }

  async #syncSchema() {
    print('Applying schema migrations...', 'system');
    const completed = await new SchemaMigrator(database.sequelize).migrate();
    if (completed.length) {
      print(`Applied ${completed.length} schema migration(s).`, 'success');
    } else {
      print('Schema is up to date.', 'system');
    }

  }

  // ── Run modes ─────────────────────────────────────────────────────────────

  /** Aborted by the first Ctrl+C: the active run stops after its current account. */
  #stop = new AbortController();
  #activeRun = null;

  async #scrapeOnce({ platform, accounts } = {}) {
    const orchestrator = new ScraperOrchestrator(this.#models, { credentials: this.#credentials ?? undefined });
    this.#activeRun = orchestrator.run({ platform, accounts }, { signal: this.#stop.signal });
    try {
      await this.#activeRun;
    } finally {
      this.#activeRun = null;
    }
  }

  async runOnce(opts = {}) {
    print(`Mode: single run${opts.platform ? ` (platform: ${opts.platform})` : ''}`, 'system');
    const removeHandlers = onShutdown({
      // The run itself finishes, saves sessions and releases the lock.
      graceful: async () => {
        this.#stop.abort();
        await this.#activeRun?.catch(() => {});
        await database.disconnect().catch(() => {});
      },
    });
    try {
      await this.#scrapeOnce(opts);
    } finally {
      removeHandlers();
      await database.disconnect();
    }
  }

  async runDaemon() {
    print('Mode: scheduler daemon', 'system');
    // Unlock now (prompt, remembered key or env) rather than at 08:00 with no terminal.
    this.#credentials = await Credentials.open();
    const scheduler = new Scheduler(() => this.#scrapeOnce());
    await scheduler.start();

    onShutdown({
      graceful: async signal => {
        print(`Received ${signal} — stopping the scheduler…`, 'system');
        scheduler.stop();
        this.#stop.abort();
        await this.#activeRun?.catch(() => {});
        await database.disconnect().catch(() => {});
      },
    });
  }

  async main() {
    try {
      await this.#bootstrap();
      const program = buildCLI(this);
      await program.parseAsync(process.argv);
    } catch (error) {
      print(`Failed: ${error.message}`, 'error');
      if (process.env.LOG_LEVEL === 'debug') console.error(error);
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
    .description('AI-assisted social media workspace: collection, content planning, drafts, MCP and a local web UI')
    .version(PKG.version, '-v, --version', 'Print version and exit')
    .option('--quiet', 'Only warnings and errors (same as LOG_LEVEL=warn)')
    .option('--debug', 'Include debug output (same as LOG_LEVEL=debug)');

  program
    .command('start')
    .description('Start the daemon — scrapes on the configured cron schedule (default: 08:00 UTC daily)')
    .action(async () => {
      await nyra.runDaemon();
    });

  program
    .command('scrape [platform]')
    .option('--account <username...>', 'Collect only these configured accounts (requires platform)')
    .description(
      'Run a single scrape then exit.\n' +
      '  eanyra scrape            → all platforms\n' +
      '  eanyra scrape twitter    → Twitter/X only\n' +
      '  eanyra scrape github     → GitHub only\n' +
      '  eanyra scrape linkedin   → LinkedIn CSV import only\n' +
      '  eanyra scrape telegram   → Telegram polling only',
    )
    .action(async (platform, options) => {
      if (platform && !SUPPORTED_PLATFORMS.includes(platform)) {
        print(
          `Unknown platform "${platform}". Valid options: ${SUPPORTED_PLATFORMS.join(', ')}`,
          'error',
        );
        process.exit(1);
      }
      await nyra.runOnce({ platform, accounts: options.account });
    });

  program
    .command('serve')
    .description('Start the local web UI (http://localhost:4450) to manage everything from the browser')
    .option('--port <port>', 'Port (default WEB_PORT or 4450)')
    .option('--schedule', 'Also run scheduled collection (CRON_SCHEDULE) in this process')
    .option('--mcp', 'Also serve MCP for AI clients at /mcp (token: npm run nyra -- mcp token)')
    .action(async options => {
      const { startWebServer } = await import('../../web/start.js');
      const { shutdown } = await startWebServer({
        ...(options.port ? { port: Number(options.port) } : {}),
        schedule: Boolean(options.schedule),
        mcp: Boolean(options.mcp),
        models: nyra.models,
      });
      onShutdown({
        timeoutMs: 150_000,
        graceful: async () => {
          await shutdown();
          await database.disconnect().catch(() => {});
        },
      });
    });

  program
    .command('backup')
    .description('Snapshot the database (online, integrity-checked) with the vault, accounts, alerts and context')
    .option('--out <dir>', 'Backup folder (default instance/backups/eanyra-<time>); prefer another disk')
    .option('--include-env', 'Also copy the root .env (may contain plaintext settings or legacy secrets)')
    .action(async options => {
      const outDir = path.resolve(options.out ?? path.join(INSTANCE_DIR, 'backups', `eanyra-${timestamp()}`));
      const { manifest } = await createBackup({
        sequelize: database.sequelize, outDir, includeEnv: Boolean(options.includeEnv), appVersion: PKG.version,
        paths: {
          db: DB.storagePath, vault: PATHS.vaultFile, accounts: PATHS.accountsConfig,
          notifications: PATHS.notificationsConfig, context: PATHS.contextDir, env: PATHS.envFile,
        },
      });
      const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
      print(`Backup ready: ${outDir} (${manifest.files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB, database integrity ok).`, 'success');
      for (const note of manifest.notes) print(note, 'info');
      print(`Restore: npm run instance:restore -- "${outDir}" --yes  (stop collection, MCP and the web UI first)`, 'info');
      await database.disconnect();
    });

  registerContextCommands(program, nyra.models);
  registerExportCommands(program, nyra.models);
  registerVaultCommands(program);
  registerNotifyCommands(program);
  registerLinkedinCommands(program, () => nyra.models);
  registerSourcesCommands(program);

  // Default: no command → daemon (backwards-compat)
  program.action(async () => {
    await nyra.runDaemon();
  });

  return program;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const nyra = new Nyra();
nyra.main();

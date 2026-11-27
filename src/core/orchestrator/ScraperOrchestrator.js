/**
 * src/core/orchestrator/ScraperOrchestrator.js
 *
 * Coordinates one collection run across the configured accounts. It is
 * platform-agnostic: what each platform collects lives in
 * platforms/collectors.js, where its records go in platforms/catalog.js.
 *
 * Flow:
 *   1. Take the scrape lock; close runs a crashed process left "running"
 *   2. Open a ScraperRun record (status: running)
 *   3. Sync accounts.json → DB and select accounts (platform / account filter)
 *   4. For each account: collector.collect() → save posts or signals →
 *      update account health → record the per-account outcome
 *   5. Close runtime clients; refreshed X sessions are re-encrypted into the vault
 *   6. Finalise the ScraperRun record (success / partial / failed)
 *
 * Sessions:
 *   Every account names its login with "session" in accounts.json (default
 *   "default"). X profiles are grouped by session: the long human-like pause
 *   applies only between profiles of one login, and a rejected login stops
 *   only its own accounts. Telegram keeps one MTProto client per session.
 *   Credentials come from the encrypted vault (core/secrets/Credentials.js).
 *
 * Adding a platform: catalog.js entry + collector in collectors.js.
 */

import { Browser }                 from '../browser/Browser.js';
import { TWITTER_SESSION_EXPIRED } from '../../platforms/twitter/index.js';
import {
  createScraper as createTelegramScraper,
  TelegramClient,
} from '../../platforms/telegram/index.js';
import { platformInfo }            from '../../platforms/catalog.js';
import { COLLECTORS }              from '../../platforms/collectors.js';
import { AccountRepository }    from '../teapot/repositories/AccountRepository.js';
import { PostRepository }       from '../teapot/repositories/PostRepository.js';
import { SignalRepository }     from '../teapot/repositories/SignalRepository.js';
import { ScraperRunRepository } from '../teapot/repositories/ScraperRunRepository.js';
import { SourceStateRepository } from '../teapot/repositories/SourceStateRepository.js';
import { LinkedinImportRepository } from '../teapot/repositories/LinkedinImportRepository.js';
import { ChannelStatsRepository } from '../teapot/repositories/ChannelStatsRepository.js';
import { SourceCollector } from '../sources/SourceCollector.js';
import { linkPublishedDrafts } from '../services/draftLinks.js';
import { sequelizeExecutor } from '../services/sql.js';
import { validatePosts, validateSignals, describeRejected } from '../teapot/recordValidation.js';
import { runProblemChecks } from '../notify/index.js';
import { SCRAPER }              from '../../config/app.config.js';
import { print, sleep }         from '../../shared/utils.js';
import { abortableSleep }       from '../../shared/shutdown.js';
import { normalizeSelection, accountKey, sessionOf } from '../../config/accountConfig.js';
import { Credentials } from '../secrets/Credentials.js';
import { acquireScrapeLock } from './ScrapeLock.js';

/** Errors that mean a login itself is unusable, not just one profile. */
const SESSION_ERRORS = [
  TWITTER_SESSION_EXPIRED, 'TWITTER_SESSION_MISSING', 'TELEGRAM_SESSION_FAILED', 'GITHUB_TOKEN_MISSING',
  'DISCORD_TOKEN_MISSING', 'DISCORD_UNAUTHORIZED',
];

export class ScraperOrchestrator {
  /**
   * @param {{
   *   Account:    import('sequelize').ModelStatic,
   *   Post:       import('sequelize').ModelStatic,
   *   Signal:     import('sequelize').ModelStatic,
   *   ScraperRun: import('sequelize').ModelStatic,
   * }} models
   * @param {{
   *   credentials?:     Credentials,
   *   browserFactory?:  () => Browser,
   *   telegramFactory?: (config: object) => { connect(): Promise<unknown>, disconnect(): Promise<void>, scrapeAccount: Function },
   *   collectors?:      typeof COLLECTORS,
   *   pause?:           (ms: number) => Promise<void>,
   *   accountsConfigPath?: string,
   *   lockPath?:        string,
   *   onRunStarted?:    (run: object) => void|Promise<void>,
   * }} [deps] test seams; production uses the real implementations
   */
  constructor(models, deps = {}) {
    this.deps           = deps;
    this.collectors     = deps.collectors ?? COLLECTORS;
    this.accountRepo    = deps.accountsConfigPath
      ? new AccountRepository(models.Account, deps.accountsConfigPath)
      : new AccountRepository(models.Account);
    this.postRepo       = new PostRepository(models.Post);
    this.signalRepo     = new SignalRepository(models.Signal);
    this.scraperRunRepo = new ScraperRunRepository(models.ScraperRun);
    // Created lazily: selection is validated before any database access.
    const sequelize     = models.Post?.sequelize;
    this.stateRepo      = sequelize ? new SourceStateRepository(sequelize) : null;
    this.linkedinImports = sequelize ? new LinkedinImportRepository(sequelize) : null;
    this.db             = sequelize ? sequelizeExecutor(sequelize) : null;
    this.channelStats   = this.db ? new ChannelStatsRepository(this.db) : null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute a full scrape run, optionally filtered to one platform.
   *
   * @param {{ platform?: string, account?: string, accounts?: string[] }} [opts]
   * @param {{ signal?: AbortSignal }} [control] aborting stops after the current
   *   account: sessions are saved, the run is finalized and the lock released.
   */
  async run(opts = {}, { signal } = {}) {
    const { platform, accounts: targets } = normalizeSelection(opts);
    this.#signal = signal ?? null;
    const release = await (this.deps.lockPath ? acquireScrapeLock(this.deps.lockPath) : acquireScrapeLock());
    let scraperRun;
    try {
      // Holding the lock means no other collection is running.
      await this.scraperRunRepo.failOrphans();
      scraperRun = await this.scraperRunRepo.start();
      await this.deps.onRunStarted?.(scraperRun.toJSON());
      this.#credentials = this.deps.credentials ?? await Credentials.open();
      await this.#runAccounts(scraperRun, { platform, targets });
      // A full run also reads every persona's sources (new links → signals).
      if (!platform && !targets && !this.#signal?.aborted) await this.#collectSources();
      // Newly collected posts may be drafts the author published: link them
      // so the AI sees how each draft performed.
      try {
        const linked = this.db ? await linkPublishedDrafts(this.db) : 0;
        if (linked) print(`Linked ${linked} published draft(s) to collected posts.`, 'system');
      } catch (error) {
        print(`Could not link drafts to posts: ${error.message}`, 'warning');
      }
      await scraperRun.reload();
      await this.#alertProblems();
      return scraperRun.toJSON();
    } catch (error) {
      if (scraperRun) {
        await this.scraperRunRepo.fail(scraperRun, error);
        await this.#alertProblems();
      }
      throw error;
    } finally {
      await release();
    }
  }

  /** Persona sources; their failures are reported per source and never fail the run. */
  async #collectSources() {
    if (!this.db || this.deps.sources === false) return;
    try {
      const rows = await this.db.all("SELECT value FROM user_context WHERE key LIKE 'persona.%' ORDER BY key");
      const personas = rows.map(row => JSON.parse(row.value)).filter(persona => persona.sources?.length);
      if (!personas.length) return;
      let githubToken = '';
      try { githubToken = this.#credentials?.githubToken() ?? ''; } catch { /* anonymous GitHub search still works */ }
      const collector = this.deps.sourceCollector ?? new SourceCollector(this.db, { githubToken });
      const summary = await collector.collect(personas);
      print(`Sources: ${summary.found} link(s) read, ${summary.saved} new signal(s)` +
        (summary.failed ? `, ${summary.failed} source(s) failed` : '') + '.', 'data');
      for (const group of summary.personas) {
        for (const source of group.sources.filter(entry => entry.error)) {
          print(`  → ${group.persona} ${source.key}: ${source.error}`, 'warning');
        }
      }
    } catch (error) {
      print(`Sources not collected: ${error.message}`, 'warning');
    }
  }

  /** Problem alerts never affect the run's own result. */
  async #alertProblems() {
    if (!this.db || this.deps.notify === false) return;
    try {
      const check = this.deps.notify ?? runProblemChecks;
      const { configured, result, setupProblems } = await check({
        db: this.db, credentials: this.#credentials,
        ...(this.deps.accountsConfigPath ? { accountsConfigPath: this.deps.accountsConfigPath } : {}),
      });
      if (!configured) return;
      for (const message of [...(setupProblems ?? []), ...(result?.failed ?? [])]) print(`Alert delivery: ${message}`, 'warning');
      if (result?.sent) print(`Problem alert sent via ${result.delivered.join(', ')}.`, 'system');
    } catch (error) {
      print(`Problem alerts failed: ${error.message}`, 'warning');
    }
  }

  async #runAccounts(scraperRun, { platform, targets }) {

    const entries = await this.accountRepo.syncFromConfig();
    this.#config = new Map(entries.map(entry => [accountKey(entry), entry]));
    const allActive = await this.accountRepo.findAllActive();

    const accounts = allActive.filter(a =>
      (!platform || a.platform === platform) && (!targets || targets.includes(accountKey(a))));

    // Fail before collecting anything, so a typo does not cost a long run.
    const missing = (targets ?? []).filter(key => !accounts.some(a => accountKey(a) === key));
    if (missing.length) {
      throw new Error(`No active configured account: ${missing.join(', ')}`);
    }

    if (!accounts.length) {
      const reason = platform
        ? `No active accounts for platform "${platform}".`
        : 'No active accounts found — nothing to scrape.';
      print(reason, 'warning');
      await this.scraperRunRepo.finish(scraperRun, { accountsProcessed: 0, postsSaved: 0 });
      return;
    }

    print(
      `Starting scrape for ${accounts.length} account(s)` +
      (platform ? ` [platform: ${platform}]` : '') +
      (this.#credentials.encrypted ? ' · encrypted vault' : ' · legacy .env credentials') + '.',
      'info',
    );

    const totals = { posts: 0, signals: 0 };
    let accountsDone = 0;
    const failed     = [];

    this.#activeBrowser = null;
    this.#activeTwitterSession = null;
    this.#telegramScrapers = new Map();

    const queue = orderForCollection(accounts, account => this.#sessionOf(account));
    let stopped = 0;
    // A rejected login skips only the accounts that use it.
    const sessionErrors = new Map();
    let twitterStarted = false;

    try {
      for (let i = 0; i < queue.length; i++) {
        if (this.#signal?.aborted) {
          stopped = queue.length - i;
          print(`Stop requested: ${stopped} account(s) left for the next run.`, 'warning');
          break;
        }
        const account = queue[i];
        const session = this.#sessionOf(account);
        const sessionKey = `${account.platform}:${session}`;
        const startedAt = new Date();
        const usesSession = Boolean(platformInfo(account.platform).session);

        print(
          `[${i + 1}/${queue.length}] @${account.username} (${account.platform}` +
          (usesSession && session !== 'default' ? `, session ${session})` : ')'),
          'info',
        );

        if (sessionErrors.has(sessionKey)) {
          const reason = `skipped: ${sessionErrors.get(sessionKey)}`;
          print(`@${account.username} (${account.platform}) ${reason}`, 'warning');
          failed.push(`@${account.username} (${account.platform}) ${reason}`);
          await this.#recordFailure(scraperRun, account, { status: 'skipped', error: reason, startedAt, session });
          continue;
        }

        // Human-like pacing applies only between X profile visits.
        if (account.platform === 'twitter') {
          if (!twitterStarted) await this.#wakeUpPause();
          else if (this.#activeTwitterSession?.name === session) await this.#humanPause();
          else await this.#sessionSwitchPause();
          twitterStarted = true;
          if (this.#signal?.aborted) {   // the pause was cut short by a stop request
            stopped = queue.length - i;
            print(`Stop requested: ${stopped} account(s) left for the next run.`, 'warning');
            break;
          }
        }

        try {
          const outcome = await this.#scrapeAccount(account, session);
          totals[outcome.output] += outcome.saved;
          accountsDone += 1;
          await this.scraperRunRepo.recordAccount(scraperRun, account, {
            status: outcome.warning ? 'partial' : 'success', found: outcome.found, saved: outcome.saved, startedAt,
            error: outcome.warning ?? null, session: usesSession ? session : null,
          });
        } catch (err) {
          const msg = `@${account.username} (${account.platform}) failed: ${err.message}`;
          print(msg, 'error');
          failed.push(msg);
          if (SESSION_ERRORS.includes(err.code)) sessionErrors.set(sessionKey, err.message);
          await this.#recordFailure(scraperRun, account, {
            status: 'failed', error: err.message, startedAt, session: usesSession ? session : null,
          });
        }
      }
    } finally {
      await this.#closeClients();
    }

    const stats = { accountsProcessed: accountsDone, postsSaved: totals.posts, signalsSaved: totals.signals };
    if (stopped) failed.push(`Stopped on request: ${stopped} account(s) not collected in this run`);
    if (failed.length === 0) {
      await this.scraperRunRepo.finish(scraperRun, stats);
    } else if (accountsDone > 0) {
      await this.scraperRunRepo.partialFinish(scraperRun, { ...stats, errorMessage: failed.join(' | ') });
    } else if (stopped && failed.length === 1) {
      await this.scraperRunRepo.fail(scraperRun, 'Stopped on request before any account was collected.');
    } else {
      await this.scraperRunRepo.fail(scraperRun, `All accounts failed: ${failed.join(' | ')}`);
    }
  }

  /**
   * Collect one account through its platform adapter and persist the result.
   * @returns {Promise<{ output: 'posts'|'signals', found: number, saved: number }>}
   */
  async #scrapeAccount(account, session) {
    const info = platformInfo(account.platform);
    const collector = this.collectors[account.platform];
    const { records, scrapedAt, warning, keepWatermark, onSaved } = await collector.collect({
      account,
      entry: this.#config.get(accountKey(account)),
      session,
      runtime: this.#runtime,
      repos: {
        postRepo: this.postRepo, signalRepo: this.signalRepo, stateRepo: this.stateRepo,
        linkedinImports: this.linkedinImports, channelStats: this.channelStats,
      },
    });
    // Drop malformed records instead of failing the whole account's batch.
    const { valid, rejected } = info.output === 'signals'
      ? validateSignals(records)
      : validatePosts(records, account.platform);
    const repo  = info.output === 'signals' ? this.signalRepo : this.postRepo;
    const saved = await repo.saveBatch(account.id, valid);
    await onSaved?.(saved);
    // Nothing was read (e.g. no export file): keep the freshness watermark.
    if (keepWatermark) await this.accountRepo.markAttempted(account.id);
    else await this.accountRepo.markScraped(account.id, scrapedAt ?? new Date());
    print(`  → ${records.length} ${info.output} collected, ${saved} new saved.`, 'data');
    const warnings = [warning, describeRejected(rejected)].filter(Boolean);
    for (const message of warnings) print(`  → ${message}`, 'warning');
    return { output: info.output, found: records.length, saved, warning: warnings.join(' | ') || undefined };
  }

  async #recordFailure(scraperRun, account, outcome) {
    // Bookkeeping must never hide the original error or stop the run.
    try {
      await this.accountRepo.markFailed(account.id, outcome.error);
      await this.scraperRunRepo.recordAccount(scraperRun, account, outcome);
    } catch (error) {
      print(`Could not record the outcome for @${account.username}: ${error.message}`, 'warning');
    }
  }

  // ── Runtime clients ───────────────────────────────────────────────────────

  #credentials = null;
  #config = new Map();
  #activeBrowser = null;
  #activeTwitterSession = null;
  #telegramScrapers = new Map();

  /** What collectors may use; owned and closed by the orchestrator. */
  get #runtime() {
    return {
      credentials:     this.#credentials,
      twitterSession:  name => this.#ensureTwitterSession(name),
      telegramScraper: name => this.#ensureTelegramScraper(name),
    };
  }

  #sessionOf(account) {
    return sessionOf(this.#config.get(accountKey(account)));
  }

  async #ensureBrowser() {
    if (!this.#activeBrowser) {
      this.#activeBrowser = this.deps.browserFactory ? this.deps.browserFactory() : new Browser();
      await this.#activeBrowser.launch();
    }
    return this.#activeBrowser;
  }

  /** One X login at a time: switching sessions saves and closes the previous one. */
  async #ensureTwitterSession(name) {
    if (this.#activeTwitterSession?.name === name) return this.#activeTwitterSession;
    await this.#closeTwitterSession();
    const state = await this.#credentials.twitterState(name);
    const browser = await this.#ensureBrowser();
    this.#activeTwitterSession = await browser.openSession(name, state);
    return this.#activeTwitterSession;
  }

  async #closeTwitterSession() {
    const session = this.#activeTwitterSession;
    if (!session) return;
    this.#activeTwitterSession = null;
    try {
      if (await session.hasAuth()) {
        await this.#credentials.saveTwitterState(session.name, await session.storageState());
        print(`X session "${session.name}" saved${this.#credentials.encrypted ? ' (encrypted)' : ''}.`, 'system');
      } else {
        print(`X session "${session.name}" lost auth_token; the stored login was kept unchanged.`, 'warning');
      }
    } catch (error) {
      print(`Could not save X session "${session.name}": ${error.message}`, 'warning');
    } finally {
      await session.close().catch(() => {});
    }
  }

  async #ensureTelegramScraper(session) {
    let scraper = this.#telegramScrapers.get(session);
    if (!scraper) {
      const config = this.#credentials.telegramConfig(session);
      scraper = this.deps.telegramFactory
        ? this.deps.telegramFactory(config)
        : createTelegramScraper({ client: new TelegramClient(config), config });
      this.#telegramScrapers.set(session, scraper);
      try {
        await scraper.connect();
      } catch (error) {
        error.code ??= 'TELEGRAM_SESSION_FAILED';
        throw error;
      }
    }
    return scraper;
  }

  async #closeClients() {
    try {
      await this.#closeTwitterSession();
    } finally {
      try {
        if (this.#activeBrowser) await this.#activeBrowser.close();
      } finally {
        this.#activeBrowser = null;
        const scrapers = [...this.#telegramScrapers.values()];
        this.#telegramScrapers = new Map();
        await Promise.allSettled(scrapers.map(scraper => scraper.disconnect()));
      }
    }
  }

  // ── Pacing ────────────────────────────────────────────────────────────────

  async #wakeUpPause() {
    const wakeUpMs = Math.floor(Math.random() * SCRAPER.wakeUpMaxMs);
    if (wakeUpMs > 0) {
      print(`Wake-up pause: ${Math.round(wakeUpMs / 1_000)}s…`, 'system');
      await this.#sleep(wakeUpMs);
    }
  }

  async #humanPause() {
    const delayMs = randomBetween(SCRAPER.minDelayBetweenAccountsMs, SCRAPER.maxDelayBetweenAccountsMs);
    print(`Waiting ${(delayMs / 60_000).toFixed(1)} min before next account…`, 'system');
    await this.#sleep(delayMs);
  }

  async #sessionSwitchPause() {
    const delayMs = randomBetween(SCRAPER.minDelayBetweenSessionsMs, SCRAPER.maxDelayBetweenSessionsMs);
    print(`Switching X session; waiting ${Math.round(delayMs / 1_000)}s…`, 'system');
    await this.#sleep(delayMs);
  }

  #signal = null;

  #sleep(ms) {
    if (this.deps.pause) return this.deps.pause(ms, this.#signal);
    return this.#signal ? abortableSleep(ms, this.#signal) : sleep(ms);
  }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (Math.max(min, max) - min + 1)) + min;
}

/**
 * Fast platforms run first, then X profiles grouped by login session. Sessions
 * and the profiles inside them start from the least recently collected, so an
 * interrupted multi-profile run resumes with the profiles it missed.
 */
export function orderForCollection(accounts, sessionFor = () => 'default') {
  const scrapedAt = account => account.last_scraped_at ? new Date(account.last_scraped_at).getTime() : 0;
  const twitter = accounts.filter(a => a.platform === 'twitter')
    .sort((a, b) => scrapedAt(a) - scrapedAt(b) || a.username.localeCompare(b.username));
  const groups = new Map();
  for (const account of twitter) {
    const session = sessionFor(account);
    if (!groups.has(session)) groups.set(session, []);
    groups.get(session).push(account);
  }
  return [...accounts.filter(a => a.platform !== 'twitter'), ...[...groups.values()].flat()];
}

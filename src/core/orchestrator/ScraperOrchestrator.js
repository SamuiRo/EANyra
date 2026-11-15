/**
 * src/core/orchestrator/ScraperOrchestrator.js
 *
 * Coordinates a complete scrape run across all active platforms
 * (or a single platform when called from `eanyra scrape <platform>`).
 *
 * Flow:
 *   1. Open a ScraperRun record (status: running)
 *   2. Sync accounts.json → DB
 *   3. Filter accounts by platform (if provided)
 *   4. Dispatch each account to the correct platform scraper:
 *        twitter  → Browser + TwitterScraper (Playwright, human-behaviour delays)
 *        github   → GithubScraper (REST API, no browser)  → signals table
 *        linkedin → LinkedinImporter (CSV import)         → posts table
 *        telegram → TelegramScraper (MTProto polling)     → posts table
 *   5. Close runtime clients; refreshed X sessions are re-encrypted into the vault
 *   6. Finalise the ScraperRun record (success / partial / failed)
 *
 * Sessions:
 *   Every account names its login with "session" in accounts.json (default
 *   "default"). X profiles are grouped by session: the long human-like pause
 *   applies only between profiles of one login, and a rejected login stops
 *   only its own accounts. Telegram keeps one MTProto client per session and
 *   GitHub uses each session's token. Credentials come from the encrypted
 *   vault (core/secrets/Credentials.js).
 *
 * Adding a new platform:
 *   1. Create src/platforms/<n>/index.js with createScraper() + PLATFORM_ID
 *   2. Add a case in #scrapeAccount() below
 *   3. Add the platform string to SUPPORTED_PLATFORMS in app.config.js
 */

import { Browser }                                  from '../browser/Browser.js';
import {
  createScraper as createTwitterScraper,
  TWITTER_SESSION_EXPIRED,
} from '../../platforms/twitter/index.js';
import { createScraper as createGithubScraper }    from '../../platforms/github/index.js';
import { createScraper as createLinkedinImporter } from '../../platforms/linkedin/index.js';
import {
  createScraper as createTelegramScraper,
  TelegramClient,
} from '../../platforms/telegram/index.js';
import { AccountRepository }    from '../teapot/repositories/AccountRepository.js';
import { PostRepository }       from '../teapot/repositories/PostRepository.js';
import { SignalRepository }     from '../teapot/repositories/SignalRepository.js';
import { ScraperRunRepository } from '../teapot/repositories/ScraperRunRepository.js';
import { SCRAPER, LINKEDIN, TELEGRAM } from '../../config/app.config.js';
import { print, sleep }         from '../../shared/utils.js';
import { normalizeSelection, accountKey, sessionOf } from '../../config/accountConfig.js';
import { Credentials } from '../secrets/Credentials.js';
import { acquireScrapeLock } from './ScrapeLock.js';

/** Errors that mean a login itself is unusable, not just one profile. */
const SESSION_ERRORS = [
  TWITTER_SESSION_EXPIRED, 'TWITTER_SESSION_MISSING', 'TELEGRAM_SESSION_FAILED', 'GITHUB_TOKEN_MISSING',
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
   *   pause?:           (ms: number) => Promise<void>,
   *   accountsConfigPath?: string,
   *   lockPath?:        string,
   * }} [deps] test seams; production uses the real implementations
   */
  constructor(models, deps = {}) {
    this.deps           = deps;
    this.accountRepo    = deps.accountsConfigPath
      ? new AccountRepository(models.Account, deps.accountsConfigPath)
      : new AccountRepository(models.Account);
    this.postRepo       = new PostRepository(models.Post);
    this.signalRepo     = new SignalRepository(models.Signal);
    this.scraperRunRepo = new ScraperRunRepository(models.ScraperRun);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute a full scrape run, optionally filtered to one platform.
   *
   * @param {{ platform?: string, account?: string, accounts?: string[] }} [opts]
   */
  async run(opts = {}) {
    const { platform, accounts: targets } = normalizeSelection(opts);
    const release = await (this.deps.lockPath ? acquireScrapeLock(this.deps.lockPath) : acquireScrapeLock());
    let scraperRun;
    try {
      scraperRun = await this.scraperRunRepo.start();
      this.#credentials = this.deps.credentials ?? await Credentials.open();
      await this.#runAccounts(scraperRun, { platform, targets });
      return scraperRun.toJSON();
    } catch (error) {
      if (scraperRun) await this.scraperRunRepo.fail(scraperRun, error);
      throw error;
    } finally {
      await release();
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

    let totalSaved   = 0;
    let accountsDone = 0;
    const failed     = [];

    this.#activeBrowser = null;
    this.#activeTwitterSession = null;
    this.#telegramScrapers = new Map();

    const queue = orderForCollection(accounts, account => this.#sessionOf(account));
    // A rejected login skips only the accounts that use it.
    const sessionErrors = new Map();
    let twitterStarted = false;

    try {
      for (let i = 0; i < queue.length; i++) {
        const account = queue[i];
        const session = this.#sessionOf(account);
        const sessionKey = `${account.platform}:${session}`;

        print(
          `[${i + 1}/${queue.length}] @${account.username} (${account.platform}` +
          (session === 'default' ? ')' : `, session ${session})`),
          'info',
        );

        if (sessionErrors.has(sessionKey)) {
          const msg = `@${account.username} (${account.platform}) skipped: ${sessionErrors.get(sessionKey)}`;
          print(msg, 'warning');
          failed.push(msg);
          continue;
        }

        // Human-like pacing applies only between X profile visits.
        if (account.platform === 'twitter') {
          if (!twitterStarted) await this.#wakeUpPause();
          else if (this.#activeTwitterSession?.name === session) await this.#humanPause();
          else await this.#sessionSwitchPause();
          twitterStarted = true;
        }

        try {
          const saved = await this.#scrapeAccount(account);
          totalSaved   += saved;
          accountsDone += 1;
        } catch (err) {
          const msg = `@${account.username} (${account.platform}) failed: ${err.message}`;
          print(msg, 'error');
          failed.push(msg);
          if (SESSION_ERRORS.includes(err.code)) sessionErrors.set(sessionKey, err.message);
        }
      }
    } finally {
      await this.#closeClients();
    }

    if (failed.length === 0) {
      await this.scraperRunRepo.finish(scraperRun, {
        accountsProcessed: accountsDone,
        postsSaved:        totalSaved,
      });
    } else if (accountsDone > 0) {
      await this.scraperRunRepo.partialFinish(scraperRun, {
        accountsProcessed: accountsDone,
        postsSaved:        totalSaved,
        errorMessage:      failed.join(' | '),
      });
    } else {
      await this.scraperRunRepo.fail(scraperRun, `All accounts failed: ${failed.join(' | ')}`);
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #credentials = null;
  #config = new Map();
  #activeBrowser = null;
  #activeTwitterSession = null;
  #telegramScrapers = new Map();

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

  /**
   * Scrape a single account. Returns the number of newly saved records.
   *
   * @param {import('sequelize').Model} account
   * @returns {Promise<number>}
   */
  async #scrapeAccount(account) {
    switch (account.platform) {

      // ── Twitter → posts table ───────────────────────────────────────────
      case 'twitter': {
        const isInitial   = await this.#isInitialTwitterRun(account);
        const postsTarget = isInitial
          ? SCRAPER.initialPostsPerAccount
          : SCRAPER.postsPerAccount;

        print(
          `  → ${isInitial ? 'INITIAL harvest' : 'daily top-up'} (target: ${postsTarget} posts)`,
          'system',
        );

        const session = await this.#ensureTwitterSession(this.#sessionOf(account));
        const page    = await session.newPage();
        try {
          const scraper  = createTwitterScraper(page, postsTarget);
          const rawPosts = await scraper.scrapeAccount(account.username);
          const saved    = await this.postRepo.saveBatch(account.id, rawPosts);
          await this.accountRepo.markScraped(account.id);
          print(`  → ${rawPosts.length} scraped, ${saved} new saved.`, 'data');
          return saved;
        } finally {
          await page.close();
        }
      }

      // ── GitHub → signals table ──────────────────────────────────────────
      case 'github': {
        const session = this.#sessionOf(account);
        const token   = this.#credentials.githubToken(session);
        if (!token) {
          throw Object.assign(new Error(
            `No GitHub token for session "${session}". Run \`npm run nyra -- secrets set github ${session}\`.`,
          ), { code: 'GITHUB_TOKEN_MISSING' });
        }
        const readmeShas  = await this.signalRepo.getGithubReadmeShas(account.username);
        const scraper     = createGithubScraper(token, readmeShas);
        const rawSignals  = await scraper.scrapeAccount(account.username);
        const saved       = await this.signalRepo.saveBatch(account.id, rawSignals);
        await this.accountRepo.markScraped(account.id);
        print(`  → ${rawSignals.length} signals, ${saved} new saved.`, 'data');
        return saved;
      }

      // ── LinkedIn → posts table ──────────────────────────────────────────
      case 'linkedin': {
        const entry    = this.#config.get(accountKey(account));
        const importer = createLinkedinImporter(LINKEDIN.importsDir, {
          sharesFile: entry?.import_file ?? LINKEDIN.sharesFile,
        });
        const rawPosts = await importer.scrapeAccount(account.username);
        const saved    = await this.postRepo.saveBatch(account.id, rawPosts);
        await this.accountRepo.markScraped(account.id);
        print(`  → ${rawPosts.length} posts parsed, ${saved} new saved.`, 'data');
        return saved;
      }

      case 'telegram': {
        const scrapeStartedAt = new Date();
        const since           = account.last_scraped_at
          ?? await this.postRepo.newestPostDate(account.id, 'telegram');
        const isInitial       = since === null;

        print(
          `  -> ${isInitial ? `INITIAL harvest (target: ${TELEGRAM.initialPostsPerAccount} posts)` : 'daily top-up'} (polling mode)`,
          'system',
        );

        const scraper  = await this.#ensureTelegramScraper(this.#sessionOf(account));
        const rawPosts = await scraper.scrapeAccount(account.username, {
          since,
          initialLimit: TELEGRAM.initialPostsPerAccount,
        });
        const saved    = await this.postRepo.saveBatch(account.id, rawPosts);
        await this.accountRepo.markScraped(
          account.id,
          this.#telegramBaselineTimestamp(rawPosts, scrapeStartedAt, since),
        );
        print(`  -> ${rawPosts.length} messages parsed, ${saved} new saved.`, 'data');
        return saved;
      }

      default:
        throw new Error(`Unknown platform: "${account.platform}"`);
    }
  }

  async #isInitialTwitterRun(account) {
    if (!account.last_scraped_at) return true;
    const oldest = await this.postRepo.oldestPostDate(account.id, 'twitter');
    return oldest === null;
  }

  #telegramBaselineTimestamp(rawPosts, fallback, previousBoundary = null) {
    const latestPostAt = rawPosts.reduce((latest, post) => {
      if (!(post.posted_at instanceof Date)) return latest;
      return latest === null || post.posted_at > latest ? post.posted_at : latest;
    }, null);

    if (previousBoundary) {
      const previous = previousBoundary instanceof Date
        ? previousBoundary
        : new Date(previousBoundary);

      if (!Number.isNaN(previous.getTime())) {
        return latestPostAt && latestPostAt > previous ? latestPostAt : fallback;
      }
    }

    return latestPostAt ?? fallback;
  }

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

  #sleep(ms) {
    return (this.deps.pause ?? sleep)(ms);
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

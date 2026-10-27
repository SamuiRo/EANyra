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
 *   5. Close runtime clients (if opened)
 *   6. Finalise the ScraperRun record (success / partial / failed)
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
import { createScraper as createTelegramScraper }  from '../../platforms/telegram/index.js';
import { AccountRepository }    from '../teapot/repositories/AccountRepository.js';
import { PostRepository }       from '../teapot/repositories/PostRepository.js';
import { SignalRepository }     from '../teapot/repositories/SignalRepository.js';
import { ScraperRunRepository } from '../teapot/repositories/ScraperRunRepository.js';
import { SCRAPER, GITHUB, LINKEDIN, TELEGRAM } from '../../config/app.config.js';
import { print, sleep }         from '../../shared/utils.js';
import { normalizeSelection, accountKey } from '../../config/accountConfig.js';
import { acquireScrapeLock } from './ScrapeLock.js';

export class ScraperOrchestrator {
  /**
   * @param {{
   *   Account:    import('sequelize').ModelStatic,
   *   Post:       import('sequelize').ModelStatic,
   *   Signal:     import('sequelize').ModelStatic,
   *   ScraperRun: import('sequelize').ModelStatic,
   * }} models
   */
  constructor(models) {
    this.accountRepo    = new AccountRepository(models.Account);
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
    const release = await acquireScrapeLock();
    let scraperRun;
    try {
      scraperRun = await this.scraperRunRepo.start();
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

    await this.accountRepo.syncFromConfig();
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
      (platform ? ` [platform: ${platform}]` : '') + '.',
      'info',
    );

    let totalSaved   = 0;
    let accountsDone = 0;
    const failed     = [];

    this.#activeBrowser = null;
    this.#activeTelegramScraper = null;

    const queue = orderForCollection(accounts);
    // Set once X rejects the shared session; remaining X profiles are skipped.
    let twitterSessionError = null;
    let twitterStarted = false;

    try {
      for (let i = 0; i < queue.length; i++) {
        const account = queue[i];
        const isTwitter = account.platform === 'twitter';

        print(
          `[${i + 1}/${queue.length}] @${account.username} (${account.platform})`,
          'info',
        );

        if (isTwitter && twitterSessionError) {
          const msg = `@${account.username} (twitter) skipped: ${twitterSessionError}`;
          print(msg, 'warning');
          failed.push(msg);
          continue;
        }

        // Human-like pacing applies only between X profile visits.
        if (isTwitter) {
          if (twitterStarted) await this.#humanPause();
          else await this.#wakeUpPause();
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
          if (err.code === TWITTER_SESSION_EXPIRED) twitterSessionError = err.message;
        }
      }
    } finally {
      try {
        if (this.#activeBrowser) await this.#activeBrowser.close();
      } finally {
        if (this.#activeTelegramScraper) await this.#activeTelegramScraper.disconnect();
      }
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

  #activeBrowser = null;
  #activeTelegramScraper = null;

  async #ensureBrowser() {
    if (!this.#activeBrowser) {
      this.#activeBrowser = new Browser();
      await this.#activeBrowser.launch();
    }
    return this.#activeBrowser;
  }

  async #ensureTelegramScraper() {
    if (!this.#activeTelegramScraper) {
      this.#activeTelegramScraper = createTelegramScraper({ config: TELEGRAM });
      await this.#activeTelegramScraper.connect();
    }
    return this.#activeTelegramScraper;
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

        const browser = await this.#ensureBrowser();
        const page    = await browser.newPage();
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
        if (!GITHUB.token) {
          throw new Error(
            'GITHUB_TOKEN is not set. Add it to .env — see instance_example/.env.example for details.',
          );
        }
        const readmeShas  = await this.signalRepo.getGithubReadmeShas(account.username);
        const scraper     = createGithubScraper(GITHUB.token, readmeShas);
        const rawSignals  = await scraper.scrapeAccount(account.username);
        const saved       = await this.signalRepo.saveBatch(account.id, rawSignals);
        await this.accountRepo.markScraped(account.id);
        print(`  → ${rawSignals.length} signals, ${saved} new saved.`, 'data');
        return saved;
      }

      // ── LinkedIn → posts table ──────────────────────────────────────────
      case 'linkedin': {
        const importer = createLinkedinImporter(LINKEDIN.importsDir);
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

        const scraper  = await this.#ensureTelegramScraper();
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
      await sleep(wakeUpMs);
    }
  }

  async #humanPause() {
    const delayMs = Math.floor(
      Math.random() * (SCRAPER.maxDelayBetweenAccountsMs - SCRAPER.minDelayBetweenAccountsMs + 1),
    ) + SCRAPER.minDelayBetweenAccountsMs;

    print(`Waiting ${(delayMs / 60_000).toFixed(1)} min before next account…`, 'system');
    await sleep(delayMs);
  }
}

/**
 * Fast platforms run first, then X profiles from the least recently collected,
 * so an interrupted multi-profile run resumes with the profiles it missed.
 */
export function orderForCollection(accounts) {
  const scrapedAt = account => account.last_scraped_at ? new Date(account.last_scraped_at).getTime() : 0;
  const twitter = accounts.filter(a => a.platform === 'twitter')
    .sort((a, b) => scrapedAt(a) - scrapedAt(b) || a.username.localeCompare(b.username));
  return [...accounts.filter(a => a.platform !== 'twitter'), ...twitter];
}

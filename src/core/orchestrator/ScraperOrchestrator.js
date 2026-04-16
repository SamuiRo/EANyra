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
 *   5. Close the browser (if opened)
 *   6. Finalise the ScraperRun record (success / partial / failed)
 *
 * Adding a new platform:
 *   1. Create src/platforms/<n>/index.js with createScraper() + PLATFORM_ID
 *   2. Add a case in #scrapeAccount() below
 *   3. Add the platform string to VALID_PLATFORMS in cli/index.js
 */

import { Browser }                                  from '../browser/Browser.js';
import { createScraper as createTwitterScraper }   from '../../platforms/twitter/index.js';
import { createScraper as createGithubScraper }    from '../../platforms/github/index.js';
import { createScraper as createLinkedinImporter } from '../../platforms/linkedin/index.js';
import { AccountRepository }    from '../teapot/repositories/AccountRepository.js';
import { PostRepository }       from '../teapot/repositories/PostRepository.js';
import { SignalRepository }     from '../teapot/repositories/SignalRepository.js';
import { ScraperRunRepository } from '../teapot/repositories/ScraperRunRepository.js';
import { SCRAPER, GITHUB, LINKEDIN } from '../../config/app.config.js';
import { print, sleep }         from '../../shared/utils.js';

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
   * @param {{ platform?: string }} [opts]
   */
  async run({ platform } = {}) {
    const scraperRun = await this.scraperRunRepo.start();

    await this.accountRepo.syncFromConfig();
    const allActive = await this.accountRepo.findAllActive();

    const accounts = platform
      ? allActive.filter(a => a.platform === platform)
      : allActive;

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

    try {
      const hasTwitter = accounts.some(a => a.platform === 'twitter');
      if (hasTwitter) {
        const wakeUpMs = Math.floor(Math.random() * 3 * 60 * 1_000);
        if (wakeUpMs > 0) {
          print(`Wake-up pause: ${Math.round(wakeUpMs / 1_000)}s…`, 'system');
          await sleep(wakeUpMs);
        }
      }

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];

        print(
          `[${i + 1}/${accounts.length}] @${account.username} (${account.platform})`,
          'info',
        );

        try {
          const saved = await this.#scrapeAccount(account);
          totalSaved   += saved;
          accountsDone += 1;
        } catch (err) {
          const msg = `@${account.username} (${account.platform}) failed: ${err.message}`;
          print(msg, 'error');
          failed.push(msg);
        }

        if (i < accounts.length - 1 && account.platform === 'twitter') {
          await this.#humanPause();
        }
      }
    } finally {
      if (this.#activeBrowser) await this.#activeBrowser.close();
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

  async #ensureBrowser() {
    if (!this.#activeBrowser) {
      this.#activeBrowser = new Browser();
      await this.#activeBrowser.launch();
    }
    return this.#activeBrowser;
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
            'GITHUB_TOKEN is not set. Add it to .env — see .env.example for details.',
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

      default:
        throw new Error(`Unknown platform: "${account.platform}"`);
    }
  }

  async #isInitialTwitterRun(account) {
    if (!account.last_scraped_at) return true;
    const oldest = await this.postRepo.oldestPostDate(account.id, 'twitter');
    return oldest === null;
  }

  async #humanPause() {
    const delayMs = Math.floor(
      Math.random() * (SCRAPER.maxDelayBetweenAccountsMs - SCRAPER.minDelayBetweenAccountsMs + 1),
    ) + SCRAPER.minDelayBetweenAccountsMs;

    print(`Waiting ${(delayMs / 60_000).toFixed(1)} min before next account…`, 'system');
    await sleep(delayMs);
  }
}
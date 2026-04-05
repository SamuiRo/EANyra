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
 *   4. Run the appropriate scraper per platform:
 *        twitter → Browser + TwitterScraper (Playwright, human-behaviour delays)
 *        github  → GithubScraper (REST API, no browser, no delays needed)
 *   5. Close the browser (if opened)
 *   6. Finalise the ScraperRun record (success / partial / failed)
 *
 * Adding a new platform:
 *   1. Create src/platforms/<name>/index.js with createScraper() + PLATFORM_ID
 *   2. Add a case in #scrapeAccount() below
 *   3. Register the platform string in VALID_PLATFORMS in cli/index.js
 */

import { Browser }                   from '../browser/Browser.js';
import { TwitterScraper }            from '../../platforms/twitter/TwitterScraper.js';
import { createScraper as createGithubScraper } from '../../platforms/github/index.js';
import { AccountRepository }         from '../teapot/repositories/AccountRepository.js';
import { PostRepository }            from '../teapot/repositories/PostRepository.js';
import { GithubEventRepository }     from '../teapot/repositories/GithubEventRepository.js';
import { ScraperRunRepository }      from '../teapot/repositories/ScraperRunRepository.js';
import { SCRAPER, GITHUB }           from '../../config/app.config.js';
import { print, sleep }              from '../../shared/utils.js';

export class ScraperOrchestrator {
  /**
   * @param {{
   *   Account:     import('sequelize').ModelStatic,
   *   Post:        import('sequelize').ModelStatic,
   *   ScraperRun:  import('sequelize').ModelStatic,
   *   GithubEvent: import('sequelize').ModelStatic,
   * }} models
   */
  constructor(models) {
    this.accountRepo     = new AccountRepository(models.Account);
    this.postRepo        = new PostRepository(models.Post);
    this.githubEventRepo = new GithubEventRepository(models.GithubEvent);
    this.scraperRunRepo  = new ScraperRunRepository(models.ScraperRun);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute a full scrape run, optionally filtered to one platform.
   *
   * @param {{ platform?: string }} [opts]
   */
  async run({ platform } = {}) {
    // ── 1. Open run record ─────────────────────────────────────────────────
    const scraperRun = await this.scraperRunRepo.start();

    // ── 2. Sync accounts config → DB ──────────────────────────────────────
    await this.accountRepo.syncFromConfig();
    const allActive = await this.accountRepo.findAllActive();

    // ── 3. Filter by platform ─────────────────────────────────────────────
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

    // ── 4. Scrape ──────────────────────────────────────────────────────────
    let totalSaved    = 0;
    let accountsDone  = 0;
    const failed      = [];

    // Browser is opened lazily — only when a twitter account is encountered.
    let browser = null;

    // GitHub scraper is stateful (carries readme shas) — one instance per run.
    // Initialised lazily per-user below.
    const githubToken = GITHUB.token;

    try {
      // Small random "wake-up" pause before the first twitter account (0–3 min).
      // Skip if this is a github-only run.
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
          const saved = await this.#scrapeAccount(account, { browser: () => this.#ensureBrowser(browser) });

          // Capture browser reference if it was opened inside #ensureBrowser
          if (!browser && account.platform === 'twitter') {
            browser = this.#activeBrowser;
          }

          totalSaved   += saved;
          accountsDone += 1;
        } catch (err) {
          const msg = `@${account.username} (${account.platform}) failed: ${err.message}`;
          print(msg, 'error');
          failed.push(msg);
        }

        // Inter-account delay only for twitter accounts (github has no rate pressure at daily cadence)
        if (i < accounts.length - 1 && account.platform === 'twitter') {
          await this.#humanPause();
        }
      }
    } finally {
      if (browser) await browser.close();
    }

    // ── 5. Finalise run ────────────────────────────────────────────────────
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

  /** Holds the active Browser instance so we can reuse it across twitter accounts. */
  #activeBrowser = null;

  /**
   * Lazily launch the Playwright browser and cache it.
   * @returns {Promise<Browser>}
   */
  async #ensureBrowser() {
    if (!this.#activeBrowser) {
      this.#activeBrowser = new Browser();
      await this.#activeBrowser.launch();
    }
    return this.#activeBrowser;
  }

  /**
   * Scrape a single account using the correct platform scraper.
   * Returns the number of newly saved records.
   *
   * @param {import('sequelize').Model} account
   * @returns {Promise<number>}
   */
  async #scrapeAccount(account) {
    switch (account.platform) {

      case 'twitter': {
        const isInitial   = await this.#isInitialRun(account);
        const postsTarget = isInitial ? SCRAPER.initialPostsPerAccount : SCRAPER.postsPerAccount;

        print(
          `  → twitter ${isInitial ? 'INITIAL harvest' : 'daily top-up'} (target: ${postsTarget})`,
          'system',
        );

        const browser  = await this.#ensureBrowser();
        const page     = await browser.newPage();
        try {
          const scraper  = new TwitterScraper(page, postsTarget);
          const rawPosts = await scraper.scrapeAccount(account.username);
          const saved    = await this.postRepo.saveBatch(account.id, rawPosts);
          await this.accountRepo.markScraped(account.id);
          print(`  → @${account.username}: ${rawPosts.length} scraped, ${saved} new.`, 'data');
          return saved;
        } finally {
          await page.close();
        }
      }

      case 'github': {
        if (!GITHUB.token) {
          throw new Error(
            'GITHUB_TOKEN is not set. Add it to .env — see .env.example for details.'
          );
        }

        // Load readme shas from last run so we can detect changes
        const readmeShas = await this.githubEventRepo.getReadmeShas(account.username);
        const scraper    = createGithubScraper(GITHUB.token, readmeShas);
        const rawEvents  = await scraper.scrapeAccount(account.username);
        const saved      = await this.githubEventRepo.saveBatch(account.id, rawEvents);
        await this.accountRepo.markScraped(account.id);
        print(`  → @${account.username}: ${rawEvents.length} events, ${saved} new.`, 'data');
        return saved;
      }

      default:
        throw new Error(`Unknown platform: "${account.platform}"`);
    }
  }

  /**
   * Twitter only: an account is "initial" if it has never been scraped
   * or all its posts were cleared from the DB.
   */
  async #isInitialRun(account) {
    if (!account.last_scraped_at) return true;
    const oldest = await this.postRepo.oldestPostDate(account.id);
    return oldest === null;
  }

  /**
   * Random pause between consecutive twitter accounts (5–15 min).
   */
  async #humanPause() {
    const delayMs = Math.floor(
      Math.random() * (SCRAPER.maxDelayBetweenAccountsMs - SCRAPER.minDelayBetweenAccountsMs + 1)
    ) + SCRAPER.minDelayBetweenAccountsMs;

    print(`Waiting ${(delayMs / 60_000).toFixed(1)} min before next account…`, 'system');
    await sleep(delayMs);
  }
}
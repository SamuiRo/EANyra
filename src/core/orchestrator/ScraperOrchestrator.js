/**
 * src/core/orchestrator/ScraperOrchestrator.js
 *
 * Coordinates a complete scrape run:
 *   1. Open a ScraperRun record (status: running)
 *   2. Sync accounts.json → DB
 *   3. For each active account (sequentially, with human-like delays):
 *        a. Determine scrape depth (initial harvest vs. daily top-up)
 *        b. Launch a fresh browser page
 *        c. Scrape posts
 *        d. Persist posts
 *        e. Update account.last_scraped_at
 *        f. Close the page
 *   4. Close the browser
 *   5. Finalise the ScraperRun record (success / partial / failed)
 *
 * Human-behaviour strategy
 * ─────────────────────────
 * Twitter/X watches for robotic request patterns (uniform timing, high RPS).
 * Because we only scrape once a day with a small account list, we can afford
 * generous, randomised pauses that make the session indistinguishable from
 * a person casually browsing several profiles.
 *
 *  • 5–15 minute random gap between consecutive accounts
 *  • Random extra delay before the first account (0–3 min "wake-up" pause)
 *  • Scroll delays jittered inside humanBehavior.js (humanScroll)
 *  • simulatePageLanding() called per account inside TwitterScraper
 *  • A single persistent browser context reuses the real cookie jar
 */

import { Browser }               from '../browser/Browser.js';
import { TwitterScraper }        from '../../platforms/twitter/TwitterScraper.js';
import { AccountRepository }     from '../teapot/repositories/AccountRepository.js';
import { PostRepository }        from '../teapot/repositories/PostRepository.js';
import { ScraperRunRepository }  from '../teapot/repositories/ScraperRunRepository.js';
import { SCRAPER }               from '../../config/app.config.js';
import { print, sleep }          from '../../shared/utils.js';

export class ScraperOrchestrator {
  /**
   * @param {{
   *   Account:    import('sequelize').ModelStatic,
   *   Post:       import('sequelize').ModelStatic,
   *   ScraperRun: import('sequelize').ModelStatic,
   * }} models
   */
  constructor(models) {
    this.accountRepo    = new AccountRepository(models.Account);
    this.postRepo       = new PostRepository(models.Post);
    this.scraperRunRepo = new ScraperRunRepository(models.ScraperRun);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute a full scrape run.
   * Safe to call from both daemon (scheduler tick) and CLI (scrape mode).
   */
  async run() {
    // ── 1. Open run record ─────────────────────────────────────────────────
    const scraperRun = await this.scraperRunRepo.start();

    // ── 2. Sync accounts config → DB ──────────────────────────────────────
    await this.accountRepo.syncFromConfig();
    const accounts = await this.accountRepo.findAllActive();

    if (!accounts.length) {
      print('No active accounts found — nothing to scrape.', 'warning');
      await this.scraperRunRepo.finish(scraperRun, {
        accountsProcessed: 0,
        postsSaved:        0,
      });
      return;
    }

    print(`Starting scrape for ${accounts.length} account(s).`, 'info');

    // ── 3. Launch browser (single persistent context for the whole run) ────
    const browser = new Browser();
    await browser.launch();

    // Tracking state
    let totalPostsSaved   = 0;
    let accountsProcessed = 0;
    const failedAccounts  = [];

    try {
      // Small random "wake-up" pause before the first account (0–3 min)
      const wakeUpMs = Math.floor(Math.random() * 3 * 60 * 1_000);
      if (wakeUpMs > 0) {
        print(
          `Wake-up pause: ${Math.round(wakeUpMs / 1_000)}s before first account…`,
          'system',
        );
        await sleep(wakeUpMs);
      }

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];

        // ── 3a. Determine scrape depth ───────────────────────────────────
        const isInitialRun = await this.#isInitialRun(account);
        const postsTarget  = isInitialRun
          ? SCRAPER.initialPostsPerAccount
          : SCRAPER.postsPerAccount;

        print(
          `[${i + 1}/${accounts.length}] @${account.username} — ` +
          `${isInitialRun ? 'INITIAL harvest' : 'daily top-up'} (target: ${postsTarget} posts)`,
          'info',
        );

        // ── 3b–3e. Scrape + persist ──────────────────────────────────────
        const page = await browser.newPage();
        try {
          const scraper  = new TwitterScraper(page, postsTarget);
          const rawPosts = await scraper.scrapeAccount(account.username);

          const saved = await this.postRepo.saveBatch(account.id, rawPosts);
          await this.accountRepo.markScraped(account.id);

          totalPostsSaved   += saved;
          accountsProcessed += 1;

          print(
            `@${account.username}: scraped ${rawPosts.length} posts, ${saved} new saved.`,
            'data',
          );
        } catch (accountError) {
          // Log failure and continue — do NOT abort the whole run
          const msg = `@${account.username} failed: ${accountError.message}`;
          print(msg, 'error');
          failedAccounts.push(msg);
        } finally {
          await page.close();
        }

        // ── 3f. Inter-account human delay (skip after the last account) ──
        if (i < accounts.length - 1) {
          await this.#humanPause();
        }
      }
    } finally {
      // ── 4. Always close the browser ─────────────────────────────────────
      await browser.close();
    }

    // ── 5. Finalise the run record ─────────────────────────────────────────
    if (failedAccounts.length === 0) {
      await this.scraperRunRepo.finish(scraperRun, {
        accountsProcessed,
        postsSaved: totalPostsSaved,
      });
    } else if (accountsProcessed > 0) {
      await this.scraperRunRepo.partialFinish(scraperRun, {
        accountsProcessed,
        postsSaved:   totalPostsSaved,
        errorMessage: failedAccounts.join(' | '),
      });
    } else {
      await this.scraperRunRepo.fail(
        scraperRun,
        `All accounts failed: ${failedAccounts.join(' | ')}`,
      );
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * An account is considered "initial" if it has never been scraped
   * (no posts in the DB yet, or last_scraped_at is null).
   *
   * NOTE:
   * If last_scraped_at exists but all posts were removed from DB,
   * this still returns true and triggers an "initial" deep harvest.
   * This is intentional to allow automatic backfill after data loss/cleanup.
   *
   * @param {import('sequelize').Model} account
   * @returns {Promise<boolean>}
   */
  async #isInitialRun(account) {
    if (!account.last_scraped_at) return true;
    const oldest = await this.postRepo.oldestPostDate(account.id);
    return oldest === null;
  }

  /**
   * Random pause between accounts — mimics a human taking a break
   * between browsing different profiles.
   *
   * NOTE: jitter() from utils.js returns Promise<void>, not a number.
   * We compute the delay manually so we can log it before sleeping.
   */
  async #humanPause() {
    const delayMs = Math.floor(
      Math.random() * (SCRAPER.maxDelayBetweenAccountsMs - SCRAPER.minDelayBetweenAccountsMs + 1)
    ) + SCRAPER.minDelayBetweenAccountsMs;

    const minutes = (delayMs / 60_000).toFixed(1);
    print(`Waiting ${minutes} min before next account…`, 'system');
    await sleep(delayMs);
  }
}
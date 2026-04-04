/**
 * src/platforms/twitter/index.js
 *
 * Standard module interface for the Twitter/X platform.
 *
 * Every platform exposes the same shape so ScraperOrchestrator
 * can import any platform without knowing its internals:
 *
 *   import * as twitter from '../platforms/twitter/index.js';
 *   const scraper = twitter.createScraper(page, postsTarget);
 *   await scraper.scrapeAccount(username);
 *
 * What lives here:
 *   - createScraper()  — factory (no `new` keyword at call sites)
 *   - PLATFORM_ID      — stable string key used in CLI commands and DB records
 *   - displayName      — human-readable label for logs and help text
 *   - Re-exports of the types and classes that callers legitimately need
 *
 * What does NOT live here:
 *   - Browser / page management (handled by Browser.js + ScraperOrchestrator)
 *   - DB persistence (handled by PostRepository)
 *   - Scheduling (handled by Scheduler)
 */

import { TwitterScraper }    from './TwitterScraper.js';

export { TwitterScraper }    from './TwitterScraper.js';
export {
  humanScroll,
  humanMouseMove,
  mouseIdle,
  simulatePageLanding,
}                            from './humanBehavior.js';

// ─── Platform metadata ────────────────────────────────────────────────────────

/** Stable identifier used in CLI commands: `eanyra scrape twitter` */
export const PLATFORM_ID = 'twitter';

/** Human-readable label for logs and help output */
export const displayName = 'Twitter / X';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a TwitterScraper instance without exposing the class constructor
 * to call sites — keeps the API stable if the implementation changes.
 *
 * @param {import('playwright').Page} page
 * @param {number}                    [postsTarget]
 * @returns {TwitterScraper}
 */
export function createScraper(page, postsTarget) {
  return new TwitterScraper(page, postsTarget);
}
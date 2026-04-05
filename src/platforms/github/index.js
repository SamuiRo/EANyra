/**
 * src/platforms/github/index.js
 *
 * Standard module interface for the GitHub platform.
 * Mirrors the shape of src/platforms/twitter/index.js exactly so
 * ScraperOrchestrator can import any platform without knowing its internals:
 *
 *   import * as github from '../platforms/github/index.js';
 *   const scraper = github.createScraper(token, readmeShas);
 *   await scraper.scrapeAccount(username);
 */

import { GithubScraper } from './GithubScraper.js';

export { GithubScraper }            from './GithubScraper.js';
export { GithubClient,
         GithubRateLimitError,
         GithubNotFoundError }      from './client.js';

// ─── Platform metadata ────────────────────────────────────────────────────────

/** Stable identifier used in CLI commands: `eanyra scrape github` */
export const PLATFORM_ID = 'github';

/** Human-readable label for logs and help output */
export const displayName = 'GitHub';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a GithubScraper instance.
 *
 * @param {string}              token       GitHub Personal Access Token
 * @param {Record<string,string>} readmeShas  Map of "username/repo" → last known README sha
 *                                            Pass the value returned by GithubEventRepository.getReadmeShas()
 * @returns {GithubScraper}
 */
export function createScraper(token, readmeShas = {}) {
  return new GithubScraper(token, readmeShas);
}
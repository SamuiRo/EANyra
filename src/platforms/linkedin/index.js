/**
 * src/platforms/linkedin/index.js
 *
 * Standard module interface for the LinkedIn platform.
 * Mirrors src/platforms/twitter/index.js and src/platforms/github/index.js.
 *
 * Current implementation: CSV import from data/imports/
 * Future: could be extended with browser-based scraping or API calls
 * without changing this interface or anything in the orchestrator.
 *
 *   import * as linkedin from '../platforms/linkedin/index.js';
 *   const importer = linkedin.createScraper(importsDir);
 *   await importer.scrapeAccount(username);
 */

import { LinkedinImporter } from './LinkedinImporter.js';

export { LinkedinImporter } from './LinkedinImporter.js';
export { parseSharesFile,
         parseProfileFile,
         parseCsvString }   from './csvParser.js';

// ─── Platform metadata ────────────────────────────────────────────────────────

/** Stable identifier used in CLI commands: `eanyra scrape linkedin` */
export const PLATFORM_ID = 'linkedin';

/** Human-readable label for logs and help output */
export const displayName = 'LinkedIn';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a LinkedinImporter instance.
 *
 * @param {string} importsDir  Absolute path to the imports folder (data/imports/)
 * @returns {LinkedinImporter}
 */
export function createScraper(importsDir) {
  return new LinkedinImporter(importsDir);
}
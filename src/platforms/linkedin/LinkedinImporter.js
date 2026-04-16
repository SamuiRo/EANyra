/**
 * src/platforms/linkedin/LinkedinImporter.js
 *
 * Imports LinkedIn posts from CSV exports placed in data/imports/.
 * Returns RawPost[] compatible with the unified PostRepository.
 *
 * Expected files (all optional — missing files are skipped with a warning):
 *   data/imports/Shares.csv   — published posts
 *   data/imports/Profile.csv  — account profile metadata
 *
 * How to get these files:
 *   1. Go to linkedin.com → Me → Settings & Privacy → Data Privacy
 *   2. "Get a copy of your data" → select "Posts" (and optionally "Profile")
 *   3. LinkedIn emails a download link within ~10 minutes
 *   4. Unzip and place Shares.csv (and Profile.csv) into data/imports/
 *   5. Run: eanyra scrape linkedin
 */

import path from 'path';
import fs   from 'fs';
import { parseSharesFile, parseProfileFile } from './csvParser.js';
import { LINKEDIN }                          from '../../config/app.config.js';
import { print }                             from '../../shared/utils.js';

export class LinkedinImporter {
  /**
   * @param {string} importsDir  Absolute path to the imports folder (data/imports/)
   */
  constructor(importsDir) {
    this.importsDir = importsDir;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Import all LinkedIn CSVs for a given username.
   *
   * @param {string} username
   * @returns {Promise<import('../../core/teapot/repositories/PostRepository.js').RawPost[]>}
   */
  async scrapeAccount(username) {
    print(`[LinkedIn] Importing CSV data for @${username}`, 'info');

    const sharesPath  = path.join(this.importsDir, LINKEDIN.sharesFile);
    const profilePath = path.join(this.importsDir, LINKEDIN.profileFile);

    // ── Profile (optional, informational only) ────────────────────────────
    if (fs.existsSync(profilePath)) {
      try {
        const profile = parseProfileFile(profilePath);
        print(`[LinkedIn] Profile loaded: ${profile?.firstName} ${profile?.lastName}`, 'system');
      } catch (err) {
        print(`[LinkedIn] Failed to parse Profile.csv: ${err.message}`, 'warning');
      }
    } else {
      print(`[LinkedIn] Profile.csv not found at ${profilePath} — skipping.`, 'warning');
    }

    // ── Shares (posts) ────────────────────────────────────────────────────
    if (!fs.existsSync(sharesPath)) {
      print(`[LinkedIn] Shares.csv not found at ${sharesPath} — nothing to import.`, 'warning');
      return [];
    }

    let shares;
    try {
      shares = parseSharesFile(sharesPath);
    } catch (err) {
      print(`[LinkedIn] Failed to parse Shares.csv: ${err.message}`, 'error');
      return [];
    }

    if (!shares.length) {
      print(`[LinkedIn] Shares.csv is empty — nothing to import.`, 'warning');
      return [];
    }

    const posts = shares.map(share => this.#toRawPost(share));
    print(`[LinkedIn] @${username}: ${posts.length} post(s) parsed from CSV.`, 'data');
    return posts;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Convert a ParsedShare into a RawPost.
   *
   * @param {import('./csvParser.js').ParsedShare} share
   * @returns {import('../../core/teapot/repositories/PostRepository.js').RawPost}
   */
  #toRawPost(share) {
    return {
      platform:    'linkedin',
      platform_id: extractPostId(share.shareLink),
      text:        share.text        ?? '',
      lang:        null,
      posted_at:   share.date        ?? null,
      media_urls:  [],
      shared_url:  share.sharedUrl   ?? null,
      raw_url:     share.shareLink   ?? null,
      likes:       0,
      reposts:     0,
      replies:     0,
      views:       null,
      is_repost:   false,
      is_reply:    false,
      visibility:  share.visibility  ?? null,
      scraped_at:  new Date(),
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a stable post identifier from a LinkedIn share URL.
 *
 * Input:  "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7399399426819026944"
 * Output: "7399399426819026944"
 *
 * Falls back to the full decoded URN, then to the raw URL.
 *
 * @param {string|null} shareLink
 * @returns {string|null}
 */
function extractPostId(shareLink) {
  if (!shareLink) return null;
  try {
    const decoded = decodeURIComponent(shareLink);
    const match   = decoded.match(/urn:li:(?:share|ugcPost):(\d+)/);
    if (match) return match[1];
    const parts = decoded.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? shareLink;
  } catch {
    return shareLink;
  }
}
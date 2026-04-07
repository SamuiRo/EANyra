/**
 * src/platforms/linkedin/LinkedinImporter.js
 *
 * Imports LinkedIn activity from CSV exports placed in data/imports/.
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
 *
 * What this importer does NOT do:
 *   - Live scraping / browser automation
 *   - API calls (LinkedIn's API is heavily restricted)
 *   - De-duplicating against existing DB rows — that is handled by
 *     LinkedinPostRepository.saveBatch() via the unique post_id constraint
 *
 * Return shape:
 *   scrapeAccount() returns RawLinkedinPost[] — the same contract as
 *   other platform scrapers so ScraperOrchestrator can treat it uniformly.
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
   * The `username` param is the LinkedIn handle or any identifier stored
   * in accounts.json — it is attached to every returned record so the
   * orchestrator can save them against the correct account_id.
   *
   * @param {string} username
   * @returns {Promise<RawLinkedinPost[]>}
   */
  async scrapeAccount(username) {
    print(`[LinkedIn] Importing CSV data for @${username}`, 'info');

    const sharesPath  = path.join(this.importsDir, LINKEDIN.sharesFile);
    const profilePath = path.join(this.importsDir, LINKEDIN.profileFile);

    // ── Profile (optional) ────────────────────────────────────────────────
    let profile = null;
    if (fs.existsSync(profilePath)) {
      try {
        profile = parseProfileFile(profilePath);
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

    const posts = shares.map(share => this.#toRawPost(share, username));
    print(`[LinkedIn] @${username}: ${posts.length} post(s) parsed from CSV.`, 'data');
    return posts;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Convert a ParsedShare into a RawLinkedinPost.
   * The post_id is derived from the ShareLink URL — it contains the
   * URN which is LinkedIn's stable identifier for the post.
   *
   * @param {import('./csvParser.js').ParsedShare} share
   * @param {string} username
   * @returns {RawLinkedinPost}
   */
  #toRawPost(share, username) {
    const post_id = extractPostId(share.shareLink);

    return {
      post_id,
      username,
      text:       share.text,
      shared_url: share.sharedUrl,
      media_url:  share.mediaUrl,
      visibility: share.visibility,
      posted_at:  share.date,
      raw_url:    share.shareLink,
      scraped_at: new Date(),
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
 * Falls back to the full decoded URN if the numeric ID can't be extracted,
 * and to the raw URL if URL parsing fails entirely.
 *
 * @param {string|null} shareLink
 * @returns {string|null}
 */
function extractPostId(shareLink) {
  if (!shareLink) return null;
  try {
    const decoded = decodeURIComponent(shareLink);
    // URN format: urn:li:share:NUMERIC_ID  or  urn:li:ugcPost:NUMERIC_ID
    const match = decoded.match(/urn:li:(?:share|ugcPost):(\d+)/);
    if (match) return match[1];
    // Fallback: use the last path segment of the decoded URL
    const parts = decoded.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? shareLink;
  } catch {
    return shareLink;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RawLinkedinPost
 * @property {string|null} post_id     Numeric LinkedIn post ID extracted from URN
 * @property {string}      username    LinkedIn handle (from accounts.json)
 * @property {string}      text        Full post commentary
 * @property {string|null} shared_url  External URL shared in the post (if any)
 * @property {string|null} media_url   Attached media URL (if any)
 * @property {string|null} visibility  e.g. "MEMBER_NETWORK"
 * @property {Date|null}   posted_at   Publication timestamp
 * @property {string|null} raw_url     Direct URL to the post on LinkedIn
 * @property {Date}        scraped_at  When this record was captured
 */
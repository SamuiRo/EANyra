/**
 * src/platforms/linkedin/LinkedinImporter.js
 *
 * Imports LinkedIn posts from CSV exports placed in instance/data/imports/.
 * Returns RawPost[] compatible with the unified PostRepository.
 *
 * Expected files (all optional — missing files are skipped with a warning):
 *   instance/data/imports/Shares.csv   — published posts
 *   instance/data/imports/Profile.csv  — account profile metadata
 *
 * How to get these files:
 *   1. Go to linkedin.com → Me → Settings & Privacy → Data Privacy
 *   2. "Get a copy of your data" → select "Posts" (and optionally "Profile")
 *   3. LinkedIn emails a download link within ~10 minutes
 *   4. Unzip and place Shares.csv (and Profile.csv) into instance/data/imports/
 *   5. Run: eanyra scrape linkedin
 */

import path from 'path';
import fs   from 'fs';
import { createHash } from 'node:crypto';
import { parseSharesFile, parseProfileFile } from './csvParser.js';
import { LINKEDIN }                          from '../../config/app.config.js';
import { print }                             from '../../shared/utils.js';

export class LinkedinImporter {
  /**
   * @param {string} importsDir  Absolute path to the imports folder (instance/data/imports/)
   * @param {{ sharesFile?: string }} [opts] per-account export file name
   */
  constructor(importsDir, { sharesFile = LINKEDIN.sharesFile } = {}) {
    this.importsDir = importsDir;
    this.sharesFile = sharesFile;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Import all LinkedIn CSVs for a given username (no history, no checks).
   *
   * @param {string} username
   * @returns {Promise<import('../../core/teapot/repositories/PostRepository.js').RawPost[]>}
   */
  async scrapeAccount(username) {
    const result = await this.read(username);
    return result.posts;
  }

  /**
   * Read this account's export file.
   * @returns {Promise<{ file: { name: string, path: string, exists: boolean, sha256?: string, bytes?: number },
   *                     posts: object[] }>}
   * @throws when the file exists but cannot be parsed — never a silent empty import
   */
  async read(username) {
    print(`[LinkedIn] Importing CSV data for @${username}`, 'info');
    const file = { name: this.sharesFile, path: path.join(this.importsDir, this.sharesFile), exists: false };

    const profilePath = path.join(this.importsDir, LINKEDIN.profileFile);
    if (fs.existsSync(profilePath)) {
      try {
        const profile = parseProfileFile(profilePath);
        print(`[LinkedIn] Profile loaded: ${profile?.firstName} ${profile?.lastName}`, 'system');
      } catch (err) {
        print(`[LinkedIn] Failed to parse Profile.csv: ${err.message}`, 'warning');
      }
    }

    if (!fs.existsSync(file.path)) return { file, posts: [] };
    const data = fs.readFileSync(file.path);
    Object.assign(file, { exists: true, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    /** The file of the last read() — also when parsing it fails. */
    this.lastFile = file;

    let shares;
    try {
      shares = parseSharesFile(file.path);
    } catch (err) {
      throw new Error(`Cannot read ${file.name}: ${err.message}`, { cause: err });
    }
    if (shares.length && !shares.some(share => share.shareLink || share.text)) {
      throw new Error(`${file.name} has no ShareLink/ShareCommentary columns: is it the Shares.csv from the LinkedIn export?`);
    }

    const posts = shares.map(share => this.#toRawPost(share));
    print(`[LinkedIn] @${username}: ${posts.length} post(s) parsed from ${file.name}.`, 'data');
    return { file, posts };
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
      media_urls:  share.mediaUrl ? [share.mediaUrl] : [],
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
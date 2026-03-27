/**
 * src/teapot/repositories/PostRepository.js
 *
 * Handles all DB operations for the Post model.
 * The key guarantee: tweet_id is unique — duplicate posts are silently ignored
 * via upsert so re-running the scraper never pollutes the table.
 */

import { print } from '../../shared/utils.js';

export class PostRepository {
  /** @param {import('sequelize').ModelStatic} PostModel */
  constructor(PostModel) {
    this.Post = PostModel;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Persist an array of RawPost objects for a given account.
   * Uses upsert keyed on tweet_id to handle re-scrapes cleanly.
   * Metric columns (likes, retweets, etc.) are refreshed on conflict.
   *
   * @param {number}    accountId
   * @param {RawPost[]} rawPosts   Output from TwitterScraper.scrapeAccount()
   * @returns {Promise<number>}    Number of newly inserted rows
   */
  async saveBatch(accountId, rawPosts) {
    if (!rawPosts.length) return 0;

    let inserted = 0;

    for (const raw of rawPosts) {
      const [, created] = await this.Post.upsert({
        tweet_id:   raw.tweet_id,
        account_id: accountId,
        text:       raw.text,
        lang:       raw.lang,
        posted_at:  raw.posted_at,
        likes:      raw.likes,
        retweets:   raw.retweets,
        replies:    raw.replies,
        views:      raw.views,
        media_urls: JSON.stringify(raw.media_urls ?? []),
        is_retweet: raw.is_retweet,
        is_reply:   raw.is_reply,
        raw_url:    raw.raw_url,
        scraped_at: raw.scraped_at,
      });
      if (created) inserted++;
    }

    return inserted;
  }

  /**
   * Return the oldest posted_at date stored for a given account,
   * or null if the account has no posts yet (= first run).
   *
   * Used by the orchestrator to decide between initial harvest
   * (deep scroll) and daily top-up (shallow scroll).
   *
   * @param {number} accountId
   * @returns {Promise<Date|null>}
   */
  async oldestPostDate(accountId) {
    const row = await this.Post.findOne({
      where:    { account_id: accountId },
      order:    [['posted_at', 'ASC']],
      attributes: ['posted_at'],
    });
    return row ? row.posted_at : null;
  }
}
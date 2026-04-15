/**
 * src/core/teapot/repositories/PostRepository.js
 *
 * Handles all DB operations for the Post model.
 * Deduplication: tweet_id has a unique constraint.
 * On re-scrape, engagement metrics (likes, retweets, etc.) are refreshed
 * via updateOnDuplicate — only genuinely new rows increment the counter.
 */

export class PostRepository {
  /** @param {import('sequelize').ModelStatic} PostModel */
  constructor(PostModel) {
    this.Post = PostModel;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Persist an array of RawPost objects for a given account.
   * Uses bulkCreate with updateOnDuplicate to refresh engagement metrics
   * on re-scrape while counting only genuinely new inserts.
   *
   * @param {number}    accountId
   * @param {RawPost[]} rawPosts   Output from TwitterScraper.scrapeAccount()
   * @returns {Promise<number>}    Number of newly inserted rows
   */
  async saveBatch(accountId, rawPosts) {
    if (!rawPosts.length) return 0;

    const rows = rawPosts.map(raw => ({
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
    }));

    // SQLite doesn't support returning:true — count manually before/after.
    // updateOnDuplicate keeps engagement metrics fresh without creating duplicates.
    const before = await this.Post.count({ where: { account_id: accountId } });

    await this.Post.bulkCreate(rows, {
      updateOnDuplicate: ['likes', 'retweets', 'replies', 'views', 'scraped_at'],
    });

    const after = await this.Post.count({ where: { account_id: accountId } });
    return after - before;
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
      where:      { account_id: accountId },
      order:      [['posted_at', 'ASC']],
      attributes: ['posted_at'],
    });
    return row ? row.posted_at : null;
  }
}
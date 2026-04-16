/**
 * PostRepository — all DB operations for the unified `posts` table.
 *
 * One repository handles every platform (Twitter, LinkedIn, Telegram,
 * Bluesky, …). The platform field on each row tells them apart.
 *
 * saveBatch() is idempotent: (platform, platform_id) is a unique
 * constraint, so re-scraping or re-importing the same posts is safe.
 * Engagement metrics (likes, reposts, replies, views) are refreshed
 * on every scrape via updateOnDuplicate.
 */
export class PostRepository {
  /** @param {import('sequelize').ModelStatic} PostModel */
  constructor(PostModel) {
    this.Post = PostModel;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Bulk-insert posts for a given account.
   * Rows whose (platform, platform_id) already exist are updated
   * (engagement metrics only) instead of duplicated.
   *
   * @param {number}    accountId
   * @param {RawPost[]} rawPosts
   * @returns {Promise<number>} Number of newly inserted rows
   */
  async saveBatch(accountId, rawPosts) {
    if (!rawPosts.length) return 0;

    const rows = rawPosts.map(p => ({
      platform:         p.platform,
      platform_id:      p.platform_id,
      account_id:       accountId,
      text:             p.text       ?? '',
      lang:             p.lang       ?? null,
      posted_at:        p.posted_at  ?? null,
      media_urls:       JSON.stringify(p.media_urls ?? []),
      shared_url:       p.shared_url ?? null,
      raw_url:          p.raw_url    ?? null,
      likes:            p.likes      ?? 0,
      reposts:          p.reposts    ?? 0,
      replies:          p.replies    ?? 0,
      views:            p.views      ?? null,
      is_repost:        p.is_repost  ?? false,
      is_reply:         p.is_reply   ?? false,
      visibility:       p.visibility ?? null,
      scraped_at:       p.scraped_at ?? new Date(),
    }));

    // SQLite doesn't support RETURNING — count manually before/after
    const before = await this.Post.count({ where: { account_id: accountId } });

    await this.Post.bulkCreate(rows, {
      updateOnDuplicate: ['likes', 'reposts', 'replies', 'views', 'scraped_at'],
    });

    const after = await this.Post.count({ where: { account_id: accountId } });
    return after - before;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Oldest posted_at for an account+platform combo, or null if none.
   * Used by the Twitter orchestrator to choose initial vs top-up scrape.
   *
   * @param {number} accountId
   * @param {string} [platform]  If omitted, checks across all platforms
   * @returns {Promise<Date|null>}
   */
  async oldestPostDate(accountId, platform) {
    const where = { account_id: accountId };
    if (platform) where.platform = platform;

    const row = await this.Post.findOne({
      where,
      order:      [['posted_at', 'ASC']],
      attributes: ['posted_at'],
    });
    return row?.posted_at ?? null;
  }

  /**
   * Count all posts for an account (optionally filtered by platform).
   *
   * @param {number} accountId
   * @param {string} [platform]
   * @returns {Promise<number>}
   */
  async countForAccount(accountId, platform) {
    const where = { account_id: accountId };
    if (platform) where.platform = platform;
    return this.Post.count({ where });
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RawPost
 * @property {string}      platform      'twitter' | 'linkedin' | 'telegram' | 'bluesky' | ...
 * @property {string}      platform_id   Platform's own stable post ID
 * @property {string}      text
 * @property {string|null} lang
 * @property {Date|null}   posted_at
 * @property {string[]}    [media_urls]
 * @property {string|null} [shared_url]
 * @property {string|null} raw_url
 * @property {number}      [likes]
 * @property {number}      [reposts]
 * @property {number}      [replies]
 * @property {number|null} [views]
 * @property {boolean}     [is_repost]
 * @property {boolean}     [is_reply]
 * @property {string|null} [visibility]
 * @property {Date}        scraped_at
 */
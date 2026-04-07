/**
 * src/core/teapot/repositories/LinkedinPostRepository.js
 *
 * All DB operations for LinkedinPost records.
 * Mirrors the interface of PostRepository and GithubEventRepository
 * so the orchestrator can treat all platforms uniformly.
 *
 * saveBatch() uses ignoreDuplicates:true — the unique constraint on
 * post_id silently skips rows that were already imported in a previous run.
 */

export class LinkedinPostRepository {
    /**
     * @param {import('sequelize').ModelStatic} LinkedinPost
     */
    constructor(LinkedinPost) {
      this.model = LinkedinPost;
    }
  
    // ── Write ─────────────────────────────────────────────────────────────────
  
    /**
     * Bulk-insert raw posts. Silently skips existing post_ids.
     * Returns the count of newly inserted rows.
     *
     * @param {number} accountId
     * @param {import('../../platforms/linkedin/LinkedinImporter.js').RawLinkedinPost[]} rawPosts
     * @returns {Promise<number>}
     */
    async saveBatch(accountId, rawPosts) {
      if (!rawPosts.length) return 0;
  
      // Filter out posts with no extractable ID — shouldn't happen but be safe
      const valid = rawPosts.filter(p => p.post_id);
      if (!valid.length) return 0;
  
      const rows = valid.map(p => ({
        post_id:    p.post_id,
        account_id: accountId,
        username:   p.username,
        text:       p.text ?? '',
        shared_url: p.shared_url ?? null,
        media_url:  p.media_url  ?? null,
        visibility: p.visibility ?? null,
        posted_at:  p.posted_at  ?? null,
        raw_url:    p.raw_url    ?? null,
        scraped_at: p.scraped_at,
      }));
  
      // SQLite doesn't support returning:true — count manually
      const before = await this.model.count({ where: { account_id: accountId } });
      await this.model.bulkCreate(rows, { ignoreDuplicates: true });
      const after  = await this.model.count({ where: { account_id: accountId } });
  
      return after - before;
    }
  
    // ── Read ──────────────────────────────────────────────────────────────────
  
    /**
     * Most recent posted_at for an account, or null if no posts exist.
     *
     * @param {number} accountId
     * @returns {Promise<Date|null>}
     */
    async latestPostDate(accountId) {
      const row = await this.model.findOne({
        where:      { account_id: accountId },
        order:      [['posted_at', 'DESC']],
        attributes: ['posted_at'],
      });
      return row?.posted_at ?? null;
    }
  
    /**
     * Total post count for an account.
     *
     * @param {number} accountId
     * @returns {Promise<number>}
     */
    async countForAccount(accountId) {
      return this.model.count({ where: { account_id: accountId } });
    }
  }
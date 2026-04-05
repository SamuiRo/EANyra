/**
 * src/core/teapot/repositories/GithubEventRepository.js
 *
 * All DB operations for GithubEvent records.
 * Mirrors the interface of PostRepository so the orchestrator can treat
 * both platforms uniformly.
 *
 * saveBatch() uses INSERT OR IGNORE semantics via ignoreDuplicates:true —
 * the unique constraint on event_id prevents duplicates across runs.
 */

import { Op } from 'sequelize';
import { print } from '../../../shared/utils.js';

export class GithubEventRepository {
  /**
   * @param {import('sequelize').ModelStatic} GithubEvent
   */
  constructor(GithubEvent) {
    this.model = GithubEvent;
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Bulk-insert raw events. Silently skips existing event_ids.
   *
   * @param {number}             accountId
   * @param {import('../../platforms/github/GithubScraper.js').RawGithubEvent[]} rawEvents
   * @returns {Promise<number>}  Count of newly inserted rows
   */
  async saveBatch(accountId, rawEvents) {
    if (!rawEvents.length) return 0;

    const rows = rawEvents.map(e => ({
      event_id:    e.event_id,
      account_id:  accountId,
      username:    e.username,
      repo:        e.repo,
      event_type:  e.event_type,
      title:       e.title,
      body:        e.body ?? null,
      url:         e.url ?? null,
      occurred_at: e.occurred_at ?? null,
      metadata:    e.metadata ?? null,
      scraped_at:  e.scraped_at,
    }));

    // bulkCreate with ignoreDuplicates skips rows whose event_id already exists.
    // returning:true is not supported by SQLite, so we count manually.
    const before = await this.model.count({ where: { account_id: accountId } });

    await this.model.bulkCreate(rows, { ignoreDuplicates: true });

    const after = await this.model.count({ where: { account_id: accountId } });
    return after - before;
  }

  // ── README sha tracking ───────────────────────────────────────────────────

  /**
   * Return a map of "username/repo" → the most recently stored README sha.
   * Used by GithubScraper to detect README changes between runs.
   *
   * Only considers readme_change events — if a repo has never had a
   * readme_change event recorded, its key will not appear in the map
   * and GithubScraper will treat it as "first time seen" (no diff emitted).
   *
   * @param {string} username
   * @returns {Promise<Record<string, string>>}
   */
  async getReadmeShas(username) {
    // Get the latest readme_change event per repo for this user
    const events = await this.model.findAll({
      where: {
        username,
        event_type: 'readme_change',
      },
      order: [['occurred_at', 'DESC']],
    });

    /** @type {Record<string, string>} */
    const shas = {};

    for (const ev of events) {
      const key = `${ev.username}/${ev.repo}`;
      if (shas[key]) continue; // already have the latest (ORDER BY DESC)

      const meta = ev.metadata; // getter returns parsed object
      if (meta?.new_sha) {
        shas[key] = meta.new_sha;
      }
    }

    return shas;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Most recent scraped_at timestamp for an account, or null if none.
   * Mirrors PostRepository.oldestPostDate() for orchestrator compatibility.
   *
   * @param {number} accountId
   * @returns {Promise<Date|null>}
   */
  async latestEventDate(accountId) {
    const row = await this.model.findOne({
      where:  { account_id: accountId },
      order:  [['scraped_at', 'DESC']],
      attributes: ['scraped_at'],
    });
    return row?.scraped_at ?? null;
  }

  /**
   * Count events for an account within a date range.
   *
   * @param {number} accountId
   * @param {Date}   from
   * @param {Date}   to
   * @returns {Promise<number>}
   */
  async countInRange(accountId, from, to) {
    return this.model.count({
      where: {
        account_id:  accountId,
        occurred_at: { [Op.between]: [from, to] },
      },
    });
  }
}
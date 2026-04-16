/**
 * SignalRepository — all DB operations for the `signals` table.
 *
 * Handles every signal source: GitHub events, notes, articles,
 * tool reviews, and anything else that feeds into content creation.
 *
 * saveBatch() is idempotent: (source, source_id) is a unique constraint
 * so re-running a scraper or re-importing the same signals is safe.
 */

import { Op } from 'sequelize';

export class SignalRepository {
  /** @param {import('sequelize').ModelStatic} SignalModel */
  constructor(SignalModel) {
    this.Signal = SignalModel;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Bulk-insert signals. Silently skips rows whose (source, source_id)
   * already exist in the DB.
   *
   * @param {number|null}  accountId  NULL for manual/non-account signals
   * @param {RawSignal[]}  rawSignals
   * @returns {Promise<number>} Number of newly inserted rows
   */
  async saveBatch(accountId, rawSignals) {
    if (!rawSignals.length) return 0;

    const rows = rawSignals.map(s => ({
      source:      s.source,
      source_id:   s.source_id,
      signal_type: s.signal_type,
      account_id:  accountId,
      title:       s.title,
      body:        s.body        ?? null,
      url:         s.url         ?? null,
      occurred_at: s.occurred_at ?? null,
      metadata:    s.metadata != null ? JSON.stringify(s.metadata) : null,
      scraped_at:  s.scraped_at  ?? new Date(),
    }));

    const countWhere = accountId != null
      ? { account_id: accountId }
      : {};

    const before = await this.Signal.count({ where: countWhere });
    await this.Signal.bulkCreate(rows, { ignoreDuplicates: true });
    const after = await this.Signal.count({ where: countWhere });

    return after - before;
  }

  // ── GitHub-specific helpers ────────────────────────────────────────────────

  /**
   * Return a map of "username/repo" → most recent README sha.
   * Used by GithubScraper to detect README changes between runs.
   *
   * Only considers signals of type 'readme_change'.
   * If a repo has never had a readme_change signal, its key will not
   * appear in the map and GithubScraper treats it as "first time seen"
   * (no diff emitted on first scrape — avoids false positives).
   *
   * @param {string} username  GitHub login
   * @returns {Promise<Record<string, string>>}
   */
  async getGithubReadmeShas(username) {
    const signals = await this.Signal.findAll({
      where: {
        source:      'github',
        signal_type: 'readme_change',
        account_id: {
          [Op.in]: await this.#accountIdsByUsername(username),
        },
      },
      order: [['occurred_at', 'DESC']],
    });

    /** @type {Record<string, string>} */
    const shas = {};

    for (const s of signals) {
      const meta = s.metadata; // getter returns parsed object
      if (!meta?.repo) continue;
      const key = `${username}/${meta.repo}`;
      if (shas[key]) continue; // already have the latest (ORDER BY DESC)
      if (meta?.new_sha) shas[key] = meta.new_sha;
    }

    return shas;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Most recent scraped_at for an account's signals, or null if none.
   *
   * @param {number} accountId
   * @returns {Promise<Date|null>}
   */
  async latestSignalDate(accountId) {
    const row = await this.Signal.findOne({
      where:      { account_id: accountId },
      order:      [['scraped_at', 'DESC']],
      attributes: ['scraped_at'],
    });
    return row?.scraped_at ?? null;
  }

  /**
   * Count signals for an account within a date range.
   *
   * @param {number}  accountId
   * @param {Date}    from
   * @param {Date}    to
   * @returns {Promise<number>}
   */
  async countInRange(accountId, from, to) {
    return this.Signal.count({
      where: {
        account_id:  accountId,
        occurred_at: { [Op.between]: [from, to] },
      },
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Resolve a GitHub username to an array of account IDs.
   * Normally returns exactly one ID; returns [] if not found.
   *
   * @param {string} username
   * @returns {Promise<number[]>}
   */
  async #accountIdsByUsername(username) {
    // We access the Account model through the association
    const rows = await this.Signal.sequelize.models.Account.findAll({
      where:      { username, platform: 'github' },
      attributes: ['id'],
    });
    return rows.map(r => r.id);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RawSignal
 * @property {string}      source       'github' | 'note' | 'article' | 'tool_review' | ...
 * @property {string}      source_id    Stable unique key within the source
 * @property {string}      signal_type  Narrows within source (release, commit_batch, idea, ...)
 * @property {string}      title        Short headline
 * @property {string|null} [body]       Extended content
 * @property {string|null} [url]        Link to original
 * @property {Date|null}   [occurred_at]
 * @property {object|null} [metadata]   Source-specific extras (will be JSON-stringified)
 * @property {Date}        scraped_at
 */
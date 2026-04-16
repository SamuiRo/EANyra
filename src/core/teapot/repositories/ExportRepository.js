/**
 * src/core/teapot/repositories/ExportRepository.js
 *
 * Aggregates data from posts and signals tables for the `eanyra export` command.
 * Returns plain objects (not Sequelize instances) so the export formatter
 * has no ORM dependency.
 */

import { Op } from 'sequelize';

// Top-level context keys that live in user_context table.
// project.* keys are stored there too (for quick lookup) but we load
// projects via the Project model to get structured data — so we exclude
// them here to avoid double-loading.
const TOP_LEVEL_CONTEXT_KEYS = ['voice', 'bio', 'platforms'];

export class ExportRepository {
  /**
   * @param {{
   *   Post:        import('sequelize').ModelStatic,
   *   Signal:      import('sequelize').ModelStatic,
   *   Account:     import('sequelize').ModelStatic,
   *   UserContext: import('sequelize').ModelStatic,
   *   Project:     import('sequelize').ModelStatic,
   * }} models
   */
  constructor(models) {
    this.Post        = models.Post;
    this.Signal      = models.Signal;
    this.Account     = models.Account;
    this.UserContext = models.UserContext;
    this.Project     = models.Project;
  }

  // ── User context ──────────────────────────────────────────────────────────

  /**
   * Returns { voice, bio, platforms, projects[] } from the DB.
   *
   * Only reads top-level keys from user_context (voice, bio, platforms).
   * project.* keys are intentionally excluded here — projects come from
   * the Project model so we get proper structured objects with all fields.
   */
  async getContext() {
    const rows = await this.UserContext.findAll({
      where: { key: { [Op.in]: TOP_LEVEL_CONTEXT_KEYS } },
    });

    const ctx = {};
    for (const row of rows) {
      ctx[row.key] = row.value;
    }

    // Active projects — full structured objects
    const projects = await this.Project.findAll({
      where: { status: 'active' },
      order: [['slug', 'ASC']],
    });

    ctx.projects = projects.map(p => ({
      slug:           p.slug,
      name:           p.name,
      description:    p.description,
      tech_stack:     p.tech_stack,
      links:          p.links,
      content_angles: p.content_angles,
      posting_rules:  p.posting_rules,
    }));

    return ctx;
  }

  // ── Posts ─────────────────────────────────────────────────────────────────

  /**
   * Fetch posts for export, optionally filtered by platform.
   *
   * Selection strategy (matches PLAN.md §4.4):
   *   - Always include unused posts (used_for_content IS NULL)
   *   - Also include already-used posts that fall within the date window
   *     (gives the AI context about recent voice even if already exported)
   *   - Excludes reposts — original content only
   *   - `unusedOnly` flag restricts to strictly unused posts only
   *
   * @param {{ days?: number, unusedOnly?: boolean, platform?: string }} opts
   * @returns {Promise<object[]>}
   */
  async getPosts({ days = 7, unusedOnly = false, platform } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where  = { is_repost: false };

    if (platform) where.platform = platform;

    if (unusedOnly) {
      where.used_for_content = null;
    } else {
      // Unused always included; used only if within the time window
      where[Op.or] = [
        { used_for_content: null },
        { posted_at: { [Op.gte]: cutoff } },
      ];
    }

    const rows = await this.Post.findAll({
      where,
      order:   [['posted_at', 'DESC']],
      limit:   100,
      include: [{
        model:      this.Account,
        as:         'account',
        attributes: ['username', 'display_name'],
      }],
    });

    return rows.map(r => ({
      id:          r.id,
      platform:    r.platform,
      platform_id: r.platform_id,
      username:    r.account?.username ?? '?',
      text:        r.text,
      posted_at:   r.posted_at,
      likes:       r.likes,
      reposts:     r.reposts,
      replies:     r.replies,
      views:       r.views,
      is_reply:    r.is_reply,
      shared_url:  r.shared_url,
      raw_url:     r.raw_url,
      visibility:  r.visibility,
      used:        !!r.used_for_content,
    }));
  }

  // ── Signals ───────────────────────────────────────────────────────────────

  /**
   * Fetch signals for export.
   *
   * Selection strategy (mirrors getPosts logic, matches PLAN.md §4.4):
   *   - Always include unused signals (used_for_content IS NULL)
   *   - Also include already-used signals within the date window
   *   - `unusedOnly` flag restricts to strictly unused signals only
   *
   * Note: unlike posts, signals use `occurred_at` as the time anchor.
   * Signals where occurred_at is NULL are included when unused — they
   * should not be silently dropped just because the timestamp is missing.
   *
   * @param {{ days?: number, unusedOnly?: boolean, source?: string }} opts
   * @returns {Promise<object[]>}
   */
  async getSignals({ days = 7, unusedOnly = false, source } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where  = {};

    if (source) where.source = source;

    if (unusedOnly) {
      where.used_for_content = null;
    } else {
      // Unused always included (even if occurred_at is NULL);
      // used only if within the time window
      where[Op.or] = [
        { used_for_content: null },
        { occurred_at: { [Op.gte]: cutoff } },
      ];
    }

    const rows = await this.Signal.findAll({
      where,
      order:   [['occurred_at', 'DESC']],
      limit:   100,
      include: [{
        model:      this.Account,
        as:         'account',
        attributes: ['username', 'display_name'],
      }],
    });

    return rows.map(r => ({
      id:          r.id,
      source:      r.source,
      signal_type: r.signal_type,
      username:    r.account?.username ?? null,
      title:       r.title,
      body:        r.body,
      url:         r.url,
      occurred_at: r.occurred_at,
      metadata:    r.metadata,
      used:        !!r.used_for_content,
    }));
  }

  // ── Mark as used ──────────────────────────────────────────────────────────

  /**
   * Stamp used_for_content = now on the given post and signal IDs.
   * Called after the Markdown file is written successfully.
   *
   * Only stamps items that are not yet marked (used_for_content IS NULL)
   * so that the first-export timestamp is preserved on subsequent runs.
   *
   * @param {{ postIds?: number[], signalIds?: number[] }} ids
   */
  async markAsUsed({ postIds = [], signalIds = [] }) {
    const now = new Date();

    if (postIds.length) {
      await this.Post.update(
        { used_for_content: now },
        {
          where: {
            id:               { [Op.in]: postIds },
            used_for_content: null,   // preserve original export timestamp
          },
        },
      );
    }

    if (signalIds.length) {
      await this.Signal.update(
        { used_for_content: now },
        {
          where: {
            id:               { [Op.in]: signalIds },
            used_for_content: null,   // preserve original export timestamp
          },
        },
      );
    }
  }
}
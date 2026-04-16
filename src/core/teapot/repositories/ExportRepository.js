/**
 * src/core/teapot/repositories/ExportRepository.js
 *
 * Aggregates data from posts and signals tables for the `eanyra export` command.
 * Returns plain objects (not Sequelize instances) so the export formatter
 * has no ORM dependency.
 */

import { Op } from 'sequelize';

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
   */
  async getContext() {
    const rows = await this.UserContext.findAll();
    const ctx  = {};
    for (const row of rows) {
      ctx[row.key] = row.value;
    }

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
   * Selection: unused posts OR posts within the last N days —
   * whichever gives the most context for content creation.
   *
   * @param {{ days?: number, unusedOnly?: boolean, platform?: string }} opts
   * @returns {Promise<object[]>}
   */
  async getPosts({ days = 7, unusedOnly = false, platform } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where  = { is_repost: false };

    if (platform)    where.platform = platform;

    if (unusedOnly) {
      where.used_for_content = null;
    } else {
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
   * Fetch signals within the time window, optionally filtered by source.
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
      where.occurred_at = { [Op.gte]: cutoff };
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
   * Stamp used_for_content = now on all exported IDs.
   * Called after the Markdown file is written successfully.
   *
   * @param {{ postIds?: number[], signalIds?: number[] }} ids
   */
  async markAsUsed({ postIds = [], signalIds = [] }) {
    const now = new Date();

    if (postIds.length) {
      await this.Post.update(
        { used_for_content: now },
        { where: { id: { [Op.in]: postIds } } },
      );
    }

    if (signalIds.length) {
      await this.Signal.update(
        { used_for_content: now },
        { where: { id: { [Op.in]: signalIds } } },
      );
    }
  }
}
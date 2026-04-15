/**
 * src/core/teapot/repositories/ExportRepository.js
 *
 * Aggregates data from all tables for the `eanyra export` command.
 * Each method returns plain objects (not Sequelize instances) so the
 * export formatter has no ORM dependency.
 */

import { Op } from 'sequelize';

export class ExportRepository {
  /**
   * @param {{
   *   Post:         import('sequelize').ModelStatic,
   *   LinkedinPost: import('sequelize').ModelStatic,
   *   GithubEvent:  import('sequelize').ModelStatic,
   *   Account:      import('sequelize').ModelStatic,
   *   UserContext:  import('sequelize').ModelStatic,
   *   Project:      import('sequelize').ModelStatic,
   * }} models
   */
  constructor(models) {
    this.Post         = models.Post;
    this.LinkedinPost = models.LinkedinPost;
    this.GithubEvent  = models.GithubEvent;
    this.Account      = models.Account;
    this.UserContext  = models.UserContext;
    this.Project      = models.Project;
  }

  // ── User context ──────────────────────────────────────────────────────────

  /**
   * Returns { voice, bio, platforms, projects[] } from the DB.
   * Mirrors UserContextRepository.getAll() but returns plain objects.
   */
  async getContext() {
    const rows = await this.UserContext.findAll();
    const ctx  = {};
    for (const row of rows) {
      ctx[row.key] = row.value; // getter already JSON.parses
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

  // ── Twitter posts ─────────────────────────────────────────────────────────

  /**
   * Fetch Twitter posts for export.
   *
   * Selection priority (evaluated in order):
   *   1. unused = true  → posts not yet exported (used_for_content IS NULL)
   *   2. days window    → posted_at within the last N days
   *   Both filters are applied together with OR so you always get something useful.
   *
   * @param {{ days?: number, unusedOnly?: boolean, platform?: string }} opts
   * @returns {Promise<object[]>}
   */
  async getTwitterPosts({ days = 7, unusedOnly = false } = {}) {
    const cutoff  = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where   = { is_retweet: false };

    if (unusedOnly) {
      where.used_for_content = null;
    } else {
      // Show unused OR recent — whichever gives the most context
      where[Op.or] = [
        { used_for_content: null },
        { posted_at: { [Op.gte]: cutoff } },
      ];
    }

    const rows = await this.Post.findAll({
      where,
      order:      [['posted_at', 'DESC']],
      limit:      50,
      include: [{
        model:      this.Account,
        as:         'account',
        attributes: ['username', 'display_name'],
      }],
    });

    return rows.map(r => ({
      id:         r.id,
      tweet_id:   r.tweet_id,
      username:   r.account?.username ?? '?',
      text:       r.text,
      posted_at:  r.posted_at,
      likes:      r.likes,
      retweets:   r.retweets,
      replies:    r.replies,
      views:      r.views,
      is_reply:   r.is_reply,
      raw_url:    r.raw_url,
      used:       !!r.used_for_content,
    }));
  }

  // ── LinkedIn posts ────────────────────────────────────────────────────────

  /**
   * Same logic as getTwitterPosts() but for LinkedIn.
   *
   * @param {{ days?: number, unusedOnly?: boolean }} opts
   * @returns {Promise<object[]>}
   */
  async getLinkedinPosts({ days = 7, unusedOnly = false } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where  = {};

    if (unusedOnly) {
      where.used_for_content = null;
    } else {
      where[Op.or] = [
        { used_for_content: null },
        { posted_at: { [Op.gte]: cutoff } },
      ];
    }

    const rows = await this.LinkedinPost.findAll({
      where,
      order:      [['posted_at', 'DESC']],
      limit:      30,
      include: [{
        model:      this.Account,
        as:         'account',
        attributes: ['username', 'display_name'],
      }],
    });

    return rows.map(r => ({
      id:         r.id,
      post_id:    r.post_id,
      username:   r.account?.username ?? r.username,
      text:       r.text,
      posted_at:  r.posted_at,
      shared_url: r.shared_url,
      visibility: r.visibility,
      raw_url:    r.raw_url,
      used:       !!r.used_for_content,
    }));
  }

  // ── GitHub events ─────────────────────────────────────────────────────────

  /**
   * Fetch GitHub events within the time window.
   * GitHub events are informational context — no "used" tracking needed.
   *
   * @param {{ days?: number }} opts
   * @returns {Promise<object[]>}
   */
  async getGithubEvents({ days = 7 } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);

    const rows = await this.GithubEvent.findAll({
      where: {
        occurred_at: { [Op.gte]: cutoff },
      },
      order: [['occurred_at', 'DESC']],
      limit: 40,
      include: [{
        model:      this.Account,
        as:         'account',
        attributes: ['username', 'display_name'],
      }],
    });

    return rows.map(r => ({
      id:          r.id,
      username:    r.account?.username ?? r.username,
      repo:        r.repo,
      event_type:  r.event_type,
      title:       r.title,
      body:        r.body,
      url:         r.url,
      occurred_at: r.occurred_at,
      metadata:    r.metadata,
    }));
  }

  // ── Mark as used ──────────────────────────────────────────────────────────

  /**
   * Stamp used_for_content = now on all exported post IDs.
   * Called after the Markdown file is written successfully.
   *
   * @param {{ twitterIds: number[], linkedinIds: number[] }} ids
   */
  async markAsUsed({ twitterIds = [], linkedinIds = [] }) {
    const now = new Date();

    if (twitterIds.length) {
      await this.Post.update(
        { used_for_content: now },
        { where: { id: { [Op.in]: twitterIds } } },
      );
    }

    if (linkedinIds.length) {
      await this.LinkedinPost.update(
        { used_for_content: now },
        { where: { id: { [Op.in]: linkedinIds } } },
      );
    }
  }
}
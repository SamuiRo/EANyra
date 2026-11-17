/**
 * src/core/teapot/repositories/ExportRepository.js
 *
 * Aggregates data from posts and signals tables for the `eanyra export` command.
 * Returns plain objects (not Sequelize instances) so the export formatter
 * has no ORM dependency.
 */

import { Op } from 'sequelize';
import { EXPORT } from '../../../config/app.config.js';

function selectPlatformEntries(value, platforms) {
  if (!value || !platforms?.length) return value;

  return Object.fromEntries(
    platforms
      .filter(platform => Object.hasOwn(value, platform))
      .map(platform => [platform, value[platform]]),
  );
}

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
   * Returns { persona, voice, bio, platforms, projects[] }.
   *
   * Voice, bio and platform rules come from one persona (each persona is
   * self-contained). Without `persona` the only persona is used when there is
   * exactly one; otherwise the export has no voice section and says why.
   * Projects come from the Project model (structured objects with all fields),
   * limited to the persona's projects when it lists them.
   */
  async getContext({ platforms, persona: slug } = {}) {
    const rows = await this.UserContext.findAll({ where: { key: { [Op.like]: 'persona.%' } } });
    const personas = rows.map(row => (typeof row.value === 'string' ? JSON.parse(row.value) : row.value));
    let persona = null;
    if (slug) {
      persona = personas.find(entry => entry.slug === slug);
      if (!persona) {
        throw new Error(`Unknown persona "${slug}". Known: ${personas.map(entry => entry.slug).join(', ') || 'none'}.`);
      }
    } else if (personas.length === 1) {
      [persona] = personas;
    }

    const ctx = persona
      ? { persona: { slug: persona.slug, name: persona.name }, voice: persona.voice, bio: persona.bio, platforms: persona.platforms }
      : { persona: null, personas: personas.map(entry => entry.slug) };

    ctx.bio = selectPlatformEntries(ctx.bio, platforms);
    ctx.platforms = selectPlatformEntries(ctx.platforms, platforms);

    // Active projects — full structured objects
    const projects = await this.Project.findAll({
      where: { status: 'active' },
      order: [['slug', 'ASC']],
    });

    const allowed = persona?.projects ?? null;
    ctx.projects = projects.filter(p => !allowed || allowed.includes(p.slug)).map(p => ({
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
   *   - Always include posts that have never been exported
   *   - Also include recently published posts that were exported before
   *   - Excludes reposts — original content only
   *   - `unusedOnly` flag restricts to never-exported posts only
   *
   * @param {{
   *   days?: number,
   *   unusedOnly?: boolean,
   *   platform?: string,
   *   platforms?: string[],
   * }} opts
   * @returns {Promise<object[]>}
   */
  async getPosts({ days = EXPORT.defaultDays, unusedOnly = false, platform, platforms } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where  = { is_repost: false };

    const selectedPlatforms = [...new Set(
      platforms?.length ? platforms : (platform ? [platform] : []),
    )];

    if (selectedPlatforms.length === 1) {
      [where.platform] = selectedPlatforms;
    } else if (selectedPlatforms.length > 1) {
      where.platform = { [Op.in]: selectedPlatforms };
    }

    if (unusedOnly) {
      where.exported_at = null;
    } else {
      // Never-exported always included; exported only if within the time window
      where[Op.or] = [
        { exported_at: null },
        { posted_at: { [Op.gte]: cutoff } },
      ];
    }

    const rows = await this.Post.findAll({
      where,
      order:   [['posted_at', 'DESC']],
      limit:   EXPORT.maxRecords,
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
      exported:    !!r.exported_at,
    }));
  }

  // ── Signals ───────────────────────────────────────────────────────────────

  /**
   * Fetch signals for export.
   *
   * Selection strategy (mirrors getPosts logic, matches PLAN.md §4.4):
   *   - Always include signals that have never been exported
   *   - Also include already-exported signals within the date window
   *   - `unusedOnly` flag restricts to never-exported signals only
   *
   * Note: unlike posts, signals use `occurred_at` as the time anchor.
   * Signals where occurred_at is NULL are included when never exported — they
   * should not be silently dropped just because the timestamp is missing.
   *
   * @param {{ days?: number, unusedOnly?: boolean, source?: string }} opts
   * @returns {Promise<object[]>}
   */
  async getSignals({ days = EXPORT.defaultDays, unusedOnly = false, source } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where  = {};

    if (source) where.source = source;

    if (unusedOnly) {
      where.exported_at = null;
    } else {
      // Never-exported always included (even if occurred_at is NULL);
      // exported only if within the time window
      where[Op.or] = [
        { exported_at: null },
        { occurred_at: { [Op.gte]: cutoff } },
      ];
    }

    const rows = await this.Signal.findAll({
      where,
      order:   [['occurred_at', 'DESC']],
      limit:   EXPORT.maxRecords,
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
      exported:    !!r.exported_at,
    }));
  }

  // ── Mark as exported ──────────────────────────────────────────────────────

  /**
   * Stamp exported_at = now on the given post and signal IDs.
   * Called after the Markdown file is written successfully.
   *
   * Only stamps items that are not yet marked (exported_at IS NULL)
   * so that the first-export timestamp is preserved on subsequent runs.
   *
   * @param {{ postIds?: number[], signalIds?: number[] }} ids
   */
  async markAsExported({ postIds = [], signalIds = [] }) {
    const now = new Date();

    if (postIds.length) {
      await this.Post.update(
        { exported_at: now },
        {
          where: {
            id:               { [Op.in]: postIds },
            exported_at: null,
          },
        },
      );
    }

    if (signalIds.length) {
      await this.Signal.update(
        { exported_at: now },
        {
          where: {
            id:               { [Op.in]: signalIds },
            exported_at: null,
          },
        },
      );
    }
  }
}

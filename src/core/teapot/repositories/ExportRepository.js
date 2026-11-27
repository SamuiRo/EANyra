/**
 * src/core/teapot/repositories/ExportRepository.js
 *
 * Aggregates data from posts and signals tables for the `eanyra export` command.
 * Returns plain objects (not Sequelize instances) so the export formatter
 * has no ORM dependency.
 */

import { Op } from 'sequelize';
import { EXPORT } from '../../../config/app.config.js';
import { isIsolated, personaVoice, withoutIsolatedProjects } from '../../../config/personaConfig.js';

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
    const personas = await this.#personas();
    // The export file is read by agents (export_get): isolated personas only by slug.
    const visible = personas.filter(entry => !isIsolated(entry));
    let persona = null;
    if (slug) {
      persona = this.#persona(personas, slug);
    } else if (personas.length === 1 && visible.length === 1) {
      [persona] = visible;
    }

    const ctx = persona
      ? { persona: { slug: persona.slug, name: persona.name }, voice: personaVoice(persona, personas), bio: persona.bio, platforms: persona.platforms }
      : { persona: null, personas: visible.map(entry => entry.slug) };

    ctx.bio = selectPlatformEntries(ctx.bio, platforms);
    ctx.platforms = selectPlatformEntries(ctx.platforms, platforms);

    // Active projects — full structured objects
    const projects = await this.Project.findAll({
      where: { status: 'active' },
      order: [['slug', 'ASC']],
    });

    const listed = persona
      ? projects.filter(p => (persona.projects ?? []).includes(p.slug))
      : withoutIsolatedProjects(projects, personas);
    ctx.projects = listed.map(p => ({
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
   *   persona?: string,   only this persona's posts; without it, none of isolated personas
   * }} opts
   * @returns {Promise<object[]>}
   */
  async getPosts({ days = EXPORT.defaultDays, unusedOnly = false, platform, platforms, persona } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where  = { is_repost: false };
    const scope  = await this.#accountScope(persona);
    if (scope.only) where.account_id = { [Op.in]: scope.only };
    else if (scope.hidden.length) where.account_id = { [Op.notIn]: scope.hidden };

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
   * @param {{ days?: number, unusedOnly?: boolean, source?: string, persona?: string }} opts
   *   persona: its accounts' signals and ideas bound to it; without it, none of isolated personas
   * @returns {Promise<object[]>}
   */
  async getSignals({ days = EXPORT.defaultDays, unusedOnly = false, source, persona } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const where  = {};
    const scope  = await this.#accountScope(persona);
    const sequelize = this.Signal.sequelize;
    const bound = `(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.persona') END)`;
    if (scope.only) {
      where[Op.and] = [{ [Op.or]: [
        { account_id: { [Op.in]: scope.only } },
        sequelize.literal(`${bound} = ${sequelize.escape(persona)}`),
      ] }];
    } else {
      const hidden = [];
      if (scope.hidden.length) {
        hidden.push({ [Op.or]: [{ account_id: null }, { account_id: { [Op.notIn]: scope.hidden } }] });
      }
      if (scope.hiddenSlugs.length) {
        hidden.push(sequelize.literal(
          `COALESCE(${bound}, '') NOT IN (${scope.hiddenSlugs.map(slug => sequelize.escape(slug)).join(', ')})`));
      }
      if (hidden.length) where[Op.and] = hidden;
    }

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

  // ── Persona scope ─────────────────────────────────────────────────────────

  async #personas() {
    const rows = await this.UserContext.findAll({ where: { key: { [Op.like]: 'persona.%' } } });
    return rows.map(row => (typeof row.value === 'string' ? JSON.parse(row.value) : row.value));
  }

  #persona(personas, slug) {
    const persona = personas.find(entry => entry.slug === slug);
    if (!persona) {
      const known = personas.filter(entry => !isIsolated(entry)).map(entry => entry.slug);
      throw new Error(`Unknown persona "${slug}". Known: ${known.join(', ') || 'none'}.`);
    }
    return persona;
  }

  /**
   * Account ids for a persona (`only`), or, without one, the account ids and
   * slugs of isolated personas to leave out.
   */
  async #accountScope(slug) {
    const personas = await this.#personas();
    const accounts = await this.Account.findAll({ attributes: ['id', 'platform', 'username'] });
    const idsOf = list => {
      const keys = new Set(list.flatMap(entry => entry.accounts.map(ref => `${ref.platform}/${ref.username}`)));
      return accounts.filter(row => keys.has(`${row.platform}/${String(row.username).toLowerCase()}`)).map(row => row.id);
    };
    if (slug) return { only: idsOf([this.#persona(personas, slug)]), hidden: [], hiddenSlugs: [] };
    const isolated = personas.filter(isIsolated);
    return { only: null, hidden: idsOf(isolated), hiddenSlugs: isolated.map(entry => entry.slug) };
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

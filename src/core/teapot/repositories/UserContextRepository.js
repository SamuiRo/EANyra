import fs   from 'node:fs';
import path  from 'node:path';
import { Op } from 'sequelize';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, parseDocument } from 'yaml';
import { PATHS }              from '../../../config/app.config.js';
import { validateAccounts }   from '../../../config/accountConfig.js';
import {
  parsePersona,
  assertExclusiveMembership,
  assertPersonaLinks,
  accountKey,
} from '../../../config/personaConfig.js';
import { validateProject } from '../../../config/contextSchema.js';

/** Old shared files: no longer used, every persona carries its own. */
export const LEGACY_CONTEXT_FILES = { 'voice.yaml': 'voice', 'bio.yaml': 'bio', 'platforms.yaml': 'platforms' };

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * UserContextRepository
 *
 * Responsible for:
 *  - Reading YAML files from instance/context/
 *  - Syncing them into the `user_context` table (upsert by key)
 *  - Reading context back for MCP tools and CLI display
 *
 * Keys written to DB:
 *   "project.<slug>"      ← projects/<slug>.yaml  (one row per project)
 *   "persona.<slug>"      ← personas/<slug>.yaml  (one row per persona)
 */
export class UserContextRepository {
  /** @param {{ UserContext, Project }} models */
  constructor({ UserContext, Project }, contextDir = PATHS.contextDir, accountsConfigPath = PATHS.accountsConfig) {
    this.UserContext = UserContext;
    this.Project     = Project;
    this.contextDir  = contextDir;
    this.accountsConfigPath = accountsConfigPath;
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /**
   * Read all YAML files and upsert into DB.
   * Returns a summary { updated, skipped, errors, warnings }.
   * A file with errors is not stored; its previously synced version stays.
   */
  async sync() {
    const results = { updated: [], skipped: [], errors: [], warnings: [] };
    const now     = new Date();

    // ── legacy shared files: not used any more ──
    const legacy = Object.keys(LEGACY_CONTEXT_FILES).filter(name => fs.existsSync(path.join(this.contextDir, name)));
    if (legacy.length) {
      results.warnings.push(`${legacy.join(', ')}: not used any more — every persona has its own voice, bio and ` +
        'platform rules. Move them into the personas: web «Контекст» → «Перенести в персони».');
    }
    await this.UserContext.destroy({ where: { key: { [Op.in]: Object.values(LEGACY_CONTEXT_FILES) } } });

    // ── projects/*.yaml ──
    await this.#syncProjects(results, now);

    // ── personas/*.yaml ──
    await this.#syncPersonas(results, now);

    return results;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Returns the stored context rows (persona.*, project.*) plus active projects. */
  async getAll() {
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
      status:         p.status,
      description:    p.description,
      tech_stack:     p.tech_stack,
      links:          p.links,
      content_angles: p.content_angles,
      posting_rules:  p.posting_rules,
    }));

    return ctx;
  }

  /** Returns a single context key value. */
  async getKey(key) {
    const row = await this.UserContext.findOne({ where: { key } });
    return row ? row.value : null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  async #syncProjects(results, now) {
    const projectsDir = path.join(this.contextDir, 'projects');

    if (!fs.existsSync(projectsDir)) {
      results.skipped.push('projects/ (directory not found)');
      return;
    }

    const files = fs.readdirSync(projectsDir)
      .filter(f => f.endsWith('.yaml') && !f.startsWith('_') && !f.endsWith('.example.yaml'));
    const syncedSlugs = [];
    const initialErrorCount = results.errors.length;

    for (const file of files) {
      syncedSlugs.push(path.basename(file, '.yaml'));
      const filePath = path.join(projectsDir, file);
      try {
        const raw  = fs.readFileSync(filePath, 'utf8');
        const fileSlug = path.basename(file, '.yaml');
        const { value: data, warnings } = validateProject(parseYaml(raw), fileSlug);
        results.warnings.push(...warnings.map(warning => `projects/${file}: ${warning}`));

        // slug falls back to filename without extension
        const slug = data.slug ?? fileSlug;
        const archived = data.archive === true;

        await this.Project.upsert({
          slug,
          name:           data.name           ?? slug,
          status:         archived ? 'archived' : (data.status ?? 'active'),
          description:    data.description     ?? null,
          tech_stack:     data.tech_stack      ?? [],
          links:          data.links           ?? {},
          content_angles: data.content_angles  ?? [],
          posting_rules:  data.posting_rules   ?? [],
          synced_at:      now,
        });

        // Also write a flat user_context row for quick key lookup
        await this.UserContext.upsert({
          key:       `project.${slug}`,
          value:     archived ? { ...data, status: 'archived', archive: true } : data,
          synced_at: now,
        });

        if (!syncedSlugs.includes(slug)) syncedSlugs.push(slug);
        results.updated.push(`project.${slug}`);
      } catch (err) {
        results.errors.push(`projects/${file}: ${err.message}`);
      }
    }

    if (results.errors.length > initialErrorCount) {
      results.skipped.push('project deletion reconciliation (project sync errors)');
      return;
    }

    const missingProjects = await this.Project.findAll({
      where: syncedSlugs.length
        ? { slug: { [Op.notIn]: syncedSlugs } }
        : {},
    });

    for (const project of missingProjects) {
      await project.update({ status: 'archived', synced_at: now });

      const key = `project.${project.slug}`;
      const existing = await this.UserContext.findOne({ where: { key } });
      await this.UserContext.upsert({
        key,
        value: {
          ...(existing?.value ?? {}),
          slug: project.slug,
          name: project.name,
          status: 'archived',
          archive: true,
        },
        synced_at: now,
      });
      results.updated.push(`${key} (archived)`);
    }
  }

  async #syncPersonas(results, now) {
    const personasDir = path.join(this.contextDir, 'personas');
    const files = fs.existsSync(personasDir)
      ? fs.readdirSync(personasDir)
        .filter(f => f.endsWith('.yaml') && !f.startsWith('_') && !f.endsWith('.example.yaml'))
      : [];

    let configured;
    try {
      const entries = validateAccounts(JSON.parse(fs.readFileSync(this.accountsConfigPath, 'utf8')));
      configured = new Set(entries.map(accountKey));
    } catch (err) {
      if (files.length) {
        results.errors.push(`personas: cannot check accounts against ${this.accountsConfigPath}: ${err.message}`);
        return;
      }
    }

    // Validate every file first: membership must be exclusive across personas,
    // so a single invalid file leaves all stored personas unchanged.
    const personas = [];
    const initialErrorCount = results.errors.length;
    const activeProjects = (await this.Project.findAll({ where: { status: 'active' }, order: [['slug', 'ASC']] }))
      .map(project => project.slug);
    for (const file of files) {
      try {
        const data = this.#migrateProjects(path.join(personasDir, file), activeProjects, results);
        const persona = parsePersona(data, path.basename(file, '.yaml'), configured);
        results.warnings.push(...persona.warnings.map(warning => `personas/${file}: ${warning}`));
        delete persona.warnings;
        personas.push(persona);
      } catch (err) {
        results.errors.push(`personas/${file}: ${err.message}`);
      }
    }
    if (results.errors.length === initialErrorCount) {
      try {
        assertExclusiveMembership(personas);
        assertPersonaLinks(personas);
      } catch (err) {
        results.errors.push(`personas: ${err.message}`);
      }
    }
    if (results.errors.length > initialErrorCount) {
      results.skipped.push('personas (validation errors; stored personas unchanged)');
      return;
    }

    for (const persona of personas) {
      await this.UserContext.upsert({ key: `persona.${persona.slug}`, value: persona, synced_at: now });
      results.updated.push(`persona.${persona.slug}`);
    }

    // A deleted persona file removes the grouping; it holds no history.
    const removed = await this.UserContext.destroy({
      where: {
        key: {
          [Op.like]: 'persona.%',
          [Op.notIn]: personas.map(persona => `persona.${persona.slug}`),
        },
      },
    });
    if (removed) results.updated.push(`${removed} removed persona(s)`);
  }

  /**
   * Since v5.0 an omitted `projects` means none (it used to mean every active
   * project). A persona file from before that (no projects, no disclosure)
   * gets the list it effectively had written out once, so it loses nothing
   * and the author sees what it can talk about. Comments in the file stay.
   * @returns {unknown} the parsed file, after the rewrite if one happened
   */
  #migrateProjects(file, activeProjects, results) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = parseYaml(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data) || 'projects' in data || 'disclosure' in data) return data;
    const doc = parseDocument(raw);
    const pair = doc.createPair('projects', activeProjects);
    pair.key.commentBefore = ' Written by context sync (v5.0): the active projects this persona used when' +
      '\n projects was omitted. An omitted list now means none; edit this one to narrow it.';
    doc.contents.items.push(pair);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, doc.toString({ lineWidth: 0, blockQuote: 'literal' }), { flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    results.warnings.push(`personas/${path.basename(file)}: projects was not set; wrote the ${activeProjects.length} active ` +
      'project(s) it used explicitly (an omitted list now means none). Edit the list to narrow it.');
    return parseYaml(fs.readFileSync(file, 'utf8'));
  }
}

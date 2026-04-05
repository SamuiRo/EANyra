import fs   from 'node:fs';
import path  from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Constants ─────────────────────────────────────────────────────────────────

// Resolve relative to this file so it works regardless of cwd
const CONTEXT_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../../src/context',
);

/**
 * UserContextRepository
 *
 * Responsible for:
 *  - Reading YAML files from src/context/
 *  - Syncing them into the `user_context` table (upsert by key)
 *  - Reading context back for MCP tools and CLI display
 *
 * Keys written to DB:
 *   "voice"               ← voice.yaml (whole file as object)
 *   "bio"                 ← bio.yaml
 *   "platforms"           ← platforms.yaml
 *   "project.<slug>"      ← projects/<slug>.yaml  (one row per project)
 */
export class UserContextRepository {
  /** @param {{ UserContext, Project }} models */
  constructor({ UserContext, Project }) {
    this.UserContext = UserContext;
    this.Project     = Project;
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /**
   * Read all YAML files and upsert into DB.
   * Returns a summary { updated, skipped, errors }.
   */
  async sync() {
    const results = { updated: [], skipped: [], errors: [] };
    const now     = new Date();

    // ── voice.yaml ──
    await this.#syncFile('voice.yaml',     'voice',     results, now);
    await this.#syncFile('bio.yaml',       'bio',       results, now);
    await this.#syncFile('platforms.yaml', 'platforms', results, now);

    // ── projects/*.yaml ──
    await this.#syncProjects(results, now);

    return results;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Returns the full context object for MCP: { voice, bio, platforms, projects } */
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

  async #syncFile(filename, key, results, now) {
    const filePath = path.join(CONTEXT_DIR, filename);

    if (!fs.existsSync(filePath)) {
      results.skipped.push(`${filename} (not found)`);
      return;
    }

    try {
      const raw   = fs.readFileSync(filePath, 'utf8');
      const value = parseYaml(raw);

      await this.UserContext.upsert({ key, value, synced_at: now });
      results.updated.push(key);
    } catch (err) {
      results.errors.push(`${filename}: ${err.message}`);
    }
  }

  async #syncProjects(results, now) {
    const projectsDir = path.join(CONTEXT_DIR, 'projects');

    if (!fs.existsSync(projectsDir)) {
      results.skipped.push('projects/ (directory not found)');
      return;
    }

    const files = fs.readdirSync(projectsDir)
      .filter(f => f.endsWith('.yaml') && !f.startsWith('_'));

    for (const file of files) {
      const filePath = path.join(projectsDir, file);
      try {
        const raw  = fs.readFileSync(filePath, 'utf8');
        const data = parseYaml(raw);

        // slug falls back to filename without extension
        const slug = data.slug ?? path.basename(file, '.yaml');

        await this.Project.upsert({
          slug,
          name:           data.name           ?? slug,
          status:         data.status          ?? 'active',
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
          value:     data,
          synced_at: now,
        });

        results.updated.push(`project.${slug}`);
      } catch (err) {
        results.errors.push(`projects/${file}: ${err.message}`);
      }
    }
  }
}
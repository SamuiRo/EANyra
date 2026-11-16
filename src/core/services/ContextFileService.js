/**
 * Read, validate and write the author context YAML files for the web UI:
 *
 *   voice.yaml, bio.yaml, platforms.yaml
 *   projects/<slug>.yaml, personas/<slug>.yaml
 *
 * The raw text is kept (comments survive). Saving validates with the same
 * rules as `context sync`, writes atomically and refuses files with errors.
 * Deleted projects and personas move to context/.trash/ instead of vanishing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { PATHS, PROJECT_ROOT } from '../../config/app.config.js';
import { validateAccounts, accountKey } from '../../config/accountConfig.js';
import { validateVoice, validateBio, validatePlatforms, validateProject, ContextValidationError } from '../../config/contextSchema.js';
import { parsePersona, assertExclusiveMembership } from '../../config/personaConfig.js';

const TOP = { 'voice.yaml': validateVoice, 'bio.yaml': validateBio, 'platforms.yaml': validatePlatforms };
const ITEM = /^(projects|personas)\/([a-z0-9][a-z0-9-]{0,63})\.yaml$/;
const DESCRIPTIONS = {
  'voice.yaml': 'Голос: тон, що подобається і що ні, табу, приклад поста',
  'bio.yaml': 'Біо для кожної платформи',
  'platforms.yaml': 'Правила платформ: мова, стиль, довжина, формати, частота',
};

export class ContextFileService {
  constructor({ contextDir = PATHS.contextDir, accountsConfigPath = PATHS.accountsConfig, templatesDir } = {}) {
    this.contextDir = contextDir;
    this.accountsConfigPath = accountsConfigPath;
    this.templatesDir = templatesDir ?? path.join(PROJECT_ROOT, 'instance_example', 'context');
  }

  /** All editable files, existing or not (top-level files can be created). */
  async list() {
    const files = Object.keys(TOP).map(name => ({ path: name, kind: name.replace('.yaml', ''), description: DESCRIPTIONS[name] }));
    for (const folder of ['projects', 'personas']) {
      const names = await fs.readdir(path.join(this.contextDir, folder)).catch(() => []);
      for (const name of names.sort()) {
        const rel = `${folder}/${name}`;
        if (ITEM.test(rel)) files.push({ path: rel, kind: folder.slice(0, -1) });
      }
    }
    return Promise.all(files.map(async file => ({ ...file, exists: await exists(this.#abs(file.path)) })));
  }

  async read(rel) {
    const file = this.#abs(rel);
    try {
      return { path: rel, exists: true, content: await fs.readFile(file, 'utf8') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const template = TOP[rel] ? await fs.readFile(path.join(this.templatesDir, rel.replace('.yaml', '.example.yaml')), 'utf8').catch(() => '') : '';
      return { path: rel, exists: false, content: template };
    }
  }

  /** @returns {Promise<{ ok: boolean, errors: string[], warnings: string[] }>} */
  async validate(rel, content) {
    this.#abs(rel);
    if (typeof content !== 'string') return { ok: false, errors: ['Content must be text.'], warnings: [] };
    let data;
    try {
      data = parseYaml(content);
    } catch (error) {
      const line = error.linePos?.[0]?.line;
      return { ok: false, errors: [`YAML syntax${line ? ` (line ${line})` : ''}: ${error.message.split('\n')[0]}`], warnings: [] };
    }
    try {
      if (TOP[rel]) return { ok: true, errors: [], warnings: TOP[rel](data).warnings };
      const [, folder, slug] = rel.match(ITEM);
      if (folder === 'projects') return { ok: true, errors: [], warnings: validateProject(data, slug).warnings };
      const configured = new Set(validateAccounts(JSON.parse(await fs.readFile(this.accountsConfigPath, 'utf8').catch(() => '[]'))).map(accountKey));
      const persona = parsePersona(data, slug, configured);
      // One account may belong to one persona only: check against the others.
      const others = [];
      for (const name of await fs.readdir(path.join(this.contextDir, 'personas')).catch(() => [])) {
        const otherSlug = name.replace(/\.yaml$/, '');
        if (!ITEM.test(`personas/${name}`) || otherSlug === slug) continue;
        try {
          others.push(parsePersona(parseYaml(await fs.readFile(path.join(this.contextDir, 'personas', name), 'utf8')), otherSlug));
        } catch {
          // An invalid other file is reported when that file is edited.
        }
      }
      assertExclusiveMembership([...others, persona]);
      return { ok: true, errors: [], warnings: persona.warnings };
    } catch (error) {
      return { ok: false, errors: error instanceof ContextValidationError ? error.errors : [error.message], warnings: [] };
    }
  }

  async write(rel, content) {
    const result = await this.validate(rel, content);
    if (!result.ok) throw Object.assign(new Error(`Not saved: ${result.errors.join('; ')}`), { status: 400, validation: result });
    const file = this.#abs(rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content.endsWith('\n') ? content : `${content}\n`, { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return result;
  }

  /** New project or persona from the template; never overwrites. */
  async create(kind, slug) {
    if (!['project', 'persona'].includes(kind)) throw Object.assign(new Error('kind must be project or persona.'), { status: 400 });
    const rel = `${kind}s/${slug}.yaml`;
    if (!ITEM.test(rel)) throw Object.assign(new Error('The name must be lowercase kebab-case, e.g. my-project.'), { status: 400 });
    const file = this.#abs(rel);
    if (await exists(file)) throw Object.assign(new Error(`${rel} already exists.`), { status: 409 });
    const local = path.join(this.contextDir, `${kind}s`, '_template.yaml');
    const template = await fs.readFile(local, 'utf8')
      .catch(() => fs.readFile(path.join(this.templatesDir, `${kind}s`, '_template.yaml'), 'utf8'))
      .catch(() => '');
    const content = template.replace(/^slug:.*$/m, `slug: "${slug}"`) || `slug: "${slug}"\n`;
    return { path: rel, exists: false, content };
  }

  /** Move a project/persona to context/.trash/ (sync then archives / ungroups it). */
  async remove(rel) {
    if (!ITEM.test(rel)) throw Object.assign(new Error('Only project and persona files can be deleted.'), { status: 400 });
    const file = this.#abs(rel);
    const trash = path.join(this.contextDir, '.trash');
    await fs.mkdir(trash, { recursive: true });
    const target = path.join(trash, `${rel.replace('/', '-').replace(/\.yaml$/, '')}.${Date.now()}.yaml`);
    await fs.rename(file, target);
    return { path: rel, trashed: path.relative(this.contextDir, target).replaceAll('\\', '/') };
  }

  /** Whitelisted path inside the context folder. */
  #abs(rel) {
    if (typeof rel !== 'string' || !(TOP[rel] || ITEM.test(rel))) {
      throw Object.assign(new Error('Unknown context file.'), { status: 400 });
    }
    return path.join(this.contextDir, ...rel.split('/'));
  }
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

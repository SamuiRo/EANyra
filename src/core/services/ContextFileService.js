/**
 * Read, validate and write the author context YAML files for the web UI:
 *
 *   personas/<slug>.yaml   voice, bio, platform rules and accounts of one persona
 *   projects/<slug>.yaml   projects the personas talk about
 *   voice.yaml, bio.yaml, platforms.yaml   legacy shared files, no longer used;
 *                          listed only while they exist, until moved into the personas
 *
 * The raw text is kept (comments survive). Saving validates with the same
 * rules as `context sync`, writes atomically and refuses files with errors.
 * Deleted projects and personas move to context/.trash/ instead of vanishing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, parseDocument } from 'yaml';

import { PATHS, PROJECT_ROOT } from '../../config/app.config.js';
import { validateAccounts, accountKey, parseAccountRef } from '../../config/accountConfig.js';
import { validateVoice, validateBio, validatePlatforms, validateProject, ContextValidationError } from '../../config/contextSchema.js';
import { parsePersona, assertExclusiveMembership, assertPersonaLinks, legacyIntoPersona } from '../../config/personaConfig.js';

const TOP = { 'voice.yaml': validateVoice, 'bio.yaml': validateBio, 'platforms.yaml': validatePlatforms };
const ITEM = /^(projects|personas)\/([a-z0-9][a-z0-9-]{0,63})\.yaml$/;
const DESCRIPTIONS = {
  'voice.yaml': 'Застаріле: спільний голос (не використовується)',
  'bio.yaml': 'Застаріле: спільне біо (не використовується)',
  'platforms.yaml': 'Застаріле: спільні правила платформ (не використовуються)',
};
// Keep the author's line breaks; long text stays a literal block (|).
const YAML_OUT = { lineWidth: 0, blockQuote: 'literal' };
const fail = (status, message) => Object.assign(new Error(message), { status });

export class ContextFileService {
  constructor({ contextDir = PATHS.contextDir, accountsConfigPath = PATHS.accountsConfig, templatesDir } = {}) {
    this.contextDir = contextDir;
    this.accountsConfigPath = accountsConfigPath;
    this.templatesDir = templatesDir ?? path.join(PROJECT_ROOT, 'instance_example', 'context');
  }

  /** Personas and projects; the legacy shared files only while they exist. */
  async list() {
    const files = [];
    for (const name of Object.keys(TOP)) {
      if (await exists(this.#abs(name))) files.push({ path: name, kind: 'legacy', description: DESCRIPTIONS[name] });
    }
    for (const folder of ['projects', 'personas']) {
      const names = await fs.readdir(path.join(this.contextDir, folder)).catch(() => []);
      for (const name of names.sort()) {
        const rel = `${folder}/${name}`;
        if (ITEM.test(rel)) files.push({ path: rel, kind: folder.slice(0, -1) });
      }
    }
    return Promise.all(files.map(async file => ({ ...file, exists: await exists(this.#abs(file.path)) })));
  }

  /** "platform/username" → persona slug, from the persona files. */
  async accountPersonas() {
    const map = {};
    for (const persona of await this.#personas()) {
      for (const ref of persona.accounts) map[accountKey(ref)] = persona.slug;
    }
    return map;
  }

  /**
   * Put an account into a persona (or none): removes it from its current
   * persona file and appends it to the new one. Comments in the files stay.
   */
  async setAccountPersona(account, slug) {
    const key = accountKey(parseAccountRef(String(account ?? '')));
    const target = slug ? `personas/${slug}.yaml` : null;
    if (target && !(ITEM.test(target) && await exists(this.#abs(target)))) throw fail(404, `Persona "${slug}" not found.`);
    const current = Object.entries(await this.accountPersonas()).find(([k]) => k === key)?.[1] ?? null;
    if (current === (slug || null)) return { account: key, persona: current, changed: false };

    let restore = null;
    if (current) {
      const rel = `personas/${current}.yaml`;
      const before = (await this.read(rel)).content;
      const doc = parseDocument(before);
      const items = doc.get('accounts')?.items ?? [];
      const index = items.findIndex(item => {
        try {
          return accountKey(parseAccountRef(String(item?.value ?? item))) === key;
        } catch {
          return false;
        }
      });
      if (index >= 0) doc.deleteIn(['accounts', index]);
      await this.write(rel, doc.toString(YAML_OUT));
      restore = () => this.write(rel, before);
    }
    if (target) {
      try {
        const doc = parseDocument((await this.read(target)).content);
        if (!doc.get('accounts')?.items) doc.set('accounts', doc.createNode([]));
        doc.addIn(['accounts'], key);
        await this.write(target, doc.toString(YAML_OUT));
      } catch (error) {
        await restore?.();
        throw error;
      }
    }
    return { account: key, persona: slug || null, changed: true };
  }

  /**
   * Move the legacy shared files into every persona (only what a persona does
   * not set itself, only for its platforms), then put them in the trash.
   */
  async migrateLegacy() {
    const legacyFiles = [];
    for (const name of Object.keys(TOP)) if (await exists(this.#abs(name))) legacyFiles.push(name);
    if (!legacyFiles.length) throw fail(409, 'There are no shared voice/bio/platforms files to move.');
    const personas = await this.#personas();
    if (!personas.length) throw fail(409, 'Create a persona first: the shared files are moved into the personas.');

    const legacy = {};
    for (const name of legacyFiles) {
      const validation = await this.validate(name, (await this.read(name)).content);
      if (!validation.ok) throw fail(400, `${name}: ${validation.errors.join('; ')} — fix it first.`);
      legacy[name.replace('.yaml', '')] = parseYaml((await this.read(name)).content) ?? {};
    }

    const updated = [];
    for (const persona of personas) {
      const rel = `personas/${persona.slug}.yaml`;
      const doc = parseDocument((await this.read(rel)).content);
      const want = legacyIntoPersona(legacy, persona);
      let changed = false;
      const fill = (pathParts, value) => {
        if (doc.hasIn(pathParts)) return;
        doc.setIn(pathParts, doc.createNode(value));
        changed = true;
      };
      for (const [field, value] of Object.entries(want.voice)) fill(['voice', field], value);
      for (const section of ['bio', 'platforms']) {
        for (const [platform, rules] of Object.entries(want[section])) {
          if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
            fill([section, platform], rules);
            continue;
          }
          for (const [field, value] of Object.entries(rules)) fill([section, platform, field], value);
        }
      }
      if (changed) {
        await this.write(rel, doc.toString(YAML_OUT));
        updated.push(rel);
      }
    }
    const trashed = [];
    const trash = path.join(this.contextDir, '.trash');
    await fs.mkdir(trash, { recursive: true });
    for (const name of legacyFiles) {
      const target = path.join(trash, `${name.replace('.yaml', '')}.${Date.now()}.yaml`);
      await fs.rename(this.#abs(name), target);
      trashed.push(path.relative(this.contextDir, target).replaceAll('\\', '/'));
    }
    return { updated, trashed };
  }

  async #personas() {
    const personas = [];
    for (const name of await fs.readdir(path.join(this.contextDir, 'personas')).catch(() => [])) {
      if (!ITEM.test(`personas/${name}`)) continue;
      try {
        personas.push(parsePersona(parseYaml(await fs.readFile(path.join(this.contextDir, 'personas', name), 'utf8')), name.replace(/\.yaml$/, '')));
      } catch {
        // Invalid files are reported when edited or synced.
      }
    }
    return personas;
  }

  async read(rel) {
    const file = this.#abs(rel);
    try {
      return { path: rel, exists: true, content: await fs.readFile(file, 'utf8') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (TOP[rel]) throw fail(404, `${rel} is not used any more: every persona has its own voice, bio and platform rules.`);
      return { path: rel, exists: false, content: '' };
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
      assertPersonaLinks([...others, persona]);
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
    // The shipped template first: older instances keep an outdated copy.
    const template = await fs.readFile(path.join(this.templatesDir, `${kind}s`, '_template.yaml'), 'utf8')
      .catch(() => fs.readFile(path.join(this.contextDir, `${kind}s`, '_template.yaml'), 'utf8'))
      .catch(() => '');
    let content = template.replace(/^slug:.*$/m, `slug: "${slug}"`) || `slug: "${slug}"\n`;
    // Accounts are assigned in «Акаунти»; example entries would not validate.
    if (kind === 'persona') {
      const doc = parseDocument(content);
      if (doc.has('accounts')) {
        doc.set('accounts', doc.createNode([]));
        content = doc.toString(YAML_OUT);
      }
    }
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

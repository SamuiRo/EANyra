import { parseAccountRef, accountKey } from './accountConfig.js';

/**
 * Personas group the accounts that represent one identity or theme across
 * platforms (e.g. a business brand on Twitter + LinkedIn + Telegram, or an
 * anime account). Each persona carries its own voice, bio, platform rules and
 * projects; anything it leaves out falls back to the global context files.
 *
 * Source: instance/context/personas/<slug>.yaml
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OBJECT_FIELDS = ['voice', 'bio', 'platforms'];

export { parseAccountRef, accountKey };

/**
 * Validate one persona file.
 * @param {unknown} data          parsed YAML
 * @param {string}  fileSlug      filename without .yaml
 * @param {Set<string>} [configured] "platform/username" keys from accounts.json
 */
export function parsePersona(data, fileSlug, configured) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Persona file must be a YAML mapping.');
  const slug = data.slug ?? fileSlug;
  if (slug !== fileSlug) throw new Error(`slug "${slug}" must match the filename "${fileSlug}.yaml".`);
  if (!SLUG.test(slug)) throw new Error(`slug "${slug}" must be lowercase kebab-case.`);
  if (!Array.isArray(data.accounts) || !data.accounts.length) {
    throw new Error('accounts must list at least one "platform/username".');
  }
  const accounts = data.accounts.map(ref => parseAccountRef(ref));
  const keys = accounts.map(accountKey);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate) throw new Error(`account ${duplicate} is listed twice.`);
  const unknown = configured ? keys.filter(key => !configured.has(key)) : [];
  if (unknown.length) throw new Error(`accounts not found in accounts.json: ${unknown.join(', ')}.`);
  for (const field of OBJECT_FIELDS) {
    if (data[field] !== undefined && (typeof data[field] !== 'object' || data[field] === null || Array.isArray(data[field]))) {
      throw new Error(`${field} must be a mapping.`);
    }
  }
  if (data.projects !== undefined &&
      (!Array.isArray(data.projects) || data.projects.some(project => typeof project !== 'string'))) {
    throw new Error('projects must be a list of project slugs.');
  }
  return {
    slug,
    name: data.name ?? slug,
    description: data.description ?? null,
    topics: Array.isArray(data.topics) ? data.topics : [],
    accounts,
    voice: data.voice ?? {},
    bio: data.bio ?? {},
    platforms: data.platforms ?? {},
    // Omitted: all active projects apply. [] means none of them.
    projects: data.projects ?? null,
  };
}

/** Throws when one account belongs to two personas: its voice would be ambiguous. */
export function assertExclusiveMembership(personas) {
  const owner = new Map();
  for (const persona of personas) {
    for (const key of persona.accounts.map(accountKey)) {
      if (owner.has(key)) throw new Error(`Account ${key} belongs to both "${owner.get(key)}" and "${persona.slug}".`);
      owner.set(key, persona.slug);
    }
  }
}

/**
 * Persona values override the global context; missing keys fall back to it.
 * voice merges per key; bio and platforms merge per platform and per key.
 */
export function mergePersonaContext(global, persona) {
  const mergeByPlatform = (base = {}, override = {}) => {
    const merged = { ...base };
    for (const [platform, value] of Object.entries(override)) {
      merged[platform] = value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(base[platform] ?? {}), ...value }
        : value;
    }
    return merged;
  };
  const projects = persona.projects === null
    ? global.projects ?? []
    : (global.projects ?? []).filter(project => persona.projects.includes(project.slug));
  return {
    persona: {
      slug: persona.slug,
      name: persona.name,
      description: persona.description,
      topics: persona.topics,
      accounts: persona.accounts.map(accountKey),
    },
    voice: { ...(global.voice ?? {}), ...persona.voice },
    bio: mergeByPlatform(global.bio, persona.bio),
    platforms: mergeByPlatform(global.platforms, persona.platforms),
    projects,
  };
}

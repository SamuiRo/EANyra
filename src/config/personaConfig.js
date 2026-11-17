import { parseAccountRef, accountKey } from './accountConfig.js';
import { validateVoice, validateBio, validatePlatforms, ContextValidationError } from './contextSchema.js';

/** Run a file validator on a persona section, naming fields "<section>.<field>". */
function prefixed(section, validate) {
  try {
    return validate().warnings.map(warning => `${section}.${warning}`);
  } catch (error) {
    if (!(error instanceof ContextValidationError)) throw error;
    throw new ContextValidationError(error.errors.map(message => `${section}.${message}`));
  }
}

/**
 * Personas group the accounts that represent one identity or theme across
 * platforms (e.g. a business brand on Twitter + LinkedIn + Telegram, or an
 * anime account). Each persona is self-contained: its own voice, bio and
 * platform rules. The old shared voice.yaml / bio.yaml / platforms.yaml are no
 * longer used (see legacyIntoPersona to carry their values over once).
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
  // A new persona may have no accounts yet; they are assigned in «Акаунти».
  if (data.accounts != null && !Array.isArray(data.accounts)) {
    throw new Error('accounts must be a list of "platform/username".');
  }
  const accounts = (data.accounts ?? []).map(ref => parseAccountRef(ref));
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
  // Overrides follow the same field rules as voice.yaml, bio.yaml, platforms.yaml.
  const warnings = [
    ...(accounts.length ? [] : ['accounts is empty: assign accounts to this persona («Акаунти» → edit → Персона)']),
    ...prefixed('voice', () => validateVoice(data.voice)),
    ...prefixed('bio', () => validateBio(data.bio)),
    ...prefixed('platforms', () => validatePlatforms(data.platforms)),
  ];
  const KNOWN = ['slug', 'name', 'description', 'topics', 'accounts', 'voice', 'bio', 'platforms', 'projects'];
  for (const key of Object.keys(data)) {
    if (!KNOWN.includes(key)) warnings.push(`${key} is not a known persona field and is ignored`);
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
    warnings,
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

function mergeByPlatform(base = {}, override = {}) {
  const merged = { ...base };
  for (const [platform, value] of Object.entries(override)) {
    merged[platform] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(base[platform] ?? {}), ...value }
      : value;
  }
  return merged;
}

/**
 * One-time carry-over of the old shared files into a persona: what the persona
 * effectively used before (its values over the shared ones), limited to the
 * platforms of its accounts and the platforms it already configures.
 * @returns {{ voice: object, bio: object, platforms: object }}
 */
export function legacyIntoPersona(legacy, persona) {
  const platforms = new Set([
    ...persona.accounts.map(ref => ref.platform),
    ...Object.keys(persona.bio ?? {}), ...Object.keys(persona.platforms ?? {}),
  ]);
  const only = value => Object.fromEntries(Object.entries(value).filter(([platform]) => platforms.has(platform)));
  return {
    voice: { ...(legacy.voice ?? {}), ...(persona.voice ?? {}) },
    bio: only(mergeByPlatform(legacy.bio, persona.bio)),
    platforms: only(mergeByPlatform(legacy.platforms, persona.platforms)),
  };
}

/**
 * The context to write as a persona: its own voice, bio and platform rules
 * (nothing shared) plus the projects it talks about.
 */
export function mergePersonaContext(global, persona) {
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
    voice: persona.voice ?? {},
    bio: persona.bio ?? {},
    platforms: persona.platforms ?? {},
    projects,
  };
}

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
const KNOWN = ['slug', 'name', 'description', 'topics', 'accounts', 'voice', 'bio', 'platforms', 'projects',
  'type', 'disclosure', 'linked_to'];

/** How the persona speaks. */
export const PERSONA_TYPES = {
  person: 'Speak in the first person as one real individual.',
  brand: 'Speak as a brand or team ("we"), not as an individual.',
  fan: 'Speak as a fan account: enthusiasm and community voice, no claims of authorship or insider access.',
  faceless: 'Speak without a personal identity: no face, name, biography or personal life.',
};

/**
 * How the persona is connected to the other personas:
 *   public   - may be seen and mentioned anywhere (default)
 *   linked   - mentions only the personas in linked_to
 *   isolated - never shown to an agent without its explicit slug, never
 *              returned by tools called without a persona, mentions nobody
 */
export const DISCLOSURES = ['public', 'linked', 'isolated'];

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
  for (const key of Object.keys(data)) {
    if (!KNOWN.includes(key)) warnings.push(`${key} is not a known persona field and is ignored`);
  }
  if (data.projects !== undefined &&
      (!Array.isArray(data.projects) || data.projects.some(project => typeof project !== 'string'))) {
    throw new Error('projects must be a list of project slugs.');
  }
  if (data.projects === undefined) {
    warnings.push('projects is not set: this persona talks about no projects. List their slugs (projects: [a, b]) to give it some');
  }
  if (data.type != null && !Object.hasOwn(PERSONA_TYPES, data.type)) {
    throw new Error(`type must be one of: ${Object.keys(PERSONA_TYPES).join(', ')}.`);
  }
  const disclosure = data.disclosure ?? 'public';
  if (!DISCLOSURES.includes(disclosure)) throw new Error(`disclosure must be one of: ${DISCLOSURES.join(', ')}.`);
  if (data.linked_to != null &&
      (!Array.isArray(data.linked_to) || data.linked_to.some(entry => typeof entry !== 'string' || !SLUG.test(entry)))) {
    throw new Error('linked_to must be a list of persona slugs.');
  }
  const linkedTo = [...new Set(data.linked_to ?? [])];
  if (linkedTo.includes(slug)) throw new Error('linked_to cannot contain the persona itself.');
  if (disclosure === 'linked' && !linkedTo.length) {
    warnings.push('linked_to is empty: a linked persona then mentions no other persona');
  }
  if (disclosure !== 'linked' && linkedTo.length) {
    warnings.push(`linked_to is used only with disclosure: linked and is ignored for ${disclosure}`);
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
    // Omitted means none: a persona never learns about projects by default.
    projects: data.projects ?? [],
    type: data.type ?? null,
    disclosure,
    linked_to: disclosure === 'linked' ? linkedTo : [],
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

/**
 * Cross-file rules for disclosure: linked_to names existing personas, and no
 * persona may link to an isolated one (that would connect it to the others).
 */
export function assertPersonaLinks(personas) {
  const bySlug = new Map(personas.map(persona => [persona.slug, persona]));
  for (const persona of personas) {
    for (const slug of persona.linked_to ?? []) {
      const target = bySlug.get(slug);
      if (!target) throw new Error(`Persona "${persona.slug}" links to unknown persona "${slug}".`);
      if (target.disclosure === 'isolated') {
        throw new Error(`Persona "${persona.slug}" links to "${slug}", which is isolated; isolated personas cannot be linked.`);
      }
    }
  }
}

export const isIsolated = persona => persona?.disclosure === 'isolated';

/**
 * Projects that only isolated personas talk about stay out of listings that
 * name no persona: they would reveal what an isolated persona works on.
 */
export function withoutIsolatedProjects(projects, personas, scope) {
  if (scope?.author) return projects;
  const visible = new Set(personas.filter(entry => !isIsolated(entry)).flatMap(entry => entry.projects ?? []));
  const isolated = new Set(personas.filter(isIsolated).flatMap(entry => entry.projects ?? []));
  return projects.filter(project => visible.has(project.slug) || !isolated.has(project.slug));
}

/**
 * Rules added to voice.taboo from disclosure, so a persona cannot mention
 * the ones it must not be connected to. Isolated personas are never named
 * in another persona's context.
 */
export function disclosureTaboo(persona, personas = []) {
  const disclosure = persona.disclosure ?? 'public';
  if (disclosure === 'isolated') {
    return ['Never mention, link or hint at any other persona, account or project of the author.'];
  }
  if (disclosure !== 'linked') return [];
  const linkedTo = persona.linked_to ?? [];
  const linked = personas.filter(other => linkedTo.includes(other.slug));
  const describe = other => `"${other.name}" (${[other.slug, ...other.accounts.map(accountKey)].join(', ')})`;
  const rules = [linked.length
    ? `Never mention, link or hint at any other persona or account of the author except ${linked.map(describe).join('; ')}.`
    : 'Never mention, link or hint at any other persona or account of the author.'];
  for (const other of personas) {
    if (other.slug === persona.slug || isIsolated(other) || linkedTo.includes(other.slug)) continue;
    rules.push(`Never mention ${describe(other)}.`);
  }
  return rules;
}

/** The persona's voice with the disclosure taboo appended. */
export function personaVoice(persona, personas = []) {
  const voice = { ...(persona.voice ?? {}) };
  const extra = disclosureTaboo(persona, personas);
  if (extra.length) voice.taboo = [...(Array.isArray(voice.taboo) ? voice.taboo : []), ...extra];
  return voice;
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
 * (nothing shared), the projects it talks about and the taboo its disclosure
 * implies. `personas` are all synced personas, for the linked taboo.
 */
export function mergePersonaContext(global, persona, personas = []) {
  // Rows synced before v5.0 may still say null ("all"); treat it as none.
  const allowed = persona.projects ?? [];
  const projects = (global.projects ?? []).filter(project => allowed.includes(project.slug));
  const type = persona.type ?? null;
  return {
    persona: {
      slug: persona.slug,
      name: persona.name,
      description: persona.description,
      topics: persona.topics,
      accounts: persona.accounts.map(accountKey),
      type,
      ...(type ? { speaks_as: PERSONA_TYPES[type] } : {}),
      disclosure: persona.disclosure ?? 'public',
      linked_to: persona.linked_to ?? [],
    },
    voice: personaVoice(persona, personas),
    bio: persona.bio ?? {},
    platforms: persona.platforms ?? {},
    projects,
  };
}

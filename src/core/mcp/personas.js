import { query } from './db.js';
import { accountKey, parseAccountRef } from '../../config/personaConfig.js';

/**
 * src/core/mcp/personas.js
 *
 * Personas are synced by `eanyra context sync` into user_context rows
 * "persona.<slug>". These helpers resolve them for MCP tools.
 */

export async function loadPersonas() {
  const rows = await query("SELECT value FROM user_context WHERE key LIKE 'persona.%' ORDER BY key");
  return rows.map(row => JSON.parse(row.value));
}

export async function getPersona(slug) {
  const personas = await loadPersonas();
  const persona = personas.find(entry => entry.slug === slug);
  if (!persona) {
    const known = personas.map(entry => entry.slug).join(', ') || 'none';
    throw new Error(`Unknown persona "${slug}". Known personas: ${known}. Run "eanyra context sync" after editing personas/*.yaml.`);
  }
  return persona;
}

/** Resolve "twitter/name" (or name + platform) to its persona, or null. */
export async function personaForAccount(account, platform) {
  const key = accountKey(parseAccountRef(account, platform));
  return (await loadPersonas()).find(persona => persona.accounts.some(entry => accountKey(entry) === key)) ?? null;
}

/** Map "platform/username" → persona slug, for annotating account rows. */
export async function personaIndex() {
  const index = new Map();
  for (const persona of await loadPersonas()) {
    for (const entry of persona.accounts) index.set(accountKey(entry), persona.slug);
  }
  return index;
}

/**
 * SQL condition limiting an `accounts` alias to the persona's accounts.
 * @returns {Promise<{ sql: string, params: string[] }>}
 */
export async function personaAccountCondition(slug, alias = 'a') {
  const persona = await getPersona(slug);
  return {
    sql: `(${persona.accounts.map(() => `(${alias}.platform = ? AND LOWER(${alias}.username) = ?)`).join(' OR ')})`,
    params: persona.accounts.flatMap(entry => [entry.platform, entry.username]),
  };
}

export const personaProperty = {
  type:        'string',
  description: 'Limit to the accounts of one persona (see context_get personas). Use it to calibrate style on the right account group.',
};

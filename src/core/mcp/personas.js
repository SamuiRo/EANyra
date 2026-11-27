import { query } from './db.js';
import { accountKey, parseAccountRef, isIsolated } from '../../config/personaConfig.js';

/**
 * src/core/mcp/personas.js
 *
 * Personas are synced by `eanyra context sync` into user_context rows
 * "persona.<slug>". These helpers resolve them for MCP tools.
 *
 * Visibility: tools are called by an AI agent (MCP) or by the author's own
 * web UI. The web UI passes `{ author: true }` as the second handler argument
 * (see callTool); an agent never can. Without it, isolated personas are
 * hidden unless the call names them by slug.
 */

export async function loadPersonas() {
  const rows = await query("SELECT value FROM user_context WHERE key LIKE 'persona.%' ORDER BY key");
  return rows.map(row => JSON.parse(row.value));
}

/** Personas listed without naming one: all for the author, no isolated ones for an agent. */
export async function visiblePersonas(scope) {
  const personas = await loadPersonas();
  return scope?.author ? personas : personas.filter(persona => !isIsolated(persona));
}

/** Slugs and "platform/username" keys a call without persona must not return. */
export async function hiddenScope(scope) {
  if (scope?.author) return { slugs: [], accounts: [] };
  const isolated = (await loadPersonas()).filter(isIsolated);
  return { slugs: isolated.map(persona => persona.slug), accounts: isolated.flatMap(persona => persona.accounts.map(accountKey)) };
}

export async function getPersona(slug) {
  const personas = await loadPersonas();
  const persona = personas.find(entry => entry.slug === slug);
  if (!persona) {
    // Isolated personas are not listed as suggestions; their exact slug still resolves.
    const known = personas.filter(entry => !isIsolated(entry)).map(entry => entry.slug).join(', ') || 'none';
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
  if (!persona.accounts.length) return { sql: '0', params: [] };
  return {
    sql: `(${persona.accounts.map(() => `(${alias}.platform = ? AND LOWER(${alias}.username) = ?)`).join(' OR ')})`,
    params: persona.accounts.flatMap(entry => [entry.platform, entry.username]),
  };
}

const boundPersona = alias => `(CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata, '$.persona') END)`;

/**
 * The persona filter every data tool applies. With a persona: its accounts
 * (and, for signals, ideas bound to it). Without one: everything except the
 * accounts and bound signals of isolated personas (agent calls only).
 * `alias` may come from a LEFT JOIN (NULL account); `signalAlias` enables the
 * metadata.persona binding of signals.
 * @returns {Promise<{ sql: string, params: string[] } | null>}
 */
export async function personaScopeCondition({ persona, scope, alias = 'a', signalAlias = null } = {}) {
  if (persona) {
    const filter = await personaAccountCondition(persona, alias);
    if (!signalAlias) return filter;
    return { sql: `(${filter.sql} OR ${boundPersona(signalAlias)} = ?)`, params: [...filter.params, persona] };
  }
  const hidden = await hiddenScope(scope);
  const conds = [];
  const params = [];
  if (hidden.accounts.length) {
    conds.push(`COALESCE(${alias}.platform || '/' || LOWER(${alias}.username), '') NOT IN (${hidden.accounts.map(() => '?').join(', ')})`);
    params.push(...hidden.accounts);
  }
  if (signalAlias && hidden.slugs.length) {
    conds.push(`COALESCE(${boundPersona(signalAlias)}, '') NOT IN (${hidden.slugs.map(() => '?').join(', ')})`);
    params.push(...hidden.slugs);
  }
  return conds.length ? { sql: conds.join(' AND '), params } : null;
}

export const personaProperty = {
  type:        'string',
  description: 'Limit to the accounts of one persona (see personas_list). Use it to calibrate style on the right account group. ' +
    'Some personas are returned only when named here.',
};

/**
 * Single source of truth for platform metadata.
 *
 * Dependency-free so configuration, validation, CLI and MCP schemas can import
 * it without loading platform implementations. Collection code lives in
 * platforms/collectors.js and must cover every id listed here.
 *
 *   output       where collected records go: posts (published content) or signals
 *   session      secret kind that holds this platform's login, or null
 *   collection   short description of how data is obtained
 *   publishing   'auto' (agent may publish after approval), 'manual' (drafts only)
 */

export const PLATFORM_CATALOG = Object.freeze({
  twitter: Object.freeze({
    id: 'twitter', displayName: 'Twitter / X', output: 'posts', session: 'twitter',
    collection: 'Playwright browser, one isolated context per login', publishing: 'manual',
  }),
  github: Object.freeze({
    id: 'github', displayName: 'GitHub', output: 'signals', session: 'github',
    collection: 'REST API with a personal access token', publishing: null,
  }),
  linkedin: Object.freeze({
    id: 'linkedin', displayName: 'LinkedIn', output: 'posts', session: null,
    collection: 'CSV data export import', publishing: 'manual',
  }),
  telegram: Object.freeze({
    id: 'telegram', displayName: 'Telegram', output: 'posts', session: 'telegram',
    collection: 'MTProto polling with a user session', publishing: 'auto',
  }),
});

export const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORM_CATALOG));

/** Platforms whose collection needs a stored login ("session" in accounts.json). */
export const SESSION_PLATFORMS = Object.freeze(PLATFORM_IDS.filter(id => PLATFORM_CATALOG[id].session));

export function platformInfo(id) {
  const info = PLATFORM_CATALOG[id];
  if (!info) throw new Error(`Unknown platform: "${id}". Valid options: ${PLATFORM_IDS.join(', ')}`);
  return info;
}

import { GITHUB, TELEGRAM } from '../../config/app.config.js';
import { sessionOf, SESSION_PLATFORMS, DEFAULT_SESSION } from '../../config/accountConfig.js';

/**
 * One row per (secret kind, session) referenced by accounts, plus stored
 * sessions nobody references. Exported for tests.
 */
export function sessionReport(entries, store, now = Date.now()) {
  const rows = new Map();
  const row = (kind, name) => {
    const id = `${kind}/${name}`;
    if (!rows.has(id)) rows.set(id, { kind, name, accounts: [] });
    return rows.get(id);
  };
  for (const entry of entries) {
    if (SESSION_PLATFORMS.includes(entry.platform)) {
      row(entry.platform, sessionOf(entry)).accounts.push(`${entry.platform}/${entry.username}`);
    }
    if (entry.platform === 'telegram' && entry.publish_enabled === true &&
        (entry.publish_transport ?? 'bot') === 'bot') {
      row('telegram-bot', entry.bot ?? DEFAULT_SESSION).accounts.push(`${entry.platform}/${entry.username} (publish)`);
    }
  }
  for (const item of store?.list() ?? []) {
    if (!['telegram-api', 'mcp-token', 'discord-webhook'].includes(item.kind)) row(item.kind, item.name);
  }
  return [...rows.values()].map(item => ({ ...item, ...describeSecret(item, store, now) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function describeSecret({ kind, name }, store, now) {
  if (!store) return { ok: name === DEFAULT_SESSION, state: name === DEFAULT_SESSION ? 'from .env (plaintext)' : 'needs the vault' };
  const value = store.get(kind, name);
  if (!value) {
    const legacy = { 'telegram': TELEGRAM.session, 'telegram-bot': TELEGRAM.botToken, 'github': GITHUB.token }[kind];
    if (name === DEFAULT_SESSION && legacy) return { ok: true, state: 'from .env (plaintext, run vault migrate)' };
    return { ok: false, state: 'MISSING' };
  }
  if (kind === 'twitter') {
    const auth = value.cookies?.find(cookie => cookie.name === 'auth_token');
    if (!auth) return { ok: false, state: 'logged out' };
    if (auth.expires > 0 && auth.expires * 1000 < now) return { ok: false, state: 'EXPIRED' };
    const days = auth.expires > 0 ? Math.floor((auth.expires * 1000 - now) / 86_400_000) : null;
    return { ok: true, state: days === null ? 'ok' : `ok · auth cookie valid ${days} more day(s)` };
  }
  return { ok: true, state: 'ok' };
}

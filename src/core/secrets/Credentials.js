/**
 * Per-session credentials for every platform.
 *
 * An account in accounts.json names the login it uses with "session"
 * (default: "default"). Each session is one secret in the encrypted vault:
 *
 *   twitter/<session>       Playwright storage state (cookies + local storage)
 *   telegram/<session>      MTProto session string
 *   telegram-bot/<session>  Bot API token (account field "bot")
 *   github/<session>        personal access token
 *   telegram-api/default    { api_id, api_hash }
 *
 * Legacy mode (no vault file): only the "default" session exists and comes
 * from the plaintext root .env / cookie cache, exactly as before.
 */

import fs from 'node:fs/promises';

import { BROWSER, GITHUB, PATHS, TELEGRAM } from '../../config/app.config.js';
import { readCookieFile, saveCookieCache } from '../browser/sessionCookies.js';
import { saveTelegramSession as saveTelegramSessionEnv } from '../../platforms/telegram/sessionEnv.js';
import { print } from '../../shared/utils.js';
import { DEFAULT_SESSION, assertSessionName } from './Vault.js';
import { getVault } from './vaultAccess.js';

export { DEFAULT_SESSION };

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  print(message, 'warning');
}

export class Credentials {
  /**
   * @param {{ vault?: import('./Vault.js').Vault|null, env?: object }} [deps]
   */
  constructor({ vault = null, legacy = {} } = {}) {
    this.vault = vault;
    this.legacy = {
      telegram: TELEGRAM,
      githubToken: GITHUB.token,
      cookiesPath: BROWSER.cookiesPath,
      envFile: PATHS.envFile,
      ...legacy,
    };
  }

  /** Open with the process-wide vault (prompting in a terminal if needed). */
  static async open(opts) {
    return new Credentials({ vault: await getVault(opts) });
  }

  get encrypted() { return this.vault !== null; }

  // ── X / Twitter ─────────────────────────────────────────────────────────────

  /** @returns {Promise<{cookies: object[], origins: object[]}|null>} */
  async twitterState(session = DEFAULT_SESSION) {
    if (this.vault) {
      const state = this.vault.get('twitter', session);
      if (state || session !== DEFAULT_SESSION) return state;
    } else {
      this.#assertLegacySession(session);
    }
    try {
      const cookies = await readCookieFile(this.legacy.cookiesPath);
      if (this.vault) {
        warnOnce('twitter', `Using the plaintext X cookie cache ${this.legacy.cookiesPath}. Run \`npm run nyra -- vault migrate\` to encrypt it.`);
      }
      return { cookies, origins: [] };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveTwitterState(session, state) {
    if (!state?.cookies?.some(cookie => cookie.name === 'auth_token')) {
      throw new Error('The X session has no auth_token cookie; refusing to save a logged-out session.');
    }
    if (this.vault) return this.vault.set('twitter', session, state);
    this.#assertLegacySession(session);
    await saveCookieCache(state.cookies, this.legacy.cookiesPath);
  }

  // ── Telegram ────────────────────────────────────────────────────────────────

  /** Runtime MTProto config: shared tuning + API keys + this session's string. */
  telegramConfig(session = DEFAULT_SESSION) {
    const api = this.telegramApi();
    let sessionString;
    if (this.vault) {
      sessionString = this.vault.get('telegram', session)?.session ?? '';
      if (!sessionString && session === DEFAULT_SESSION && this.legacy.telegram.session) {
        warnOnce('telegram', 'Using plaintext TELEGRAM_SESSION from .env. Run `npm run nyra -- vault migrate` to encrypt it.');
        sessionString = this.legacy.telegram.session;
      }
    } else {
      this.#assertLegacySession(session);
      sessionString = this.legacy.telegram.session;
    }
    return { ...this.legacy.telegram, ...api, session: sessionString, sessionName: session };
  }

  telegramApi() {
    const stored = this.vault?.get('telegram-api', DEFAULT_SESSION);
    if (stored) return { apiId: Number(stored.api_id), apiHash: stored.api_hash };
    return { apiId: this.legacy.telegram.apiId, apiHash: this.legacy.telegram.apiHash };
  }

  async saveTelegramSession(session, sessionString) {
    if (this.vault) return this.vault.set('telegram', session, { session: sessionString });
    this.#assertLegacySession(session);
    return saveTelegramSessionEnv(sessionString, this.legacy.envFile);
  }

  botToken(bot = DEFAULT_SESSION) {
    if (this.vault) {
      const token = this.vault.get('telegram-bot', bot)?.token;
      if (token || bot !== DEFAULT_SESSION) return token ?? '';
    } else {
      this.#assertLegacySession(bot);
    }
    return this.legacy.telegram.botToken ?? '';
  }

  // ── GitHub ──────────────────────────────────────────────────────────────────

  githubToken(session = DEFAULT_SESSION) {
    if (this.vault) {
      const token = this.vault.get('github', session)?.token;
      if (token || session !== DEFAULT_SESSION) return token ?? '';
    } else {
      this.#assertLegacySession(session);
    }
    return this.legacy.githubToken ?? '';
  }

  // ── MCP over HTTP (eanyra serve) ────────────────────────────────────────────

  /** Token MCP clients must send to /mcp; '' when none is configured. */
  mcpToken() {
    if (this.vault) return this.vault.get('mcp-token', DEFAULT_SESSION)?.token ?? '';
    return process.env.MCP_HTTP_TOKEN ?? '';
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  #assertLegacySession(session) {
    assertSessionName(session);
    if (session !== DEFAULT_SESSION) {
      throw new Error(
        `Session "${session}" needs the encrypted vault. Run \`npm run nyra -- vault init\` first; ` +
        'without it only the "default" session from .env exists.',
      );
    }
  }
}

/** True when a file exists; used by migration/status commands. */
export async function fileExists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

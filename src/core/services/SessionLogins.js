/**
 * Interactive logins started from the web UI, kept in memory while they run:
 *
 *   X:        a normal browser window opens on this PC; the author logs in
 *             there and presses "Done" in the web UI → storage state is saved.
 *   Telegram: QR login; the QR code is shown in the web UI and refreshed, a
 *             2FA password is asked for when Telegram needs it.
 *
 * Results go straight into the encrypted vault through Credentials. Logins
 * expire after `timeoutMs` and are cleaned up.
 */

import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';

import { TELEGRAM } from '../../config/app.config.js';
import { normalizeCookie } from '../browser/sessionCookies.js';
import { openLoginWindow } from '../browser/loginWindow.js';
import { loginTelegram, telegramLoginUrl } from '../../platforms/telegram/TelegramLogin.js';
import { assertSessionName } from '../secrets/Vault.js';

/** Parse pasted/uploaded cookie JSON (browser-extension export) into a storage state. */
export function cookiesToState(text) {
  let parsed;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('The cookies must be JSON (an export from a cookie extension).');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(list) || !list.length) throw new Error('No cookies found in the JSON.');
  // Only X cookies are kept; an export may contain other sites too.
  const cookies = list.map(normalizeCookie).filter(cookie => /(^|\.)(x|twitter)\.com$/.test(cookie.domain.replace(/^\./, '')));
  if (!cookies.some(cookie => cookie.name === 'auth_token')) {
    throw new Error('These cookies have no auth_token for x.com: export them while logged in to X.');
  }
  const auth = cookies.find(cookie => cookie.name === 'auth_token');
  if (auth.expires > 0 && auth.expires * 1000 < Date.now()) throw new Error('The auth_token cookie has expired: log in to X again and re-export.');
  return { cookies, origins: [] };
}

export class SessionLogins {
  /**
   * @param {{ getCredentials: () => Promise<import('../secrets/Credentials.js').Credentials>,
   *           openWindow?: typeof openLoginWindow, telegramLogin?: typeof loginTelegram,
   *           timeoutMs?: number }} deps
   */
  constructor({ getCredentials, openWindow = openLoginWindow, telegramLogin = loginTelegram, timeoutMs = 15 * 60_000 }) {
    this.getCredentials = getCredentials;
    this.openWindow = openWindow;
    this.telegramLogin = telegramLogin;
    this.timeoutMs = timeoutMs;
    this.logins = new Map();
  }

  // ── X ─────────────────────────────────────────────────────────────────────

  async importCookies(name, text) {
    assertSessionName(name);
    const state = cookiesToState(text);
    await (await this.getCredentials()).saveTwitterState(name, state);
    return { kind: 'twitter', name, cookies: state.cookies.length };
  }

  async startTwitter(name) {
    assertSessionName(name);
    this.#assertNoActive('twitter', name);
    const window = await this.openWindow();
    const login = this.#register({ kind: 'twitter', name, status: 'waiting', window,
      message: 'Log in to X in the browser window that opened on this PC, then press "Done".' });
    return this.#public(login);
  }

  async finishTwitter(id) {
    const login = this.#get(id, 'twitter');
    const state = await login.window.context.storageState();
    if (!state.cookies.some(cookie => cookie.name === 'auth_token')) {
      throw Object.assign(new Error('Not logged in yet: finish logging in to X in the browser window, then press "Done" again.'), { status: 409 });
    }
    await (await this.getCredentials()).saveTwitterState(login.name, state);
    login.status = 'done';
    login.message = `X session "${login.name}" saved (${state.cookies.length} cookies).`;
    await this.#end(login);
    return this.#public(login);
  }

  // ── Telegram ──────────────────────────────────────────────────────────────

  async startTelegram(name) {
    assertSessionName(name);
    this.#assertNoActive('telegram', name);
    const credentials = await this.getCredentials();
    const controller = new AbortController();
    const login = this.#register({ kind: 'telegram', name, status: 'starting', controller,
      message: 'Connecting to Telegram…' });

    const run = this.telegramLogin({
      method: 'qr',
      config: { ...TELEGRAM, ...credentials.telegramApi() },
      signal: controller.signal,
      renderQr: async ({ token }) => {
        login.qrSvg = await QRCode.toString(telegramLoginUrl(token), { type: 'svg', margin: 1 });
        login.status = 'qr';
        login.message = 'Telegram on your phone: Settings → Devices → Link Desktop Device, then scan this code.';
      },
      readPassword: hint => new Promise((resolve, reject) => {
        login.status = 'password';
        login.hint = hint ?? null;
        login.message = login.passwordTried ? 'Wrong password, try again.' : 'Enter your Telegram 2FA password.';
        login.resolvePassword = resolve;
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      }),
      log: message => { login.log = message; },
    });

    run.then(async ({ session }) => {
      await credentials.saveTelegramSession(name, session);
      login.status = 'done';
      login.message = `Telegram session "${name}" saved.`;
    }).catch(error => {
      if (login.status === 'cancelled') return;
      login.status = 'failed';
      login.message = error.message;
    }).finally(() => this.#end(login));

    return this.#public(login);
  }

  telegramPassword(id, password) {
    const login = this.#get(id, 'telegram');
    if (login.status !== 'password' || !login.resolvePassword) {
      throw Object.assign(new Error('Telegram is not waiting for a password.'), { status: 409 });
    }
    if (typeof password !== 'string' || !password) throw Object.assign(new Error('Enter the password.'), { status: 400 });
    const resolve = login.resolvePassword;
    login.resolvePassword = null;
    login.passwordTried = true;
    login.status = 'checking';
    login.message = 'Checking the password…';
    resolve(password);
    return this.#public(login);
  }

  // ── Common ────────────────────────────────────────────────────────────────

  status(id) {
    const login = this.logins.get(id);
    if (!login) throw Object.assign(new Error('Unknown or expired login.'), { status: 404 });
    return this.#public(login);
  }

  async cancel(id) {
    const login = this.logins.get(id);
    if (!login) return { id, status: 'cancelled' };
    login.status = 'cancelled';
    login.message = 'Login cancelled.';
    login.controller?.abort(new Error('Login cancelled.'));
    await this.#end(login);
    return this.#public(login);
  }

  async closeAll() {
    await Promise.allSettled([...this.logins.values()].map(login => this.cancel(login.id)));
  }

  #register(login) {
    login.id = randomUUID();
    login.startedAt = new Date().toISOString();
    login.timer = setTimeout(() => {
      if (!['done', 'failed', 'cancelled'].includes(login.status)) {
        void this.cancel(login.id).then(() => { login.status = 'failed'; login.message = 'The login timed out.'; });
      }
    }, this.timeoutMs);
    login.timer.unref?.();
    this.logins.set(login.id, login);
    return login;
  }

  async #end(login) {
    clearTimeout(login.timer);
    if (login.window) {
      const window = login.window;
      login.window = null;
      await window.close();
    }
    // Keep the final state briefly so the UI can read it, then forget it.
    setTimeout(() => this.logins.delete(login.id), 5 * 60_000).unref?.();
  }

  #get(id, kind) {
    const login = this.logins.get(id);
    if (!login || login.kind !== kind) throw Object.assign(new Error('Unknown or expired login.'), { status: 404 });
    if (['done', 'failed', 'cancelled'].includes(login.status)) {
      throw Object.assign(new Error(`This login is already ${login.status}.`), { status: 409 });
    }
    return login;
  }

  #assertNoActive(kind, name) {
    for (const login of this.logins.values()) {
      if (login.kind === kind && login.name === name && !['done', 'failed', 'cancelled'].includes(login.status)) {
        throw Object.assign(new Error(`A ${kind} login for "${name}" is already in progress.`), { status: 409 });
      }
    }
  }

  #public(login) {
    const { id, kind, name, status, message, hint, qrSvg, startedAt } = login;
    return { id, kind, name, status, message, ...(hint ? { hint } : {}), ...(status === 'qr' && qrSvg ? { qr_svg: qrSvg } : {}), started_at: startedAt };
  }
}

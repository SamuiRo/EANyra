/**
 * Browser authentication for the local web server.
 *
 * With a vault: log in with the master password (it also unlocks the vault
 * for collection and publishing). Without a vault: a random access token is
 * printed in the terminal at startup.
 *
 * Sessions live in memory only (a restart logs everyone out), are sent as an
 * HttpOnly SameSite=Strict cookie and expire after inactivity.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'eanyra_session';

export class WebAuth {
  /**
   * @param {{ verifyPassword: (password: string) => Promise<boolean>,
   *           idleTimeoutMs?: number, now?: () => number }} opts
   *   verifyPassword: true when the secret is correct; it may also unlock the vault.
   */
  constructor({ verifyPassword, idleTimeoutMs = 8 * 3600_000, now = () => Date.now() }) {
    this.verifyPassword = verifyPassword;
    this.idleTimeoutMs = idleTimeoutMs;
    this.now = now;
    this.sessions = new Map();
    this.failures = [];
  }

  /** @returns {Promise<string>} new session id */
  async login(password) {
    this.#assertNotThrottled();
    if (typeof password !== 'string' || !password || password.length > 1024) {
      throw Object.assign(new Error('Enter the password.'), { status: 400 });
    }
    let ok = false;
    try {
      ok = await this.verifyPassword(password);
    } catch (error) {
      if (error.code !== 'VAULT_DECRYPT_FAILED') throw error;
    }
    if (!ok) {
      this.failures.push(this.now());
      throw Object.assign(new Error('Wrong password.'), { status: 401 });
    }
    this.failures = [];
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { createdAt: this.now(), seenAt: this.now() });
    return id;
  }

  logout(id) {
    if (id) this.sessions.delete(id);
  }

  /** Session id from the request cookie when it is valid; refreshes idle time. */
  check(req) {
    const id = readCookie(req.headers.cookie, COOKIE);
    const session = id && this.sessions.get(id);
    if (!session) return null;
    if (this.now() - session.seenAt > this.idleTimeoutMs) {
      this.sessions.delete(id);
      return null;
    }
    session.seenAt = this.now();
    return id;
  }

  cookie(id) {
    return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.idleTimeoutMs / 1000)}`;
  }

  clearCookie() {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  /** 5 wrong attempts within 5 minutes lock the login for 60 seconds. */
  #assertNotThrottled() {
    const now = this.now();
    this.failures = this.failures.filter(time => now - time < 5 * 60_000);
    if (this.failures.length >= 5 && now - this.failures.at(-1) < 60_000) {
      throw Object.assign(new Error('Too many wrong attempts. Wait a minute.'), { status: 429 });
    }
  }
}

export function tokenVerifier(token) {
  const expected = Buffer.from(token);
  return async password => {
    const given = Buffer.from(password);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
}

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

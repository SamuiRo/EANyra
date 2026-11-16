/**
 * Encrypted on-disk store for every credential EANyra uses: X browser
 * sessions, Telegram MTProto sessions and API keys, bot and GitHub tokens.
 *
 * The file holds one AES-GCM envelope (see crypto.js). Plaintext exists only
 * in process memory. Writes re-read the file under a lock, so a login in one
 * terminal and a scrape refreshing cookies in another do not lose updates.
 *
 * Secrets are addressed as "<kind>/<name>", e.g. "twitter/brand-a".
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertEnvelope,
  assertPasswordStrength,
  deriveKey,
  newKdfParams,
  open,
  seal,
} from './crypto.js';

export const SECRET_KINDS = Object.freeze({
  'twitter':      'X/Twitter browser session (cookies and local storage)',
  'telegram':     'Telegram MTProto user session',
  'telegram-api': 'Telegram API id and hash from my.telegram.org',
  'telegram-bot': 'Telegram bot token for publishing',
  'github':       'GitHub personal access token',
  'mcp-token':    'Bearer token for MCP clients of `eanyra serve` (/mcp)',
});

export const DEFAULT_SESSION = 'default';
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function secretId(kind, name = DEFAULT_SESSION) {
  if (!Object.hasOwn(SECRET_KINDS, kind)) throw new Error(`Unknown secret kind: ${kind}`);
  assertSessionName(name);
  return `${kind}/${name}`;
}

export function assertSessionName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`Invalid session name "${name}". Use lowercase letters, digits, "-" or "_".`);
  }
}

export class Vault {
  #key = null;
  #kdf = null;
  #data = null;

  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async exists() {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  get unlocked() { return this.#key !== null; }

  /** Create a new empty vault. Refuses to overwrite an existing file. */
  async create(password) {
    assertPasswordStrength(password);
    if (await this.exists()) throw new Error(`Vault already exists: ${this.filePath}`);
    const kdf = newKdfParams();
    this.#key = await deriveKey(password, kdf);
    this.#kdf = kdf;
    this.#data = emptyData();
    await this.#write(this.#data, { exclusive: true });
    return this;
  }

  async unlock(password) {
    const envelope = await this.#readEnvelope();
    const key = await deriveKey(password, envelope.kdf);
    this.#data = normalizeData(open(key, envelope));
    this.#key = key;
    this.#kdf = envelope.kdf;
    return this;
  }

  /**
   * Unlock with key material handed over by a parent process or the OS key
   * store. Never written to disk or the environment in plaintext.
   */
  async unlockWithKey({ key, salt }) {
    const envelope = await this.#readEnvelope();
    if (salt !== envelope.kdf.salt) {
      throw new Error('The saved vault key belongs to an older master password. Unlock with the password again.');
    }
    const buffer = Buffer.from(key, 'base64');
    this.#data = normalizeData(open(buffer, envelope));
    this.#key = buffer;
    this.#kdf = envelope.kdf;
    return this;
  }

  /** Key material for a child process (IPC only) or the OS key store. */
  exportKey() {
    this.#assertUnlocked();
    return { key: this.#key.toString('base64'), salt: this.#kdf.salt };
  }

  lock() {
    this.#key?.fill(0);
    this.#key = null;
    this.#kdf = null;
    this.#data = null;
  }

  /** Re-encrypt everything under a new password and salt. */
  async changePassword(newPassword) {
    assertPasswordStrength(newPassword);
    this.#assertUnlocked();
    await this.#withLock(async () => {
      const data = normalizeData(open(this.#key, await this.#readEnvelope()));
      const kdf = newKdfParams(this.#kdf);
      const key = await deriveKey(newPassword, kdf);
      this.#key = key;
      this.#kdf = kdf;
      this.#data = data;
      await this.#write(data);
    });
  }

  // ── Secrets ────────────────────────────────────────────────────────────────

  get(kind, name = DEFAULT_SESSION) {
    this.#assertUnlocked();
    const entry = this.#data.secrets[secretId(kind, name)];
    return entry ? structuredClone(entry.value) : null;
  }

  list() {
    this.#assertUnlocked();
    return Object.entries(this.#data.secrets).map(([id, entry]) => {
      const [kind, name] = id.split('/');
      return { kind, name, updated_at: entry.updated_at };
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  async set(kind, name, value) {
    const id = secretId(kind, name);
    if (value === undefined || value === null) throw new Error('A secret value is required.');
    await this.update(data => {
      data.secrets[id] = { value, updated_at: new Date().toISOString() };
    });
  }

  async delete(kind, name) {
    const id = secretId(kind, name);
    let removed = false;
    await this.update(data => {
      removed = Object.hasOwn(data.secrets, id);
      delete data.secrets[id];
    });
    return removed;
  }

  /** Read-modify-write against the latest file contents. */
  async update(mutate) {
    this.#assertUnlocked();
    await this.#withLock(async () => {
      const envelope = await this.#readEnvelope();
      if (envelope.kdf.salt !== this.#kdf.salt) {
        throw new Error('The vault password was changed by another process. Unlock it again.');
      }
      const data = normalizeData(open(this.#key, envelope));
      await mutate(data);
      await this.#write(data);
      this.#data = data;
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #assertUnlocked() {
    if (!this.unlocked) throw new Error('The secrets vault is locked.');
  }

  async #readEnvelope() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Vault not found: ${this.filePath}. Run \`npm run nyra -- vault init\`.`);
      throw error;
    }
    const envelope = JSON.parse(raw);
    assertEnvelope(envelope);
    return envelope;
  }

  async #write(data, { exclusive = false } = {}) {
    const envelope = seal(this.#key, this.#kdf, data);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const body = `${JSON.stringify(envelope, null, 2)}\n`;
    if (exclusive) {
      await fs.writeFile(this.filePath, body, { flag: 'wx', mode: 0o600 });
      return;
    }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async #withLock(fn, { timeoutMs = 15_000, staleMs = 60_000 } = {}) {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + timeoutMs;
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(lockPath, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        // Writes take milliseconds; an old lock is left by a killed process.
        if (stat && Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) throw new Error(`Vault is busy (lock: ${lockPath}).`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

function emptyData() {
  return { version: 1, secrets: {} };
}

function normalizeData(data) {
  if (!data || typeof data !== 'object' || typeof data.secrets !== 'object' || data.secrets === null) {
    throw new Error('Vault contents are malformed.');
  }
  return data;
}

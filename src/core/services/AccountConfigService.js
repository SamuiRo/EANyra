/**
 * Validated editing of instance/accounts.json for the web UI.
 *
 * The file stays the source of truth (human-editable, synced to the database
 * on every collection). Every write validates the whole list first and is
 * atomic, so a bad edit can never leave a broken file behind.
 */

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { PATHS } from '../../config/app.config.js';
import { accountKey, normalizeAccount, validateAccounts } from '../../config/accountConfig.js';
import { PLATFORM_IDS } from '../../platforms/catalog.js';

/** Fields the UI may set; anything else in the file is preserved untouched. */
const EDITABLE = ['display_name', 'active', 'archive', 'session', 'bot', 'publish_enabled', 'publish_transport', 'import_file', 'discord_filter'];

export class AccountConfigService {
  constructor({ filePath = PATHS.accountsConfig } = {}) {
    this.filePath = filePath;
  }

  async #read() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`Cannot read ${this.filePath}: ${error.message}`, { cause: error });
    }
  }

  async list() {
    return validateAccounts(await this.#read());
  }

  /**
   * Create or update one account. `originalKey` ("platform/username") renames
   * an existing entry; without it an existing key is updated in place.
   * @returns {Promise<object>} the saved, normalized entry
   */
  async save(input, { originalKey } = {}) {
    if (!input || typeof input !== 'object') throw new Error('An account is required.');
    if (!PLATFORM_IDS.includes(input.platform)) throw new Error(`Unknown platform: ${input.platform}`);
    const username = normalizeAccount(String(input.username ?? ''), input.platform);
    const key = accountKey({ platform: input.platform, username });
    const raw = await this.#read();
    const index = raw.findIndex(entry => {
      try {
        return accountKey({ platform: entry.platform ?? 'twitter', username: normalizeAccount(entry.username, entry.platform ?? 'twitter') }) === (originalKey ?? key);
      } catch {
        return false;
      }
    });
    if (originalKey && index === -1) throw new Error(`${originalKey} is not in accounts.json.`);

    const next = { ...(index >= 0 ? raw[index] : {}), platform: input.platform, username };
    for (const field of EDITABLE) {
      if (!(field in input)) continue;
      const value = input[field];
      // Empty form fields remove the setting (defaults apply).
      if (value === '' || value === null || value === undefined) delete next[field];
      else next[field] = value;
    }
    const updated = [...raw];
    if (index >= 0) updated[index] = next;
    else updated.push(next);
    validateAccounts(updated);   // whole-file check: types, duplicates, platform rules
    await this.#write(updated);
    return validateAccounts([next])[0];
  }

  /** Archive or restore (history is kept either way). */
  async setArchived(key, archived) {
    const entries = await this.list();
    const entry = entries.find(item => accountKey(item) === key);
    if (!entry) throw new Error(`${key} is not in accounts.json.`);
    return this.save({ platform: entry.platform, username: entry.username, archive: archived ? true : null }, { originalKey: key });
  }

  async #write(entries) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { flag: 'wx' });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
}

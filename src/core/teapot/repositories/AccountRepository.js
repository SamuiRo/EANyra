/**
 * src/core/teapot/repositories/AccountRepository.js
 *
 * Responsible for:
 *   - Loading the monitored-accounts list from src/config/accounts.json
 *   - Upserting those accounts into the `accounts` table
 *   - Providing query helpers used by the orchestrator
 */

import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { print } from '../../../shared/utils.js';

const __filename     = fileURLToPath(import.meta.url);
const __dirname      = path.dirname(__filename);
const ACCOUNTS_JSON  = path.resolve(__dirname, '../../../config/accounts.json');

export class AccountRepository {
  /** @param {import('sequelize').ModelStatic} AccountModel */
  constructor(AccountModel) {
    this.Account = AccountModel;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Read accounts.json and upsert every entry into the DB.
   * New accounts are created with is_active = true.
   * Existing accounts have their display_name, platform and is_active refreshed.
   *
   * @returns {Promise<void>}
   */
  async syncFromConfig() {
    const entries = await this.#loadJson();
    print(`Syncing ${entries.length} account(s) from accounts.json…`, 'system');

    for (const entry of entries) {
      await this.Account.upsert({
        username:     entry.username.toLowerCase().replace(/^@/, ''),
        display_name: entry.display_name ?? entry.username,
        platform:     entry.platform ?? 'twitter',
        is_active:    entry.active ?? true,
      });
    }

    print('Account sync complete.', 'success');
  }

  /**
   * Return all accounts that are marked active in the DB.
   * @returns {Promise<import('sequelize').Model[]>}
   */
  async findAllActive() {
    return this.Account.findAll({
      where:   { is_active: true },
      order:   [['username', 'ASC']],
    });
  }

  /**
   * Update last_scraped_at for a single account.
   * @param {number} accountId
   * @param {Date}   timestamp
   */
  async markScraped(accountId, timestamp = new Date()) {
    await this.Account.update(
      { last_scraped_at: timestamp },
      { where: { id: accountId } },
    );
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Read and parse accounts.json; throw a clear error when missing.
   * @returns {Promise<Array<{username: string, display_name?: string, platform?: string, active?: boolean}>>}
   */
  async #loadJson() {
    try {
      const raw = await fs.readFile(ACCOUNTS_JSON, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Cannot load accounts config from ${ACCOUNTS_JSON}: ${error.message}`,
      );
    }
  }
}
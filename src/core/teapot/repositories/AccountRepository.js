/**
 * src/core/teapot/repositories/AccountRepository.js
 *
 * Responsible for:
 *   - Loading the monitored-accounts list from src/config/accounts.json
 *   - Upserting those accounts into the `accounts` table
 *   - Providing query helpers used by the orchestrator
 */

import fs   from 'fs/promises';
import { Op } from 'sequelize';
import { print } from '../../../shared/utils.js';
import { PATHS } from '../../../config/app.config.js';

export class AccountRepository {
  /** @param {import('sequelize').ModelStatic} AccountModel */
  constructor(AccountModel, accountsConfigPath = PATHS.accountsConfig) {
    this.Account            = AccountModel;
    this.accountsConfigPath = accountsConfigPath;
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

    const configuredIds = [];

    for (const entry of entries) {
      const username = entry.username.toLowerCase().replace(/^@/, '');
      const archived = entry.archive === true;

      await this.Account.upsert({
        username,
        display_name: entry.display_name ?? entry.username,
        platform:     entry.platform ?? 'twitter',
        is_active:    archived ? false : (entry.active ?? true),
        is_archived:  archived,
      });

      const account = await this.Account.findOne({ where: { username } });
      configuredIds.push(account.id);
    }

    await this.Account.update(
      { is_active: false, is_archived: true },
      {
        where: configuredIds.length
          ? { id: { [Op.notIn]: configuredIds } }
          : {},
      },
    );

    print('Account sync complete.', 'success');
  }

  /**
   * Return all accounts that are marked active in the DB.
   * @returns {Promise<import('sequelize').Model[]>}
   */
  async findAllActive() {
    return this.Account.findAll({
      where:   { is_active: true, is_archived: false },
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
   * @returns {Promise<Array<{username: string, display_name?: string, platform?: string, active?: boolean, archive?: boolean}>>}
   */
  async #loadJson() {
    try {
      const raw = await fs.readFile(this.accountsConfigPath, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Cannot load accounts config from ${this.accountsConfigPath}: ${error.message}`,
      );
    }
  }
}

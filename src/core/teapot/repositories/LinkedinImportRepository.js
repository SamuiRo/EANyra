/**
 * History of LinkedIn export files per account (table linkedin_imports).
 *
 * status: imported (rows saved), unchanged (same file as the last import,
 * skipped), failed (the file could not be read).
 */

import { QueryTypes } from 'sequelize';

export class LinkedinImportRepository {
  /** @param {import('sequelize').Sequelize} sequelize */
  constructor(sequelize) {
    this.sequelize = sequelize;
  }

  /** Latest successful import of this account, or null. */
  async lastImported(accountId) {
    const [row] = await this.sequelize.query(
      "SELECT * FROM linkedin_imports WHERE account_id = ? AND status = 'imported' ORDER BY imported_at DESC, id DESC LIMIT 1",
      { replacements: [accountId], type: QueryTypes.SELECT },
    );
    return row ?? null;
  }

  async record({ accountId, fileName, sha256, bytes, status, rows = 0, newPosts = 0, conflicts = 0, newestPostAt = null, error = null }) {
    await this.sequelize.query(
      `INSERT INTO linkedin_imports
         (account_id, file_name, sha256, bytes, status, rows, new_posts, conflicts, newest_post_at, error, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [accountId, fileName, sha256, bytes, status, rows, newPosts, conflicts,
          newestPostAt ? new Date(newestPostAt).toISOString() : null, error, new Date().toISOString()],
        type: QueryTypes.INSERT,
      },
    );
  }

  /** @returns {Promise<object[]>} newest first, with the account name */
  async history({ username, limit = 20 } = {}) {
    return this.sequelize.query(
      `SELECT i.id, a.username, i.file_name, i.sha256, i.bytes, i.status, i.rows, i.new_posts, i.conflicts,
              i.newest_post_at, i.error, i.imported_at
       FROM linkedin_imports i JOIN accounts a ON a.id = i.account_id
       ${username ? 'WHERE a.username = ?' : ''}
       ORDER BY i.imported_at DESC, i.id DESC LIMIT ?`,
      { replacements: username ? [username, limit] : [limit], type: QueryTypes.SELECT },
    );
  }

  /**
   * Posts with these LinkedIn ids that already belong to *another* account.
   * @returns {Promise<Map<string, string>>} platform_id → owning username
   */
  async foreignOwners(accountId, platformIds) {
    const owners = new Map();
    const ids = [...new Set(platformIds.map(String))];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await this.sequelize.query(
        `SELECT p.platform_id, a.username FROM posts p JOIN accounts a ON a.id = p.account_id
         WHERE p.platform = 'linkedin' AND p.account_id <> ? AND p.platform_id IN (${chunk.map(() => '?').join(', ')})`,
        { replacements: [accountId, ...chunk], type: QueryTypes.SELECT },
      );
      for (const row of rows) owners.set(String(row.platform_id), row.username);
    }
    return owners;
  }
}

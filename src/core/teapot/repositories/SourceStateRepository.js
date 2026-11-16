/**
 * Durable checkpoints per collection source (table source_state).
 *
 * Example: source "github_readme", key "<user>/<repo>", value = README sha,
 * so the first README seen becomes the baseline for detecting a change.
 */

import { QueryTypes } from 'sequelize';

export class SourceStateRepository {
  /** @param {import('sequelize').Sequelize} sequelize */
  constructor(sequelize) {
    this.sequelize = sequelize;
  }

  /** @returns {Promise<Record<string, string>>} values whose key starts with prefix */
  async getAll(source, prefix = '') {
    const rows = await this.sequelize.query(
      "SELECT key, value FROM source_state WHERE source = ? AND substr(key, 1, ?) = ?",
      { replacements: [source, prefix.length, prefix], type: QueryTypes.SELECT },
    );
    return Object.fromEntries(rows.map(row => [row.key, row.value]));
  }

  async setMany(source, entries) {
    const now = new Date().toISOString();
    for (const [key, value] of entries) {
      await this.sequelize.query(
        `INSERT INTO source_state (source, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(source, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        { replacements: [source, key, value, now] },
      );
    }
  }
}

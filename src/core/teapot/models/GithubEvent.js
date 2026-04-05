import { DataTypes } from 'sequelize';

/**
 * GithubEvent — a single scraped GitHub activity event.
 *
 * event_type values:
 *   release        — a published release/tag
 *   commit_batch   — commits grouped by calendar week
 *   new_repo       — a newly created public repository
 *   readme_change  — README content changed since last scrape
 *
 * Deduplication: event_id is unique.
 * Format: "<type>:<owner>/<repo>:<detail>"
 * Examples:
 *   "release:torvalds/linux:12345678"
 *   "commit_batch:torvalds/linux:2025-W03"
 *   "new_repo:torvalds/linux"
 *   "readme_change:torvalds/linux:<new_sha>"
 */
export function defineGithubEventModel(sequelize) {
  return sequelize.define('GithubEvent', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },

    // Stable unique key — prevents duplicate inserts across runs.
    event_id: {
      type:      DataTypes.STRING(256),
      allowNull: false,
      unique:    true,
    },

    // FK → accounts (platform = 'github')
    account_id: {
      type:      DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'accounts', key: 'id' },
      onDelete:   'CASCADE',
    },

    username: {
      type:      DataTypes.STRING(64),
      allowNull: false,
    },

    repo: {
      type:      DataTypes.STRING(128),
      allowNull: false,
    },

    event_type: {
      type:         DataTypes.ENUM('release', 'commit_batch', 'new_repo', 'readme_change'),
      allowNull:    false,
    },

    title: {
      type:      DataTypes.STRING(512),
      allowNull: false,
    },

    // Release notes, commit message list, etc.
    body: {
      type:         DataTypes.TEXT,
      allowNull:    true,
    },

    url: {
      type:      DataTypes.STRING(512),
      allowNull: true,
    },

    occurred_at: {
      type:      DataTypes.DATE,
      allowNull: true,
    },

    // JSON string — event-type-specific extras.
    // release:      { tag, prerelease }
    // commit_batch: { week, count }
    // readme_change:{ prev_sha, new_sha }
    metadata: {
      type:      DataTypes.TEXT,
      allowNull: true,
      get() {
        const raw = this.getDataValue('metadata');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
      },
      set(value) {
        this.setDataValue(
          'metadata',
          value == null ? null : JSON.stringify(value),
        );
      },
    },

    scraped_at: {
      type:         DataTypes.DATE,
      allowNull:    false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName:   'github_events',
    timestamps:  true,
    underscored: true,
    indexes: [
      { fields: ['account_id'] },
      { fields: ['event_type'] },
      { fields: ['occurred_at'] },
      { fields: ['scraped_at'] },
      // Fast lookup of latest README sha per repo
      { fields: ['username', 'repo', 'event_type'] },
    ],
  });
}
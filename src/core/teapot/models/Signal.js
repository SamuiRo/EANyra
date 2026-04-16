import { DataTypes } from 'sequelize';

/**
 * Signal — raw material for content creation.
 *
 * A signal is anything that is NOT a finished post but could inspire one:
 *   - GitHub activity (releases, commits, new repos, README changes)
 *   - Articles / links you want to write about
 *   - Notes / raw thoughts
 *   - Tool or product reviews
 *   - News items
 *   - Anything else you feed into the pipeline
 *
 * source values: 'github' | 'note' | 'article' | 'tool_review' | 'news' | ...
 *
 * signal_type narrows within a source:
 *   github  → release | commit_batch | new_repo | readme_change
 *   note    → idea | draft | observation
 *   article → read | bookmark
 *   ...     → anything you need
 *
 * Deduplication: source_id is unique per source.
 * Format for github: "<type>:<owner>/<repo>:<detail>"
 * For manual signals (notes, articles): generate a UUID or slug.
 *
 * account_id is nullable — signals not tied to a scraped account
 * (e.g. a note you typed manually) set this to NULL.
 */
export function defineSignalModel(sequelize) {
  return sequelize.define('Signal', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },

    // ── Identity ────────────────────────────────────────────────────────────

    /**
     * Where this signal came from.
     * 'github' | 'note' | 'article' | 'tool_review' | 'news' | ...
     */
    source: {
      type:      DataTypes.STRING(32),
      allowNull: false,
    },

    /**
     * Stable unique key within this source.
     * GitHub: "release:owner/repo:id", "commit_batch:owner/repo:2025-W03", …
     * Notes:  UUID or slug you assign
     * Articles: URL hash or canonical URL
     */
    source_id: {
      type:      DataTypes.STRING(256),
      allowNull: false,
    },

    /**
     * Narrows the signal within its source.
     * github → release | commit_batch | new_repo | readme_change
     * note   → idea | draft | observation
     * ...    → free-form
     */
    signal_type: {
      type:      DataTypes.STRING(64),
      allowNull: false,
    },

    // FK → accounts (nullable — manual signals have no account)
    account_id: {
      type:       DataTypes.INTEGER,
      allowNull:  true,
      references: { model: 'accounts', key: 'id' },
      onDelete:   'SET NULL',
    },

    // ── Content ─────────────────────────────────────────────────────────────

    /** Short headline / summary of the signal. */
    title: {
      type:      DataTypes.STRING(512),
      allowNull: false,
    },

    /**
     * Extended content:
     *   github release  → release notes
     *   commit_batch    → commit messages (one per line)
     *   article / note  → your annotation or the article body
     */
    body: {
      type:      DataTypes.TEXT,
      allowNull: true,
    },

    /** Link to the original source (GitHub release page, article URL, …). */
    url: {
      type:      DataTypes.STRING(512),
      allowNull: true,
    },

    /** When the underlying event happened (not when we recorded it). */
    occurred_at: {
      type:      DataTypes.DATE,
      allowNull: true,
    },

    /**
     * JSON string — source/type-specific extra data.
     * github release:      { tag, prerelease }
     * github commit_batch: { week, count, repo }
     * github readme_change:{ prev_sha, new_sha, repo }
     * github new_repo:     { repo, description }
     * article:             { author, publication }
     * tool_review:         { tool_name, verdict }
     */
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

    // ── Workflow ─────────────────────────────────────────────────────────────

    /**
     * Timestamp of when this signal was first included in a content export.
     * NULL = not yet used for content creation.
     */
    used_for_content: {
      type:         DataTypes.DATE,
      allowNull:    true,
      defaultValue: null,
    },

    scraped_at: {
      type:         DataTypes.DATE,
      allowNull:    false,
      defaultValue: DataTypes.NOW,
    },

  }, {
    tableName:   'signals',
    timestamps:  true,
    underscored: true,
    indexes: [
      // Primary deduplication — source + source_id must be unique
      { unique: true, fields: ['source', 'source_id'] },
      { fields: ['account_id'] },
      { fields: ['source'] },
      { fields: ['signal_type'] },
      { fields: ['occurred_at'] },
      { fields: ['used_for_content'] },
      // Fast README sha lookup
      { fields: ['source', 'signal_type', 'account_id'] },
    ],
  });
}
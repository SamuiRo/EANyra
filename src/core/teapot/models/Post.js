import { DataTypes } from 'sequelize';

/**
 * Post — a published post authored by a monitored account.
 *
 * Covers all publishing platforms: Twitter/X, LinkedIn, Telegram,
 * Bluesky, and any future platforms — one table for all of them.
 *
 * platform values: 'twitter' | 'linkedin' | 'telegram' | 'bluesky' | ...
 *
 * Deduplication: (platform, platform_id) is unique — the same post
 * imported twice (e.g. re-scraping Twitter or re-importing a LinkedIn CSV)
 * will never create a duplicate row.
 *
 * Engagement columns use platform-agnostic names:
 *   likes    — hearts, reactions, likes
 *   reposts  — retweets, reshares, forwards
 *   replies  — comments, replies
 *   views    — impressions (when available)
 */
export function definePostModel(sequelize) {
  return sequelize.define('Post', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },

    // ── Identity ────────────────────────────────────────────────────────────

    /** Which platform this post came from. */
    platform: {
      type:      DataTypes.STRING(32),
      allowNull: false,
    },

    /**
     * The platform's own stable ID for this post.
     * Twitter: tweet_id string
     * LinkedIn: numeric ID extracted from URN
     * Telegram: message_id
     * Bluesky: AT-URI or CID
     */
    platform_id: {
      type:      DataTypes.STRING(128),
      allowNull: false,
    },

    // FK → accounts
    account_id: {
      type:       DataTypes.INTEGER,
      allowNull:  false,
      references: { model: 'accounts', key: 'id' },
      onDelete:   'CASCADE',
    },

    // ── Content ─────────────────────────────────────────────────────────────

    text: {
      type:         DataTypes.TEXT,
      allowNull:    false,
      defaultValue: '',
    },

    lang: {
      type:      DataTypes.STRING(8),
      allowNull: true,
    },

    posted_at: {
      type:      DataTypes.DATE,
      allowNull: true,
    },

    // ── Media ────────────────────────────────────────────────────────────────

    /** JSON array of photo/video URLs: ["https://...", ...] */
    media_urls: {
      type:         DataTypes.TEXT,
      allowNull:    true,
      get() {
        const raw = this.getDataValue('media_urls');
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
      },
      set(value) {
        this.setDataValue('media_urls', JSON.stringify(value ?? []));
      },
    },

    /**
     * For platforms that support sharing external URLs (LinkedIn SharedUrl,
     * Bluesky embeds, etc.).
     */
    shared_url: {
      type:      DataTypes.STRING(512),
      allowNull: true,
    },

    /** Direct permalink to the post on the platform. */
    raw_url: {
      type:      DataTypes.STRING(512),
      allowNull: true,
    },

    // ── Engagement ───────────────────────────────────────────────────────────

    /** Likes / hearts / reactions at time of scrape. */
    likes: {
      type:         DataTypes.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },

    /** Retweets / reshares / forwards at time of scrape. */
    reposts: {
      type:         DataTypes.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },

    /** Replies / comments at time of scrape. */
    replies: {
      type:         DataTypes.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },

    /** Views / impressions (not available on all platforms). */
    views: {
      type:      DataTypes.INTEGER,
      allowNull: true,
    },

    // ── Flags ────────────────────────────────────────────────────────────────

    is_repost: {
      type:         DataTypes.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    },

    is_reply: {
      type:         DataTypes.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    },

    /** Visibility at time of export — e.g. "MEMBER_NETWORK" (LinkedIn). */
    visibility: {
      type:      DataTypes.STRING(64),
      allowNull: true,
    },

    // ── Workflow ─────────────────────────────────────────────────────────────

    /**
     * Timestamp of when this post was first included in a content export.
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
    tableName:   'posts',
    timestamps:  true,
    underscored: true,
    indexes: [
      // Primary deduplication constraint
      { unique: true, fields: ['platform', 'platform_id'] },
      { fields: ['account_id'] },
      { fields: ['platform'] },
      { fields: ['posted_at'] },
      { fields: ['used_for_content'] },
    ],
  });
}
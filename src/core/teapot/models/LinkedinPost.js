import { DataTypes } from 'sequelize';

/**
 * LinkedinPost — a post imported from a LinkedIn CSV export.
 *
 * Fields mirror the columns available in LinkedIn's Shares.csv export.
 * post_id is the numeric ID extracted from the post URN in ShareLink —
 * it is the unique constraint used for deduplication across imports.
 *
 * Visibility values seen in LinkedIn exports: MEMBER_NETWORK
 * (LinkedIn's export does not expose more granular visibility settings.)
 */
export function defineLinkedinPostModel(sequelize) {
  return sequelize.define('LinkedinPost', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },

    // Numeric ID extracted from the post URN — unique, prevents duplicate imports.
    post_id: {
      type:      DataTypes.STRING(64),
      allowNull: false,
      unique:    true,
    },

    // FK → accounts (platform = 'linkedin')
    account_id: {
      type:      DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'accounts', key: 'id' },
      onDelete:   'CASCADE',
    },

    username: {
      type:      DataTypes.STRING(128),
      allowNull: false,
    },

    // Full post commentary text
    text: {
      type:      DataTypes.TEXT,
      allowNull: false,
      defaultValue: '',
    },

    // External URL shared in the post (SharedUrl column), if present
    shared_url: {
      type:      DataTypes.STRING(512),
      allowNull: true,
    },

    // Attached media URL (MediaUrl column), if present
    media_url: {
      type:      DataTypes.STRING(512),
      allowNull: true,
    },

    // Visibility setting at time of export (e.g. "MEMBER_NETWORK")
    visibility: {
      type:      DataTypes.STRING(64),
      allowNull: true,
    },

    // Original publication timestamp (Date column)
    posted_at: {
      type:      DataTypes.DATE,
      allowNull: true,
    },

    // Direct URL to the post on LinkedIn (ShareLink column)
    raw_url: {
      type:      DataTypes.STRING(512),
      allowNull: true,
    },

    scraped_at: {
      type:         DataTypes.DATE,
      allowNull:    false,
      defaultValue: DataTypes.NOW,
    },
    used_for_content: {
    type:      DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
    },
  }, {
    tableName:   'linkedin_posts',
    timestamps:  true,
    underscored: true,
    indexes: [
      { fields: ['account_id'] },
      { fields: ['posted_at'] },
      { fields: ['scraped_at'] },
    ],
  });
}
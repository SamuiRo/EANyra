import { DataTypes } from 'sequelize';

/**
 * Account — a monitored social media account.
 *
 * The `platform` field was added to support multi-platform scraping.
 * Existing rows default to 'twitter' (set in migration / sync fallback).
 *
 * platform values: 'twitter' | 'github'
 */
export function defineAccountModel(sequelize) {
  return sequelize.define('Account', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },
    username: {
      type:      DataTypes.STRING(128),
      allowNull: false,
      unique:    true,
    },
    display_name: {
      type:      DataTypes.STRING(256),
      allowNull: true,
    },
    // ── NEW ──────────────────────────────────────────────────────────────────
    platform: {
      type:         DataTypes.STRING(32),
      allowNull:    false,
      defaultValue: 'twitter',
    },
    // ─────────────────────────────────────────────────────────────────────────
    is_active: {
      type:         DataTypes.BOOLEAN,
      allowNull:    false,
      defaultValue: true,
    },
    last_scraped_at: {
      type:      DataTypes.DATE,
      allowNull: true,
    },
  }, {
    tableName:   'accounts',
    timestamps:  true,
    underscored: true,
    indexes: [
      { fields: ['platform'] },
      { fields: ['is_active'] },
    ],
  });
}
import { DataTypes } from 'sequelize';

/**
 * ScraperRun — audit log entry for each scrape execution.
 *
 * Fields:
 *   id           – auto-increment PK
 *   started_at   – when the run started
 *   finished_at  – when the run ended (null if still running)
 *   status       – 'running' | 'success' | 'partial' | 'failed'
 *   accounts_processed – number of accounts successfully scraped
 *   posts_saved  – total new posts inserted
 *   error_message – top-level error if status === 'failed'
 */
export function defineScraperRunModel(sequelize) {
  return sequelize.define('ScraperRun', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },
    started_at: {
      type:         DataTypes.DATE,
      allowNull:    false,
      defaultValue: DataTypes.NOW,
    },
    finished_at: {
      type:      DataTypes.DATE,
      allowNull: true,
    },
    status: {
      type:         DataTypes.ENUM('running', 'success', 'partial', 'failed'),
      allowNull:    false,
      defaultValue: 'running',
    },
    accounts_processed: {
      type:         DataTypes.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    posts_saved: {
      type:         DataTypes.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    error_message: {
      type:      DataTypes.TEXT,
      allowNull: true,
    },
  }, {
    tableName:   'scraper_runs',
    timestamps:  true,
    underscored: true,
  });
}
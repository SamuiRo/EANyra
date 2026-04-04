import { DataTypes } from 'sequelize';

/**
 * Account — a Twitter/X account to monitor.
 *
 * Fields:
 *   id          – auto-increment PK
 *   username    – Twitter handle without "@" (unique)
 *   display_name – human-readable label (optional)
 *   is_active   – soft-toggle; false = skipped during scrape runs
 *   last_scraped_at – timestamp of the most recent successful scrape
 *   created_at / updated_at – managed by Sequelize
 */
export function defineAccountModel(sequelize) {
  return sequelize.define('Account', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },
    username: {
      type:      DataTypes.STRING(64),
      allowNull: false,
      unique:    true,
      set(value) {
        // Normalize: strip leading "@", lowercase
        this.setDataValue('username', value.replace(/^@/, '').toLowerCase().trim());
      },
    },
    display_name: {
      type:      DataTypes.STRING(128),
      allowNull: true,
    },
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
    tableName:  'accounts',
    timestamps: true,
    underscored: true,
  });
}
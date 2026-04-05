import { DataTypes } from 'sequelize';

/**
 * UserContext — key/value store for user context loaded from YAML files.
 *
 * Fields:
 *   id         – auto-increment PK
 *   key        – dot-separated identifier, e.g. "voice", "bio.twitter", "platforms.linkedin"
 *   value      – JSON-serialised content of the corresponding YAML section
 *   synced_at  – timestamp of last sync from YAML
 */
export function defineUserContextModel(sequelize) {
  return sequelize.define('UserContext', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },
    key: {
      type:      DataTypes.STRING(128),
      allowNull: false,
      unique:    true,
    },
    value: {
      type:      DataTypes.TEXT,
      allowNull: false,
      get() {
        const raw = this.getDataValue('value');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return raw; }
      },
      set(val) {
        this.setDataValue('value', JSON.stringify(val));
      },
    },
    synced_at: {
      type:         DataTypes.DATE,
      allowNull:    false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName:   'user_context',
    timestamps:  false,
    underscored: true,
    indexes: [
      { fields: ['key'] },
    ],
  });
}
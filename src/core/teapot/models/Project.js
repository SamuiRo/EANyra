import { DataTypes } from 'sequelize';

/**
 * Project — metadata for projects loaded from src/context/projects/*.yaml
 *
 * Fields:
 *   id               – auto-increment PK
 *   slug             – unique identifier (from yaml filename / slug field)
 *   name             – human-readable project name
 *   status           – active | paused | archived
 *   description      – full project description text
 *   tech_stack       – JSON array of tech stack items
 *   links            – JSON object { github, website, ... }
 *   content_angles   – JSON array of content angle strings
 *   posting_rules    – JSON array of posting rule strings
 *   synced_at        – timestamp of last sync from YAML
 */
export function defineProjectModel(sequelize) {
  return sequelize.define('Project', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },
    slug: {
      type:      DataTypes.STRING(64),
      allowNull: false,
      unique:    true,
    },
    name: {
      type:      DataTypes.STRING(256),
      allowNull: false,
    },
    status: {
      type:         DataTypes.ENUM('active', 'paused', 'archived'),
      allowNull:    false,
      defaultValue: 'active',
    },
    description: {
      type:      DataTypes.TEXT,
      allowNull: true,
    },
    tech_stack: {
      type:      DataTypes.TEXT,
      allowNull: true,
      get() {
        const raw = this.getDataValue('tech_stack');
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
      },
      set(val) {
        this.setDataValue('tech_stack', JSON.stringify(val ?? []));
      },
    },
    links: {
      type:      DataTypes.TEXT,
      allowNull: true,
      get() {
        const raw = this.getDataValue('links');
        if (!raw) return {};
        try { return JSON.parse(raw); } catch { return {}; }
      },
      set(val) {
        this.setDataValue('links', JSON.stringify(val ?? {}));
      },
    },
    content_angles: {
      type:      DataTypes.TEXT,
      allowNull: true,
      get() {
        const raw = this.getDataValue('content_angles');
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
      },
      set(val) {
        this.setDataValue('content_angles', JSON.stringify(val ?? []));
      },
    },
    posting_rules: {
      type:      DataTypes.TEXT,
      allowNull: true,
      get() {
        const raw = this.getDataValue('posting_rules');
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
      },
      set(val) {
        this.setDataValue('posting_rules', JSON.stringify(val ?? []));
      },
    },
    synced_at: {
      type:         DataTypes.DATE,
      allowNull:    false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName:   'projects',
    timestamps:  false,
    underscored: true,
    indexes: [
      { fields: ['slug'] },
      { fields: ['status'] },
    ],
  });
}
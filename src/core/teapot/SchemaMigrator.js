import { DataTypes, QueryTypes } from 'sequelize';

const MIGRATION_TABLE = 'schema_migrations';

const migrations = [
  {
    name: '20260416_create_initial_schema',
    async up({ queryInterface, transaction }) {
      await createInitialSchema(queryInterface, transaction);
    },
  },
  {
    name: '20260615_add_archive_and_export_columns',
    async up({ queryInterface, transaction }) {
      await addColumnIfMissing(queryInterface, 'accounts', 'is_archived', {
        type:         DataTypes.BOOLEAN,
        allowNull:    false,
        defaultValue: false,
      }, transaction);
      await addColumnIfMissing(queryInterface, 'posts', 'exported_at', {
        type:         DataTypes.DATE,
        allowNull:    true,
        defaultValue: null,
      }, transaction);
      await addColumnIfMissing(queryInterface, 'signals', 'exported_at', {
        type:         DataTypes.DATE,
        allowNull:    true,
        defaultValue: null,
      }, transaction);

      await addIndexIfMissing(queryInterface, 'accounts', 'accounts_is_archived', ['is_archived'], transaction);
      await addIndexIfMissing(queryInterface, 'posts', 'posts_exported_at', ['exported_at'], transaction);
      await addIndexIfMissing(queryInterface, 'signals', 'signals_exported_at', ['exported_at'], transaction);
    },
  },
  {
    name: '20260615_remove_stale_accounts_backup',
    async up({ queryInterface, transaction }) {
      const tables = await queryInterface.showAllTables({ transaction });
      if (tables.includes('accounts') && tables.includes('accounts_backup')) {
        await queryInterface.dropTable('accounts_backup', { transaction });
      }
    },
  },
];

export class SchemaMigrator {
  /** @param {import('sequelize').Sequelize} sequelize */
  constructor(sequelize) {
    this.sequelize = sequelize;
    this.queryInterface = sequelize.getQueryInterface();
  }

  async migrate() {
    await this.#ensureMigrationTable();
    const applied = await this.#appliedMigrationNames();
    const completed = [];

    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;

      await this.sequelize.transaction(async transaction => {
        await migration.up({
          sequelize: this.sequelize,
          queryInterface: this.queryInterface,
          transaction,
        });
        await this.queryInterface.bulkInsert(
          MIGRATION_TABLE,
          [{ name: migration.name, applied_at: new Date().toISOString() }],
          { transaction },
        );
      });
      completed.push(migration.name);
    }

    return completed;
  }

  async #ensureMigrationTable() {
    const tables = await this.queryInterface.showAllTables();
    if (tables.includes(MIGRATION_TABLE)) return;

    await this.queryInterface.createTable(MIGRATION_TABLE, {
      name: {
        type:       DataTypes.STRING(255),
        allowNull:  false,
        primaryKey: true,
      },
      applied_at: {
        type:      DataTypes.DATE,
        allowNull: false,
      },
    });
  }

  async #appliedMigrationNames() {
    const rows = await this.sequelize.query(
      `SELECT name FROM ${MIGRATION_TABLE}`,
      { type: QueryTypes.SELECT },
    );
    return new Set(rows.map(row => row.name));
  }
}

async function addColumnIfMissing(queryInterface, table, column, definition, transaction) {
  const tables = await queryInterface.showAllTables({ transaction });
  if (!tables.includes(table)) return;

  const columns = await queryInterface.describeTable(table, { transaction });
  if (!columns[column]) {
    await queryInterface.addColumn(table, column, definition, { transaction });
  }
}

async function addIndexIfMissing(queryInterface, table, name, fields, transaction, unique = false) {
  const tables = await queryInterface.showAllTables({ transaction });
  if (!tables.includes(table)) return;

  const columns = await queryInterface.describeTable(table, { transaction });
  if (fields.some(field => !columns[field])) return;

  const indexes = await queryInterface.showIndex(table, { transaction });
  if (!indexes.some(index => index.name === name)) {
    await queryInterface.addIndex(table, fields, { name, unique, transaction });
  }
}

async function createInitialSchema(queryInterface, transaction) {
  await createTableIfMissing(queryInterface, 'accounts', {
    id:              primaryKey(),
    username:        { type: DataTypes.STRING(128), allowNull: false, unique: true },
    display_name:    { type: DataTypes.STRING(256), allowNull: true },
    platform:        { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'twitter' },
    is_active:       { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    is_archived:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    last_scraped_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  }, transaction);

  await createTableIfMissing(queryInterface, 'posts', {
    id:               primaryKey(),
    platform:         { type: DataTypes.STRING(32), allowNull: false },
    platform_id:      { type: DataTypes.STRING(128), allowNull: false },
    account_id:       accountReference(false, 'CASCADE'),
    text:             { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    lang:             { type: DataTypes.STRING(8), allowNull: true },
    posted_at:        { type: DataTypes.DATE, allowNull: true },
    media_urls:       { type: DataTypes.TEXT, allowNull: true },
    shared_url:       { type: DataTypes.STRING(512), allowNull: true },
    raw_url:          { type: DataTypes.STRING(512), allowNull: true },
    likes:            { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    reposts:          { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    replies:          { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    views:            { type: DataTypes.INTEGER, allowNull: true },
    is_repost:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    is_reply:         { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    visibility:       { type: DataTypes.STRING(64), allowNull: true },
    used_for_content: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    exported_at:      { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    scraped_at:       { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ...timestamps(),
  }, transaction);

  await createTableIfMissing(queryInterface, 'signals', {
    id:               primaryKey(),
    source:           { type: DataTypes.STRING(32), allowNull: false },
    source_id:        { type: DataTypes.STRING(256), allowNull: false },
    signal_type:      { type: DataTypes.STRING(64), allowNull: false },
    account_id:       accountReference(true, 'SET NULL'),
    title:            { type: DataTypes.STRING(512), allowNull: false },
    body:             { type: DataTypes.TEXT, allowNull: true },
    url:              { type: DataTypes.STRING(512), allowNull: true },
    occurred_at:      { type: DataTypes.DATE, allowNull: true },
    metadata:         { type: DataTypes.TEXT, allowNull: true },
    used_for_content: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    exported_at:      { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    scraped_at:       { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ...timestamps(),
  }, transaction);

  await createTableIfMissing(queryInterface, 'scraper_runs', {
    id:                 primaryKey(),
    started_at:         { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    finished_at:        { type: DataTypes.DATE, allowNull: true },
    status:             { type: DataTypes.ENUM('running', 'success', 'partial', 'failed'), allowNull: false, defaultValue: 'running' },
    accounts_processed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    posts_saved:        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    error_message:      { type: DataTypes.TEXT, allowNull: true },
    ...timestamps(),
  }, transaction);

  await createTableIfMissing(queryInterface, 'user_context', {
    id:        primaryKey(),
    key:       { type: DataTypes.STRING(128), allowNull: false, unique: true },
    value:     { type: DataTypes.TEXT, allowNull: false },
    synced_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, transaction);

  await createTableIfMissing(queryInterface, 'projects', {
    id:             primaryKey(),
    slug:           { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name:           { type: DataTypes.STRING(256), allowNull: false },
    status:         { type: DataTypes.ENUM('active', 'paused', 'archived'), allowNull: false, defaultValue: 'active' },
    description:    { type: DataTypes.TEXT, allowNull: true },
    tech_stack:     { type: DataTypes.TEXT, allowNull: true },
    links:          { type: DataTypes.TEXT, allowNull: true },
    content_angles: { type: DataTypes.TEXT, allowNull: true },
    posting_rules:  { type: DataTypes.TEXT, allowNull: true },
    synced_at:      { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, transaction);

  const indexes = [
    ['accounts', 'accounts_platform', ['platform']],
    ['accounts', 'accounts_is_active', ['is_active']],
    ['accounts', 'accounts_is_archived', ['is_archived']],
    ['posts', 'posts_platform_platform_id', ['platform', 'platform_id'], true],
    ['posts', 'posts_account_id', ['account_id']],
    ['posts', 'posts_platform', ['platform']],
    ['posts', 'posts_posted_at', ['posted_at']],
    ['posts', 'posts_used_for_content', ['used_for_content']],
    ['posts', 'posts_exported_at', ['exported_at']],
    ['signals', 'signals_source_source_id', ['source', 'source_id'], true],
    ['signals', 'signals_account_id', ['account_id']],
    ['signals', 'signals_source', ['source']],
    ['signals', 'signals_signal_type', ['signal_type']],
    ['signals', 'signals_occurred_at', ['occurred_at']],
    ['signals', 'signals_used_for_content', ['used_for_content']],
    ['signals', 'signals_exported_at', ['exported_at']],
    ['signals', 'signals_source_signal_type_account_id', ['source', 'signal_type', 'account_id']],
    ['user_context', 'user_context_key', ['key']],
    ['projects', 'projects_slug', ['slug']],
    ['projects', 'projects_status', ['status']],
  ];

  for (const [table, name, fields, unique = false] of indexes) {
    await addIndexIfMissing(queryInterface, table, name, fields, transaction, unique);
  }
}

async function createTableIfMissing(queryInterface, table, columns, transaction) {
  const tables = await queryInterface.showAllTables({ transaction });
  if (!tables.includes(table)) {
    await queryInterface.createTable(table, columns, { transaction });
  }
}

function primaryKey() {
  return {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  };
}

function accountReference(allowNull, onDelete) {
  return {
    type: DataTypes.INTEGER,
    allowNull,
    references: { model: 'accounts', key: 'id' },
    onDelete,
  };
}

function timestamps() {
  return {
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  };
}

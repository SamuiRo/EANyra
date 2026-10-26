// SQLite must disable foreign keys outside the transaction when rebuilding a
// referenced table. Use one connection throughout, preserving child records.
export async function migrateAccountIdentity(sequelize, migrationName) {
  const connection = await sequelize.connectionManager.getConnection();
  const execute = (sql, params = []) => new Promise((resolve, reject) => {
    connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
  const [{ foreign_keys: foreignKeys }] = await execute('PRAGMA foreign_keys');
  await execute('PRAGMA foreign_keys = OFF');
  try {
    await execute('BEGIN IMMEDIATE');
    // Recheck under the write lock in case another startup just migrated.
    const applied = await execute('SELECT name FROM schema_migrations WHERE name = ?', [migrationName]);
    if (!applied.length) {
      const indexes = await execute("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'accounts' AND sql IS NOT NULL");
      await execute(`CREATE TABLE accounts_identity_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username VARCHAR(128) NOT NULL,
        display_name VARCHAR(256),
        platform VARCHAR(32) NOT NULL DEFAULT 'twitter',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        is_archived TINYINT(1) NOT NULL DEFAULT 0,
        last_scraped_at DATETIME,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`);
      await execute(`INSERT INTO accounts_identity_new
        SELECT id, username, display_name, platform, is_active, is_archived,
               last_scraped_at, created_at, updated_at FROM accounts`);
      await execute('DROP TABLE accounts');
      await execute('ALTER TABLE accounts_identity_new RENAME TO accounts');
      // Discard any explicit legacy unique index over username alone.
      for (const { sql } of indexes) {
        if (/CREATE UNIQUE INDEX/i.test(sql) && /\(\s*[`"\[]?username[`"\]]?\s*\)/i.test(sql)) continue;
        await execute(sql);
      }
      await execute('CREATE UNIQUE INDEX IF NOT EXISTS accounts_platform_username ON accounts (platform, username)');
      const violations = await execute('PRAGMA foreign_key_check');
      if (violations.length) throw new Error('Account migration failed foreign key validation.');
      await execute('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [migrationName, new Date().toISOString()]);
    }
    await execute('COMMIT');
  } catch (error) {
    await execute('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await execute(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    await sequelize.connectionManager.releaseConnection(connection);
  }
}

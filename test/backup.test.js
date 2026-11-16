import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize, QueryTypes } from 'sequelize';

import { createBackup, verifyBackup, restoreBackup } from '../src/core/instance/Backup.js';

const open = [];

async function instance(t, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `eanyra-${name}-`));
  // Windows cannot delete a database file that is still open: close first.
  t.after(async () => {
    await Promise.allSettled(open.splice(0).map(db => db.close()));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const paths = {
    db: path.join(dir, 'data', 'pot.sqlite'), vault: path.join(dir, 'secrets.vault'),
    accounts: path.join(dir, 'accounts.json'), notifications: path.join(dir, 'notifications.json'),
    context: path.join(dir, 'context'), env: path.join(dir, '.env'),
  };
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  return { dir, paths };
}

async function openDb(t, file, { wal = true } = {}) {
  const sequelize = new Sequelize({
    dialect: 'sqlite', storage: file, logging: false,
    ...(wal ? {} : { dialectOptions: { mode: 1 } }),   // 1 = SQLITE_OPEN_READONLY
  });
  open.push(sequelize);
  if (wal) await sequelize.query('PRAGMA journal_mode = WAL');
  return sequelize;
}

test('backup snapshots a live WAL database with the vault, config and context', async t => {
  const { dir, paths } = await instance(t, 'src');
  const sequelize = await openDb(t, paths.db);
  await sequelize.query('CREATE TABLE posts (id INTEGER PRIMARY KEY, text TEXT)');
  await sequelize.query("INSERT INTO posts (text) VALUES ('one'), ('two')");
  await fs.writeFile(paths.vault, '{"format":"eanyra-vault"}');
  await fs.writeFile(paths.accounts, '[]');
  await fs.mkdir(path.join(paths.context, 'personas'), { recursive: true });
  await fs.writeFile(path.join(paths.context, 'voice.yaml'), 'tone: calm\n');
  await fs.writeFile(path.join(paths.context, 'personas', 'brand.yaml'), 'slug: brand\n');
  await fs.writeFile(paths.env, 'GITHUB_TOKEN=plaintext\n');

  const outDir = path.join(dir, 'backups', 'b1');
  const { manifest } = await createBackup({ sequelize, paths, outDir, appVersion: '9.9.9' });
  assert.equal(manifest.database_integrity, 'ok');
  assert.deepEqual(manifest.files.map(file => file.path).sort(),
    ['accounts.json', 'context/personas/brand.yaml', 'context/voice.yaml', 'pot.sqlite', 'secrets.vault']);
  assert.ok(manifest.notes.includes('.env is not included.'));
  await assert.rejects(createBackup({ sequelize, paths, outDir }), /EEXIST/);

  // Read-only: opening with journal_mode = WAL would change the file itself.
  const copy = await openDb(t, path.join(outDir, 'pot.sqlite'), { wal: false });
  assert.equal((await copy.query('SELECT COUNT(*) AS n FROM posts', { type: QueryTypes.SELECT }))[0].n, 2);
  await copy.close();
  assert.equal((await verifyBackup(outDir)).app_version, '9.9.9');

  // Any change to a backed-up file is detected.
  await fs.appendFile(path.join(outDir, 'context', 'voice.yaml'), 'tampered: true\n');
  await assert.rejects(verifyBackup(outDir), /context\/voice\.yaml is missing or changed/);

  const withEnv = await createBackup({ sequelize, paths, outDir: path.join(dir, 'backups', 'b2'), includeEnv: true });
  assert.ok(withEnv.manifest.files.some(file => file.path === '.env'));
});

test('restore verifies first, parks current files including WAL leftovers, and refuses during collection', async t => {
  const source = await instance(t, 'from');
  const sequelize = await openDb(t, source.paths.db);
  await sequelize.query('CREATE TABLE posts (id INTEGER PRIMARY KEY, text TEXT)');
  await sequelize.query("INSERT INTO posts (text) VALUES ('from backup')");
  await fs.writeFile(source.paths.vault, 'vault-from-backup');
  await fs.mkdir(source.paths.context);
  await fs.writeFile(path.join(source.paths.context, 'voice.yaml'), 'tone: backup\n');
  const backupDir = path.join(source.dir, 'backup');
  await createBackup({ sequelize, paths: source.paths, outDir: backupDir });

  const target = await instance(t, 'to');
  await fs.writeFile(target.paths.db, 'current database');
  await fs.writeFile(`${target.paths.db}-wal`, 'stale wal');
  await fs.writeFile(`${target.paths.db}-shm`, 'stale shm');
  await fs.writeFile(target.paths.vault, 'current vault');
  await fs.mkdir(target.paths.context);
  await fs.writeFile(path.join(target.paths.context, 'voice.yaml'), 'tone: current\n');

  await fs.writeFile(`${target.paths.db}.scrape.lock`, '{}');
  await assert.rejects(restoreBackup({ backupDir, paths: target.paths, safetyDir: path.join(target.dir, 'safety') }), /collection is running/);
  await fs.unlink(`${target.paths.db}.scrape.lock`);

  const safetyDir = path.join(target.dir, 'safety');
  const result = await restoreBackup({ backupDir, paths: target.paths, safetyDir });
  assert.deepEqual(result.moved.sort(), ['context', 'pot.sqlite', 'pot.sqlite-shm', 'pot.sqlite-wal', 'secrets.vault']);
  assert.equal(await fs.readFile(target.paths.vault, 'utf8'), 'vault-from-backup');
  assert.equal(await fs.readFile(path.join(target.paths.context, 'voice.yaml'), 'utf8'), 'tone: backup\n');
  assert.equal(await fs.readFile(path.join(safetyDir, 'secrets.vault'), 'utf8'), 'current vault');
  // The old WAL must not be replayed onto the restored database.
  await assert.rejects(fs.access(`${target.paths.db}-wal`));
  const restored = await openDb(t, target.paths.db, { wal: false });
  assert.deepEqual(await restored.query('SELECT text FROM posts', { type: QueryTypes.SELECT }), [{ text: 'from backup' }]);
});

test('a manifest cannot point outside the backup folder', async t => {
  const { dir } = await instance(t, 'evil');
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    format: 'eanyra-backup', version: 1, files: [{ path: '../secrets.vault', sha256: 'x', bytes: 1 }],
  }));
  await assert.rejects(verifyBackup(dir), /Unsafe path/);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'other', version: 1, files: [] }));
  await assert.rejects(verifyBackup(dir), /not an EANyra backup/);
});

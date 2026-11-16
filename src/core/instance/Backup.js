/**
 * Backup and restore of everything an instance needs to come back:
 *
 *   pot.sqlite          consistent online snapshot (VACUUM INTO), integrity-checked
 *   secrets.vault       encrypted logins and tokens (still needs the master password)
 *   accounts.json, notifications.json, context/
 *   .env                only with includeEnv (it may hold plaintext legacy secrets)
 *   manifest.json       SHA-256 and size of every file
 *
 * Not included: the Windows DPAPI "remember" file (bound to this PC and user;
 * run `vault remember` again after a restore), exports, imports, logs.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sqlite3 from 'sqlite3';

const FORMAT = 'eanyra-backup';

/**
 * @param {{ sequelize: import('sequelize').Sequelize, paths: Record<string, string>,
 *           outDir: string, includeEnv?: boolean, appVersion?: string, now?: Date }} opts
 *   paths: { db, vault, accounts, notifications, context, env }
 */
export async function createBackup({ sequelize, paths, outDir, includeEnv = false, appVersion = null, now = new Date() }) {
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(outDir); // refuses to overwrite an existing backup
  const files = [];

  const dbCopy = path.join(outDir, 'pot.sqlite');
  // A transactionally consistent snapshot even while other processes write.
  await sequelize.query(`VACUUM INTO '${dbCopy.replaceAll("'", "''")}'`);
  const integrity = await integrityCheck(dbCopy);
  if (integrity !== 'ok') throw new Error(`The database snapshot failed its integrity check: ${integrity}`);
  files.push('pot.sqlite');

  for (const [key, name] of [['vault', 'secrets.vault'], ['accounts', 'accounts.json'], ['notifications', 'notifications.json'],
    ...(includeEnv ? [['env', '.env']] : [])]) {
    if (await exists(paths[key])) {
      await fs.copyFile(paths[key], path.join(outDir, name));
      files.push(name);
    }
  }
  if (await exists(paths.context)) {
    await fs.cp(paths.context, path.join(outDir, 'context'), { recursive: true });
    for (const file of await listFiles(path.join(outDir, 'context'))) files.push(path.relative(outDir, file).replaceAll('\\', '/'));
  }

  const manifest = {
    format: FORMAT, version: 1, created_at: now.toISOString(), app_version: appVersion,
    database_integrity: integrity,
    files: await Promise.all(files.map(async name => ({ path: name, ...await fingerprint(path.join(outDir, name)) }))),
    notes: [
      ...(files.includes('secrets.vault') ? [
        'secrets.vault is encrypted: restoring it needs the same master password.',
        'Run `npm run nyra -- vault remember` again after restoring on another PC or user.',
      ] : ['No secrets.vault: logins are not part of this backup.']),
      ...(includeEnv ? ['.env is included and may contain plaintext settings or legacy secrets.'] : ['.env is not included.']),
    ],
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: outDir, manifest };
}

/** Check every file of a backup against its manifest. */
export async function verifyBackup(dir) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== FORMAT || manifest.version !== 1) throw new Error(`${dir} is not an EANyra backup.`);
  for (const file of manifest.files) {
    if (file.path.split(/[\\/]/).includes('..') || path.isAbsolute(file.path)) throw new Error(`Unsafe path in manifest: ${file.path}`);
    const actual = await fingerprint(path.join(dir, file.path)).catch(() => null);
    if (!actual || actual.sha256 !== file.sha256) throw new Error(`Backup file ${file.path} is missing or changed.`);
  }
  const integrity = await integrityCheck(path.join(dir, 'pot.sqlite'));
  if (integrity !== 'ok') throw new Error(`The backed-up database fails its integrity check: ${integrity}`);
  return manifest;
}

/**
 * Replace the instance's data with a verified backup. Current files (and the
 * SQLite -wal/-shm files, which must not survive a database swap) are first
 * moved to `safetyDir`. Collection, MCP and the web server must be stopped.
 *
 * @param {{ backupDir: string, paths: Record<string, string>, safetyDir: string, includeEnv?: boolean }} opts
 */
export async function restoreBackup({ backupDir, paths, safetyDir, includeEnv = false }) {
  const manifest = await verifyBackup(backupDir);
  if (await exists(`${paths.db}.scrape.lock`)) {
    throw new Error('A collection is running (scrape lock present). Stop it before restoring.');
  }
  const has = name => manifest.files.some(file => file.path === name);

  await fs.mkdir(safetyDir, { recursive: true });
  const moved = [];
  const park = async (source, name) => {
    if (!await exists(source)) return;
    await fs.rename(source, path.join(safetyDir, name));
    moved.push(name);
  };
  await park(paths.db, 'pot.sqlite');
  await park(`${paths.db}-wal`, 'pot.sqlite-wal');
  await park(`${paths.db}-shm`, 'pot.sqlite-shm');
  if (has('secrets.vault')) await park(paths.vault, 'secrets.vault');
  if (has('accounts.json')) await park(paths.accounts, 'accounts.json');
  if (has('notifications.json')) await park(paths.notifications, 'notifications.json');
  if (manifest.files.some(file => file.path.startsWith('context/'))) await park(paths.context, 'context');
  if (includeEnv && has('.env')) await park(paths.env, '.env');

  const restored = [];
  const put = async (name, target) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(backupDir, name), target);
    restored.push(name);
  };
  await put('pot.sqlite', paths.db);
  if (has('secrets.vault')) await put('secrets.vault', paths.vault);
  if (has('accounts.json')) await put('accounts.json', paths.accounts);
  if (has('notifications.json')) await put('notifications.json', paths.notifications);
  if (manifest.files.some(file => file.path.startsWith('context/'))) {
    await fs.cp(path.join(backupDir, 'context'), paths.context, { recursive: true });
    restored.push('context/');
  }
  if (includeEnv && has('.env')) await put('.env', paths.env);
  return { manifest, moved, restored, safetyDir };
}

async function integrityCheck(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, error => {
      if (error) return reject(error);
      db.get('PRAGMA integrity_check', (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row?.integrity_check ?? 'unknown');
      });
    });
  });
}

async function fingerprint(file) {
  const data = await fs.readFile(file);
  return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else out.push(full);
  }
  return out;
}

export function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

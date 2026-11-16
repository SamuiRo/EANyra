import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeInstance, migrateLegacyInstance } from './InstanceManager.js';
import dotenv from 'dotenv';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: path.join(projectRoot, '.env') });
const instanceDir = path.resolve(projectRoot, process.env.INSTANCE_DIR || 'instance');
const options = { projectRoot, instanceDir };

try {
  const action = process.argv[2];
  if (action === 'restore') {
    await restore(process.argv.slice(3));
    process.exit(process.exitCode ?? 0);
  }
  if (action === 'migrate') {
    const result = await migrateLegacyInstance(options);
    console.log(`Migrated ${result.moved.length} legacy locations into ${instanceDir}.`);
    console.log('Existing credential values and account/context contents were preserved.');
  } else if (action !== 'init') {
    throw new Error('Usage: node src/core/instance/cli.js <init|migrate|restore <backup-dir> [--yes] [--include-env]>');
  }
  const result = await initializeInstance(options);
  console.log(`Instance ready: ${instanceDir} (${result.created.length} missing template files created).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

/** Restore runs without opening the database, which is about to be replaced. */
async function restore(args) {
  const backupDir = args.find(arg => !arg.startsWith('--'));
  if (!backupDir) throw new Error('Usage: npm run instance:restore -- <backup-dir> --yes');
  const { PATHS, DB } = await import('../../config/app.config.js');
  const { verifyBackup, restoreBackup, timestamp } = await import('./Backup.js');
  const manifest = await verifyBackup(path.resolve(backupDir));
  console.log(`Backup from ${manifest.created_at} (EANyra ${manifest.app_version ?? '?'}): ${manifest.files.length} files verified.`);
  if (!args.includes('--yes')) {
    console.log('This replaces the database, vault, accounts, alert settings and context of this instance.');
    console.log('Current files are moved to instance/backups/pre-restore-<time>/ first.');
    console.log('Stop collection, MCP and the web UI, then re-run with --yes.');
    return;
  }
  const result = await restoreBackup({
    backupDir: path.resolve(backupDir),
    safetyDir: path.join(instanceDir, 'backups', `pre-restore-${timestamp()}`),
    includeEnv: args.includes('--include-env'),
    paths: {
      db: DB.storagePath, vault: PATHS.vaultFile, accounts: PATHS.accountsConfig,
      notifications: PATHS.notificationsConfig, context: PATHS.contextDir, env: PATHS.envFile,
    },
  });
  console.log(`Restored: ${result.restored.join(', ')}.`);
  console.log(`Previous files: ${result.safetyDir}`);
  console.log('Run `npm run nyra -- vault remember` again if this PC or user changed.');
}

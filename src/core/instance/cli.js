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
  if (action === 'protect') {
    await protect(process.argv.slice(3));
    process.exit(process.exitCode ?? 0);
  }
  if (action === 'migrate') {
    const result = await migrateLegacyInstance(options);
    console.log(`Migrated ${result.moved.length} legacy locations into ${instanceDir}.`);
    console.log('Existing credential values and account/context contents were preserved.');
  } else if (action !== 'init') {
    throw new Error('Usage: node src/core/instance/cli.js <init|migrate|restore <backup-dir> [--yes] [--include-env]|protect [--status]>');
  }
  const result = await initializeInstance(options);
  console.log(`Instance ready: ${instanceDir} (${result.created.length} missing template files created).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

/**
 * Encrypt the instance folder at rest with Windows EFS. Runs without opening
 * the database: files held open by another process cannot be encrypted.
 */
async function protect(args) {
  const { efsAvailable, protectionStatus, protectInstance } = await import('./fileProtection.js');
  if (!efsAvailable()) {
    console.log('Windows EFS is only available on Windows. Use full-disk encryption instead');
    console.log('(FileVault on macOS, LUKS or fscrypt on Linux) for the instance folder.');
    return;
  }
  const envFile = path.join(projectRoot, '.env');
  const report = async () => {
    const status = await protectionStatus({ instanceDir, envFile });
    console.log(`Encrypted with EFS: ${status.encrypted.length} of ${status.total} file(s) and folder(s).`);
    for (const file of status.plaintext.slice(0, 20)) console.log(`  not encrypted: ${path.relative(projectRoot, file)}`);
    if (status.plaintext.length > 20) console.log(`  … and ${status.plaintext.length - 20} more`);
    return status;
  };
  if (args.includes('--status')) {
    await report();
    return;
  }
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(path.join(instanceDir, 'data')).catch(() => []);
  if (names.some(name => name.endsWith('.scrape.lock'))) {
    throw new Error('A collection is running. Stop collection, MCP and the web UI first (open files cannot be encrypted).');
  }
  console.log(`Encrypting ${instanceDir} and ${envFile} with Windows EFS…`);
  console.log('Stop `npm run serve`, `npm start` and MCP first: files they hold open stay unencrypted.');
  const result = await protectInstance({ instanceDir, envFile });
  for (const line of result.failed) console.log(`  ${line}`);
  const status = await report();
  if (!status.plaintext.length) console.log('Done. New files in instance/ are encrypted automatically.');
  else process.exitCode = 1;
  console.log('');
  console.log('IMPORTANT: back up your EFS certificate once, or a Windows reinstall makes these files unreadable:');
  console.log('  cipher /x "%USERPROFILE%\\Documents\\efs-backup"   (then keep the .pfx and its password safe)');
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

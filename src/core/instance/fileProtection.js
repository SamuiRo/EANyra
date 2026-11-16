/**
 * Encryption at rest for the instance folder with Windows EFS (cipher.exe).
 *
 * EFS encrypts files with a key bound to the Windows user (like DPAPI): the
 * database, context, exports and backups are never stored in plaintext on
 * disk, while EANyra, MCP and the web UI keep working unchanged for that
 * user. Folders are marked so new files are encrypted automatically.
 *
 * Losing the Windows profile without a backup of the EFS certificate makes
 * the files unreadable: export it once with `cipher /x`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const efsAvailable = (platform = process.platform) => platform === 'win32';

/** Run cipher.exe without a shell; resolves with { code, output }. */
export function runCipher(args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('cipher.exe', args, { windowsHide: true });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

/**
 * Parse `cipher /s:<dir>` listings. Only the "X:\...\" directory headers and
 * the E/U markers are used, so localized Windows messages do not matter.
 * @returns {{ path: string, encrypted: boolean }[]}
 */
export function parseCipherListing(output) {
  const entries = [];
  let dir = null;
  for (const raw of String(output).split(/\r?\n/)) {
    const header = raw.match(/([A-Za-z]:\\.*\\)\s*$/);
    if (header && !/^[EU] /.test(raw)) {
      dir = header[1];
      continue;
    }
    const entry = raw.match(/^([EU]) (.+?)\s*$/);
    if (entry && dir) entries.push({ path: path.join(dir, entry[2]), encrypted: entry[1] === 'E' });
  }
  return entries;
}

/**
 * @param {{ instanceDir: string, envFile: string, spawnImpl?: Function }} opts
 * @returns {Promise<{ total: number, encrypted: string[], plaintext: string[] }>}
 */
export async function protectionStatus({ instanceDir, envFile, spawnImpl }) {
  const { output } = await runCipher([`/s:${instanceDir}`], { spawnImpl });
  const entries = parseCipherListing(output);
  if (await exists(envFile)) {
    const env = await runCipher([envFile], { spawnImpl });
    const [entry] = parseCipherListing(env.output);
    entries.push({ path: envFile, encrypted: entry?.encrypted ?? false });
  }
  const files = entries.filter(entry => !isTransient(entry.path));
  return {
    total: files.length,
    encrypted: files.filter(entry => entry.encrypted).map(entry => entry.path),
    plaintext: files.filter(entry => !entry.encrypted).map(entry => entry.path),
  };
}

/**
 * Encrypt the instance folder (recursively, files and folders, marking folders
 * for new files) and the root .env.
 * @returns {Promise<{ ok: boolean, failed: string[], output: string }>}
 */
export async function protectInstance({ instanceDir, envFile, spawnImpl }) {
  const runs = [await runCipher(['/e', '/a', `/s:${instanceDir}`], { spawnImpl })];
  if (await exists(envFile)) runs.push(await runCipher(['/e', '/a', envFile], { spawnImpl }));
  const output = runs.map(run => run.output).join('\n');
  // cipher reports per-file failures such as files open in another process.
  const failed = output.split(/\r?\n/).filter(line => /\[ERR\]|access is denied|being used by another process|error/i.test(line)).map(line => line.trim());
  return { ok: runs.every(run => run.code === 0) && !failed.length, failed, output };
}

/** SQLite side files come and go with the connection. */
function isTransient(file) {
  return /\.(?:sqlite-(?:wal|shm|journal)|lock|tmp)$/.test(file);
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

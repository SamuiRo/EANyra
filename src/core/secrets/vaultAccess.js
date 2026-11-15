/**
 * One process-wide unlocked vault.
 *
 * Unlock order:
 *   1. Key material handed over by the parent process over IPC (workers).
 *   2. EANYRA_MASTER_PASSWORD (removed from the environment after use).
 *   3. "Remember on this device" key protected by Windows DPAPI.
 *   4. Interactive hidden prompt when a terminal is attached.
 *
 * Without a vault file EANyra runs in legacy mode (plaintext .env values).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { PATHS, VAULT } from '../../config/app.config.js';
import { askSecret } from '../../shared/prompt.js';
import { Vault } from './Vault.js';
import { dpapiAvailable, dpapiProtect, dpapiUnprotect } from './dpapi.js';

const REMEMBER_FORMAT = 'eanyra-vault-remember';

let shared = null;
let handedOverKey = null;

export class VaultLockedError extends Error {
  constructor() {
    super(
      'The secrets vault is locked. Run in a terminal to enter the master password, ' +
      'run `npm run nyra -- vault remember` once on this PC, or set EANYRA_MASTER_PASSWORD.',
    );
    this.code = 'VAULT_LOCKED';
  }
}

/** Called by worker processes with the key received over IPC. */
export function useVaultKey(material) {
  handedOverKey = material ?? null;
}

/**
 * @param {{ interactive?: boolean, filePath?: string }} [opts]
 * @returns {Promise<Vault|null>} null when no vault exists (legacy mode)
 */
export async function getVault({ interactive = Boolean(process.stdin.isTTY), filePath = PATHS.vaultFile } = {}) {
  if (shared?.unlocked && shared.filePath === path.resolve(filePath)) return shared;
  const vault = new Vault(filePath);
  if (!await vault.exists()) return null;

  if (handedOverKey) {
    await vault.unlockWithKey(handedOverKey);
    return (shared = vault);
  }

  const envPassword = process.env.EANYRA_MASTER_PASSWORD;
  if (envPassword) {
    delete process.env.EANYRA_MASTER_PASSWORD;
    await vault.unlock(envPassword);
    return (shared = vault);
  }

  const remembered = await readRememberedKey().catch(() => null);
  if (remembered) {
    try {
      await vault.unlockWithKey(remembered);
      return (shared = vault);
    } catch {
      // Stale after a password change: fall through to the prompt.
    }
  }

  if (!interactive) throw new VaultLockedError();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const password = await askSecret('Master password: ');
    try {
      await vault.unlock(password);
      return (shared = vault);
    } catch (error) {
      if (error.code !== 'VAULT_DECRYPT_FAILED' || attempt === 3) throw error;
      process.stderr.write('Wrong master password, try again.\n');
    }
  }
  throw new VaultLockedError();
}

/**
 * Unlock with a password supplied by a front end (web login) and make it the
 * process-wide vault. Throws VaultDecryptError on a wrong password.
 */
export async function unlockSharedVault(password, { filePath = PATHS.vaultFile } = {}) {
  const vault = new Vault(filePath);
  if (!await vault.exists()) return null;
  await vault.unlock(password);
  if (shared !== vault) shared?.lock();
  shared = vault;
  return vault;
}

/** Key material for a worker process, or null in legacy mode. */
export async function vaultKeyForWorker(opts) {
  const vault = await getVault({ interactive: false, ...opts });
  return vault ? vault.exportKey() : null;
}

export function forgetUnlockedVault() {
  shared?.lock();
  shared = null;
}

// ── Remember on this device (Windows DPAPI) ──────────────────────────────────

export async function rememberVaultKey(vault, filePath = VAULT.rememberFile) {
  if (!dpapiAvailable()) {
    throw new Error('Remembering the vault key needs Windows DPAPI. Elsewhere, unlock interactively or use EANYRA_MASTER_PASSWORD.');
  }
  const { key, salt } = vault.exportKey();
  const record = { format: REMEMBER_FORMAT, version: 1, salt, protected: await dpapiProtect(key) };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export async function forgetVaultKey(filePath = VAULT.rememberFile) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function isVaultKeyRemembered(filePath = VAULT.rememberFile) {
  return fs.access(filePath).then(() => true, () => false);
}

async function readRememberedKey(filePath = VAULT.rememberFile) {
  if (!dpapiAvailable()) return null;
  const record = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (record.format !== REMEMBER_FORMAT || record.version !== 1) return null;
  return { key: await dpapiUnprotect(record.protected), salt: record.salt };
}

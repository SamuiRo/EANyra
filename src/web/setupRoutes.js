/**
 * First run from the browser: create the encrypted vault.
 *
 * Without a vault the web UI is entered with the one-time token printed in
 * the terminal (so only someone at this PC can do this). Creating the vault
 * imports any plaintext secrets from the root .env (like `vault init`),
 * unlocks it for this process and switches the login to the master password.
 */

import { PATHS } from '../config/app.config.js';
import { Vault } from '../core/secrets/Vault.js';
import { assertPasswordStrength } from '../core/secrets/crypto.js';
import { importLegacySecrets } from '../core/secrets/migrateLegacy.js';
import { rememberVaultKey, unlockSharedVault } from '../core/secrets/vaultAccess.js';
import { dpapiAvailable } from '../core/secrets/dpapi.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * @param {{ onCreated: () => void, vaultFile?: string,
 *           importLegacy?: (vault: Vault) => Promise<string[]>,
 *           keyStore?: { available: () => boolean, remember: (vault: Vault) => Promise<unknown> } }} deps
 */
export function buildSetupRoutes({ onCreated, vaultFile = PATHS.vaultFile, importLegacy = importLegacySecrets,
  keyStore = { available: dpapiAvailable, remember: rememberVaultKey } }) {
  let busy = false;
  return {
    'POST /api/setup/vault': async ({ body }) => {
      if (busy) throw fail(409, 'The vault is being created.');
      busy = true;
      try {
        const store = new Vault(vaultFile);
        if (await store.exists()) throw fail(409, 'The vault already exists. Log in with the master password.');
        try {
          assertPasswordStrength(body.password);
        } catch (error) {
          throw fail(400, error.message);
        }
        if (body.password !== body.repeat) throw fail(400, 'The passwords do not match.');
        await store.create(body.password);
        const unlocked = await unlockSharedVault(body.password, { filePath: vaultFile });
        const imported = await importLegacy(unlocked).catch(() => []);
        let remembered = false;
        if (body.remember === true && keyStore.available()) {
          await keyStore.remember(unlocked);
          remembered = true;
        }
        onCreated();
        return { created: true, imported, remembered };
      } finally {
        busy = false;
      }
    },
  };
}

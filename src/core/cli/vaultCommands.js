/**
 * eanyra vault    init | status | migrate | change-password | remember | forget
 * eanyra secrets  set <kind> [name] | list | delete <kind> <name>
 * eanyra sessions                       which logins accounts use and their state
 */

import fs from 'node:fs/promises';

import { randomBytes } from 'node:crypto';
import { PATHS, VAULT, WEB } from '../../config/app.config.js';
import { validateAccounts, DEFAULT_SESSION } from '../../config/accountConfig.js';
import { askSecret, askText } from '../../shared/prompt.js';
import { print } from '../../shared/utils.js';
import { SECRET_KINDS, Vault, assertSessionName } from '../secrets/Vault.js';
import { assertPasswordStrength } from '../secrets/crypto.js';
import {
  forgetVaultKey,
  getVault,
  isVaultKeyRemembered,
  rememberVaultKey,
} from '../secrets/vaultAccess.js';
import { dpapiAvailable } from '../secrets/dpapi.js';
import { sessionReport } from '../secrets/sessionReport.js';

export { sessionReport };
import {
  findLegacyPlaintext,
  importLegacySecrets,
  purgeLegacyPlaintext,
} from '../secrets/migrateLegacy.js';

async function requireVault() {
  const vault = await getVault();
  if (!vault) throw new Error('No vault yet. Run `npm run nyra -- vault init` first.');
  return vault;
}

async function askNewPassword() {
  const password = await askSecret('New master password (min 10 characters): ');
  assertPasswordStrength(password);
  if (password !== await askSecret('Repeat the master password: ')) throw new Error('Passwords do not match.');
  return password;
}

async function confirm(question) {
  return /^y(es)?$/i.test(await askText(`${question} [y/N] `));
}

function describePlaintext(found) {
  for (const item of found) {
    print(`  ${item.path}${item.keys ? ` (${item.keys.join(', ')})` : ''}`, 'warning');
  }
}

export function registerVaultCommands(program) {
  const vault = program.command('vault').description('Encrypted storage for all logins and tokens (master password)');

  vault.command('init')
    .description('Create the encrypted vault and import existing plaintext secrets')
    .action(async () => {
      const store = new Vault(PATHS.vaultFile);
      if (await store.exists()) throw new Error(`Vault already exists: ${store.filePath}`);
      print('The master password cannot be recovered. Store it in your password manager.', 'warning');
      await store.create(await askNewPassword());
      print(`Vault created: ${store.filePath}`, 'success');
      await migrate(store, { purge: false });
      if (dpapiAvailable() && await confirm('Remember the vault on this PC (Windows DPAPI) so MCP and the scheduler can unlock it?')) {
        print(`Saved: ${await rememberVaultKey(store)}`, 'success');
      }
    });

  vault.command('status')
    .description('Show vault state, stored secrets and remaining plaintext credentials')
    .action(async () => {
      const store = new Vault(PATHS.vaultFile);
      if (!await store.exists()) {
        print('No vault: credentials are read from the plaintext root .env (legacy mode).', 'warning');
        print('Run `npm run nyra -- vault init` to encrypt them.', 'info');
        return;
      }
      print(`Vault: ${store.filePath}`, 'info');
      print(`Remembered on this PC: ${await isVaultKeyRemembered() ? `yes (${VAULT.rememberFile})` : 'no'}`, 'info');
      const unlocked = await requireVault();
      const secrets = unlocked.list();
      print(`${secrets.length} secret(s):`, 'info');
      for (const item of secrets) print(`  ${item.kind}/${item.name}  · updated ${item.updated_at}`, 'data');
      const leftovers = await findLegacyPlaintext();
      if (leftovers.length) {
        print('Plaintext credentials still on disk (remove with `vault migrate --purge`):', 'warning');
        describePlaintext(leftovers);
      }
    });

  vault.command('migrate')
    .description('Import plaintext .env secrets, cookie cache and X profile into the vault')
    .option('--purge', 'After importing, blank the .env secrets and delete the plaintext cookie files and X profile')
    .option('-y, --yes', 'Do not ask for confirmation before purging')
    .action(async options => {
      await migrate(await requireVault(), options);
    });

  vault.command('change-password')
    .description('Re-encrypt the vault with a new master password')
    .action(async () => {
      const store = await requireVault();
      await store.changePassword(await askNewPassword());
      const remembered = await isVaultKeyRemembered();
      if (remembered) await rememberVaultKey(store);
      print(`Master password changed${remembered ? '; the remembered key on this PC was refreshed' : ''}.`, 'success');
    });

  vault.command('remember')
    .description('Let background processes on this PC unlock the vault (Windows DPAPI, current OS user)')
    .action(async () => {
      print(`Saved: ${await rememberVaultKey(await requireVault())}`, 'success');
      print('MCP, the scheduler and scrape workers on this PC can now unlock without the password.', 'info');
    });

  vault.command('forget')
    .description('Remove the remembered vault key from this PC')
    .action(async () => {
      print(await forgetVaultKey() ? 'Remembered key removed.' : 'No remembered key on this PC.', 'success');
    });

  const secrets = program.command('secrets').description('Manage tokens and API keys in the vault');

  secrets.command('set <kind> [name]')
    .description(`Store a token. Kinds: github, telegram-bot, discord-bot, telegram-api. X and Telegram user logins: use npm run login / login:telegram`)
    .action(async (kind, name = DEFAULT_SESSION) => {
      assertSessionName(name);
      const store = await requireVault();
      if (kind === 'github' || kind === 'telegram-bot' || kind === 'discord-bot') {
        const token = (await askSecret(`${kind} token for "${name}": `)).trim();
        if (!token) throw new Error('Token cannot be empty.');
        await store.set(kind, name, { token });
      } else if (kind === 'telegram-api') {
        const apiId = Number(await askText('Telegram api_id: '));
        if (!Number.isInteger(apiId) || apiId <= 0) throw new Error('api_id must be a positive integer.');
        const apiHash = (await askSecret('Telegram api_hash: ')).trim();
        if (!/^[a-f0-9]{32}$/i.test(apiHash)) throw new Error('api_hash must be 32 hexadecimal characters.');
        await store.set(kind, name, { api_id: apiId, api_hash: apiHash });
      } else if (kind === 'twitter') {
        throw new Error(`Use \`npm run login -- --session ${name}\` or \`npm run import-cookies -- --session ${name}\`.`);
      } else if (kind === 'telegram') {
        throw new Error(`Use \`npm run login:telegram -- --session ${name}\`.`);
      } else {
        throw new Error(`Unknown kind "${kind}". Known: ${Object.keys(SECRET_KINDS).join(', ')}`);
      }
      print(`Stored ${kind}/${name} in the encrypted vault.`, 'success');
    });

  secrets.command('list')
    .description('List stored secrets (names only, never values)')
    .action(async () => {
      for (const item of (await requireVault()).list()) {
        print(`${item.kind}/${item.name}  · ${SECRET_KINDS[item.kind] ?? ''} · updated ${item.updated_at}`, 'data');
      }
    });

  secrets.command('delete <kind> <name>')
    .description('Delete one secret (e.g. a session you no longer use)')
    .action(async (kind, name) => {
      const removed = await (await requireVault()).delete(kind, name);
      print(removed ? `Deleted ${kind}/${name}.` : `${kind}/${name} was not stored.`, removed ? 'success' : 'warning');
    });

  const mcp = program.command('mcp').description('MCP access for AI clients');
  mcp.command('token')
    .description('Create (or show) the token MCP clients send to `npm run serve` at /mcp')
    .option('--rotate', 'Replace the token; clients using the old one stop working')
    .action(async options => {
      const store = await requireVault();
      let token = store.get('mcp-token', DEFAULT_SESSION)?.token;
      if (!token || options.rotate) {
        token = randomBytes(32).toString('base64url');
        await store.set('mcp-token', DEFAULT_SESSION, { token });
        print(options.rotate ? 'MCP token rotated.' : 'MCP token created.', 'success');
      }
      print('Configure your MCP client with this header (keep it secret):', 'info');
      process.stdout.write(`\n  Authorization: Bearer ${token}\n\n`);
      print(`Endpoint: http://127.0.0.1:${WEB.port}/mcp while \`npm run serve\` runs.`, 'info');
    });

  program.command('sessions')
    .description('Show which login each account uses and whether it is configured')
    .action(async () => {
      const entries = validateAccounts(JSON.parse(await fs.readFile(PATHS.accountsConfig, 'utf8')))
        .filter(entry => entry.archive !== true && entry.active !== false);
      const store = await getVault();
      const rows = sessionReport(entries, store);
      if (!store) print('Legacy mode (no vault): only the "default" session from .env is available.', 'warning');
      for (const row of rows) {
        const level = row.ok ? 'success' : 'warning';
        print(`${row.kind}/${row.name}  ${row.state}  ← ${row.accounts.join(', ') || '(unused)'}`, level);
      }
    });
}

async function migrate(store, { purge = false, yes = false } = {}) {
  const imported = await importLegacySecrets(store);
  if (imported.length) {
    print('Imported into the vault:', 'success');
    for (const line of imported) print(`  ${line}`, 'data');
  } else {
    print('Nothing new to import.', 'info');
  }
  const leftovers = await findLegacyPlaintext();
  if (!leftovers.length) return;
  if (!purge) {
    print('Plaintext copies remain. After checking that `npm run scrape` works, remove them with:', 'warning');
    describePlaintext(leftovers);
    print('  npm run nyra -- vault migrate --purge', 'info');
    return;
  }
  print('This will blank these .env values and delete these plaintext files:', 'warning');
  describePlaintext(leftovers);
  if (!yes && !await confirm('Continue?')) {
    print('Purge cancelled.', 'info');
    return;
  }
  await purgeLegacyPlaintext(leftovers);
  print('Plaintext credentials removed.', 'success');
}

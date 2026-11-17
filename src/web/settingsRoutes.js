/**
 * Web routes for settings and operations (tab «Налаштування»):
 * problem alerts, LinkedIn export upload, backups, EFS status, vault
 * (remember on this PC, change password) and the MCP token.
 *
 * Secrets stay write-only, with one deliberate exception: the MCP token is
 * returned once when created or rotated, because it must be copied into the
 * AI client's configuration.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { DB, INSTANCE_DIR, LINKEDIN, PATHS, PKG } from '../config/app.config.js';
import { validateAccounts, normalizeAccount } from '../config/accountConfig.js';
import { loadNotifyConfig, updateNotifyConfig, DEFAULT_RULES } from '../config/notifyConfig.js';
import { parseCsvString } from '../platforms/linkedin/csvParser.js';
import { createBackup, timestamp } from '../core/instance/Backup.js';
import { efsAvailable, protectionStatus } from '../core/instance/fileProtection.js';
import { Vault } from '../core/secrets/Vault.js';
import { assertPasswordStrength } from '../core/secrets/crypto.js';
import { forgetVaultKey, getVault, isVaultKeyRemembered, rememberVaultKey } from '../core/secrets/vaultAccess.js';
import { dpapiAvailable } from '../core/secrets/dpapi.js';
import { assertDiscordWebhook, telegramChatsOf } from '../core/notify/channels.js';
import { LinkedinImportRepository } from '../core/teapot/repositories/LinkedinImportRepository.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * @param {{ hasVault: boolean, sequelize?: import('sequelize').Sequelize, jobs: object,
 *           backupsDir?: string, efs?: { available: () => boolean, status: Function },
 *           notifyFile?: string, accountsFile?: string, importsDir?: string, fetchImpl?: typeof fetch,
 *           vaultFile?: string, keyStore?: object }} deps  every path is injectable so tests never touch the real instance
 */
export function buildSettingsRoutes({ hasVault, sequelize, jobs, backupsDir = path.join(INSTANCE_DIR, 'backups'),
  efs = { available: efsAvailable, status: protectionStatus }, notifyFile, accountsFile = PATHS.accountsConfig, importsDir = LINKEDIN.importsDir,
  fetchImpl = fetch, vaultFile = PATHS.vaultFile,
  keyStore = { available: dpapiAvailable, isRemembered: isVaultKeyRemembered, remember: rememberVaultKey, forget: forgetVaultKey } }) {
  const openVault = () => getVault({ interactive: false, filePath: vaultFile }).catch(() => null);
  const vault = async () => {
    const unlocked = await openVault();
    if (!unlocked) throw fail(409, hasVault ? 'The vault is locked. Log in again.' : 'Create the vault first: npm run nyra -- vault init.');
    return unlocked;
  };
  const checkPassword = async password => {
    try {
      await new Vault(vaultFile).unlock(String(password ?? ''));
    } catch {
      throw fail(403, 'Wrong master password.');
    }
  };
  const notifyPath = notifyFile ? [notifyFile] : [];

  return {
    'GET /api/settings': async () => {
      const config = await loadNotifyConfig(...notifyPath).catch(error => ({ error: error.message }));
      const unlocked = await openVault();
      const backups = await listBackups(backupsDir);
      const linkedin = validateAccounts(JSON.parse(await fs.readFile(accountsFile, 'utf8').catch(() => '[]')))
        .filter(entry => entry.platform === 'linkedin' && entry.archive !== true)
        .map(entry => ({ username: entry.username, import_file: entry.import_file ?? LINKEDIN.sharesFile }));
      return {
        version: PKG.version,
        notify: config?.error ? { error: config.error } : {
          configured: Boolean(config),
          telegram: config?.telegram ?? null,
          discord: config?.discord ? { ...config.discord, webhook_set: Boolean(unlocked?.get('discord-webhook', config.discord.webhook)) } : null,
          rules: config?.rules ?? { ...DEFAULT_RULES },
        },
        vault: {
          encrypted: hasVault, unlocked: Boolean(unlocked), dpapi: keyStore.available(),
          remembered: hasVault ? await keyStore.isRemembered() : false,
          mcp_token: Boolean(unlocked?.get('mcp-token', 'default')),
        },
        efs: efs.available() ? await efs.status({ instanceDir: INSTANCE_DIR, envFile: PATHS.envFile })
          .then(s => ({ available: true, total: s.total, encrypted: s.encrypted.length, plaintext: s.plaintext.slice(0, 10).map(p => path.relative(INSTANCE_DIR, p) || p) }))
          .catch(error => ({ available: true, error: error.message })) : { available: false },
        backups,
        linkedin: {
          accounts: linkedin,
          history: sequelize ? await new LinkedinImportRepository(sequelize).history({ limit: 10 }) : [],
        },
      };
    },

    // ── Problem alerts ────────────────────────────────────────────────────
    'POST /api/settings/notify': async ({ body }) => {
      const change = {};
      const current = await loadNotifyConfig(...notifyPath);
      if (body.telegram !== undefined) change.telegram = body.telegram ? { ...(current?.telegram ?? {}), ...body.telegram } : null;
      if (body.discord !== undefined) change.discord = body.discord ? { ...(current?.discord ?? {}), ...body.discord } : null;
      if (body.rules !== undefined) change.rules = { ...(current?.rules ?? {}), ...body.rules };
      try {
        await updateNotifyConfig(change, ...notifyPath);
      } catch (error) {
        throw fail(400, error.message);
      }
      return { saved: true };
    },
    'POST /api/settings/notify/telegram-chats': async ({ body }) => {
      const token = (await vault()).get('telegram-bot', String(body.bot || 'default'))?.token;
      if (!token) throw fail(400, `No token for bot "${body.bot || 'default'}": set it in «Акаунти» → «Нова сесія» → Telegram-бот.`);
      const chats = await telegramChatsOf(token, fetchImpl).catch(error => { throw fail(502, error.message); });
      if (!chats.length) throw fail(404, 'The bot has no messages yet: open your bot in Telegram, press Start, then try again.');
      return { chats };
    },
    'POST /api/settings/notify/discord-webhook': async ({ body }) => {
      const url = String(body.url ?? '').trim();
      try {
        assertDiscordWebhook(url);
      } catch (error) {
        throw fail(400, error.message);
      }
      const name = String(body.name || 'default');
      await (await vault()).set('discord-webhook', name, { url });
      await updateNotifyConfig({ discord: { enabled: true, webhook: name } }, ...notifyPath);
      return { saved: true };
    },

    // ── LinkedIn export upload ────────────────────────────────────────────
    'POST /api/settings/linkedin/upload': async ({ body }) => {
      const username = normalizeAccount(String(body.account ?? ''), 'linkedin');
      const entry = validateAccounts(JSON.parse(await fs.readFile(accountsFile, 'utf8')))
        .find(item => item.platform === 'linkedin' && item.username === username && item.archive !== true);
      if (!entry) throw fail(404, `linkedin/${username} is not an active account.`);
      const content = String(body.content ?? '');
      const header = parseCsvString(content.split(/\r?\n/).slice(0, 2).join('\n'))[0] ?? {};
      for (const column of ['Date', 'ShareLink']) {
        if (!(column in header)) throw fail(400, `This is not a LinkedIn Shares.csv (missing the ${column} column).`);
      }
      await fs.mkdir(importsDir, { recursive: true });
      const target = path.join(importsDir, entry.import_file ?? LINKEDIN.sharesFile);
      await fs.writeFile(target, content);
      const job = await jobs.start({ platform: 'linkedin', accounts: [username] });
      return { saved: path.basename(target), job };
    },

    // ── Backups ───────────────────────────────────────────────────────────
    'POST /api/settings/backup': async ({ body }) => {
      if (!sequelize) throw fail(501, 'Backups are not available in this process.');
      const outDir = path.join(backupsDir, `eanyra-${timestamp()}`);
      const { manifest } = await createBackup({
        sequelize, outDir, includeEnv: body.include_env === true, appVersion: PKG.version,
        paths: {
          db: DB.storagePath, vault: PATHS.vaultFile, accounts: PATHS.accountsConfig,
          notifications: PATHS.notificationsConfig, context: PATHS.contextDir, env: PATHS.envFile,
        },
      });
      return { dir: outDir, files: manifest.files.length, bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0), notes: manifest.notes };
    },

    // ── Vault ─────────────────────────────────────────────────────────────
    'POST /api/settings/vault/remember': async () => {
      if (!keyStore.available()) throw fail(400, 'Remembering the vault needs Windows (DPAPI).');
      await keyStore.remember(await vault());
      return { remembered: true };
    },
    'POST /api/settings/vault/forget': async () => ({ removed: await keyStore.forget() }),
    'POST /api/settings/vault/password': async ({ body }) => {
      await checkPassword(body.current);
      try {
        assertPasswordStrength(body.next);
      } catch (error) {
        throw fail(400, error.message);
      }
      if (body.next !== body.repeat) throw fail(400, 'The new passwords do not match.');
      const unlocked = await vault();
      await unlocked.changePassword(body.next);
      const remembered = await keyStore.isRemembered();
      if (remembered && keyStore.available()) await keyStore.remember(unlocked);
      return { changed: true, remembered_refreshed: remembered };
    },

    // ── MCP token (shown once) ────────────────────────────────────────────
    'POST /api/settings/mcp-token': async ({ body }) => {
      const unlocked = await vault();
      const existing = unlocked.get('mcp-token', 'default')?.token;
      if (existing && body.rotate !== true) throw fail(409, 'A token exists. Rotate it to get a new one (the old one stops working).');
      const token = randomBytes(32).toString('base64url');
      await unlocked.set('mcp-token', 'default', { token });
      return { token, header: `Authorization: Bearer ${token}` };
    },
  };
}

async function listBackups(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  const backups = [];
  for (const name of names.sort().reverse()) {
    const manifest = await fs.readFile(path.join(dir, name, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (!manifest) continue;
    backups.push({
      name, created_at: manifest.created_at, version: manifest.app_version,
      files: manifest.files.length, bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
    });
    if (backups.length >= 10) break;
  }
  return backups;
}

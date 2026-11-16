/**
 * `eanyra serve`: the local web UI, its API and optionally the scheduler, in
 * one process. Collection and publishing run in the same worker processes the
 * MCP server uses, so CLI, MCP and the browser share one job table.
 */

import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { PATHS, PKG, WEB } from '../config/app.config.js';
import { validateAccounts } from '../config/accountConfig.js';
import { PLATFORM_CATALOG } from '../platforms/catalog.js';
import { ScrapeJobs } from '../core/mcp/ScrapeJobs.js';
import { TelegramPublishRequests } from '../core/mcp/TelegramPublishRequests.js';
import { buildTools } from '../core/mcp/toolRegistry.js';
import { createContentService } from '../core/mcp/tools/content.js';
import * as mcpDb from '../core/mcp/db.js';
import { Vault, SECRET_KINDS, assertSessionName } from '../core/secrets/Vault.js';
import { getVault, unlockSharedVault } from '../core/secrets/vaultAccess.js';
import { sessionReport } from '../core/cli/vaultCommands.js';
import { Scheduler } from '../core/scheduler/Scheduler.js';
import { mcpExecutor } from '../core/services/sql.js';
import { UserContextRepository } from '../core/teapot/repositories/UserContextRepository.js';
import { print } from '../shared/utils.js';
import { WebAuth, tokenVerifier } from './auth.js';
import { createWebServer } from './server.js';
import { createMcpServer, McpHttpSessions } from '../core/mcp/mcpServer.js';
import { Credentials } from '../core/secrets/Credentials.js';
import { loadNotifyConfig } from '../config/notifyConfig.js';
import { buildChannels, runProblemChecks } from '../core/notify/index.js';
import { AccountConfigService } from '../core/services/AccountConfigService.js';
import { ContextFileService } from '../core/services/ContextFileService.js';
import { SessionLogins } from '../core/services/SessionLogins.js';
import { PLATFORM_CATALOG as CATALOG } from '../platforms/catalog.js';

/**
 * @param {{ host?: string, port?: number, schedule?: boolean, mcp?: boolean,
 *           models?: { UserContext: object, Project: object } }} [opts]
 *   models enables "sync context" from the browser (YAML → database).
 *   mcp mounts the MCP server at /mcp (Bearer token from `eanyra mcp token`).
 */
export async function startWebServer({ host = WEB.host, port = WEB.port, schedule = false, mcp = false, models } = {}) {
  const hasVault = await new Vault(PATHS.vaultFile).exists();
  let token = null;
  const auth = new WebAuth({
    verifyPassword: hasVault
      ? async password => Boolean(await unlockSharedVault(password))
      : tokenVerifier(token = randomBytes(18).toString('base64url')),
  });

  const jobs = new ScrapeJobs({ source: 'web' });
  const publications = new TelegramPublishRequests();
  const db = mcpExecutor(mcpDb);
  const content = createContentService();

  const accountsFile = new AccountConfigService();
  const contextFiles = new ContextFileService();
  const syncContext = async () => {
    if (!models) return null;
    const { updated, skipped, errors, warnings } = await new UserContextRepository(models).sync();
    return { updated, skipped, errors, warnings };
  };
  // Logins and secrets need the vault (unlocked by the web login).
  const vaultCredentials = async () => {
    const vault = await getVault({ interactive: false }).catch(() => null);
    if (!vault) {
      throw Object.assign(new Error(hasVault
        ? 'The vault is locked. Log in again.'
        : 'Create the encrypted vault first: npm run nyra -- vault init (then restart npm run serve).'), { status: 409 });
    }
    return new Credentials({ vault });
  };
  const logins = new SessionLogins({ getCredentials: vaultCredentials });
  const assertPassword = async password => {
    if (!hasVault) return;
    try {
      await new Vault(PATHS.vaultFile).unlock(String(password ?? ''));
    } catch {
      // 403, not 401: a wrong confirmation must not end the browser session.
      throw Object.assign(new Error('Wrong master password.'), { status: 403 });
    }
  };
  const SETTABLE = { 'github': 'token', 'telegram-bot': 'token', 'discord-bot': 'token' };

  const routes = {
    // ── Accounts (accounts.json) ──────────────────────────────────────────
    'GET /api/accounts/config': async () => ({
      accounts: await accountsFile.list(),
      platforms: Object.values(CATALOG).map(({ id, displayName, session }) => ({ id, displayName, session })),
    }),
    'POST /api/accounts/save': async ({ body }) => accountsFile.save(body.account ?? {}, { originalKey: body.original_key || undefined }),
    'POST /api/accounts/archive': async ({ body }) => accountsFile.setArchived(String(body.key ?? ''), body.archived !== false),

    // ── Sessions and secrets (write-only: values never come back) ─────────
    'POST /api/sessions/twitter/cookies': async ({ body }) => logins.importCookies(String(body.name ?? ''), body.cookies),
    'POST /api/sessions/twitter/login': async ({ body }) => logins.startTwitter(String(body.name ?? '')),
    'POST /api/sessions/twitter/finish': async ({ body }) => logins.finishTwitter(String(body.id ?? '')),
    'POST /api/sessions/telegram/login': async ({ body }) => logins.startTelegram(String(body.name ?? '')),
    'POST /api/sessions/telegram/password': async ({ body }) => logins.telegramPassword(String(body.id ?? ''), body.password),
    'POST /api/sessions/login/status': async ({ body }) => logins.status(String(body.id ?? '')),
    'POST /api/sessions/login/cancel': async ({ body }) => logins.cancel(String(body.id ?? '')),
    'POST /api/secrets/set': async ({ body }) => {
      const kind = String(body.kind ?? '');
      const name = String(body.name ?? 'default');
      assertSessionName(name);
      const credentials = await vaultCredentials();
      if (kind === 'telegram-api') {
        const apiId = Number(body.api_id);
        if (!Number.isInteger(apiId) || apiId <= 0) throw Object.assign(new Error('api_id must be a positive integer.'), { status: 400 });
        if (!/^[a-f0-9]{32}$/i.test(String(body.api_hash ?? ''))) throw Object.assign(new Error('api_hash must be 32 hexadecimal characters.'), { status: 400 });
        await credentials.vault.set('telegram-api', 'default', { api_id: apiId, api_hash: String(body.api_hash).toLowerCase() });
        return { kind, name: 'default', saved: true };
      }
      if (!SETTABLE[kind]) throw Object.assign(new Error(`Use the dedicated login for ${kind}.`), { status: 400 });
      const token = String(body.token ?? '').trim();
      if (!token || token.length > 512) throw Object.assign(new Error('Enter the token.'), { status: 400 });
      await credentials.vault.set(kind, name, { token });
      return { kind, name, saved: true };
    },
    'POST /api/secrets/delete': async ({ body }) => {
      await assertPassword(body.password);
      const kind = String(body.kind ?? '');
      if (!SECRET_KINDS[kind] || kind === 'mcp-token') throw Object.assign(new Error('Unknown secret kind.'), { status: 400 });
      const credentials = await vaultCredentials();
      return { removed: await credentials.vault.delete(kind, String(body.name ?? '')) };
    },
    'GET /api/secrets/api': async () => {
      const vault = await getVault({ interactive: false }).catch(() => null);
      return { telegram_api: Boolean(vault?.get('telegram-api', 'default')) };
    },

    'GET /api/platforms': async () => PLATFORM_CATALOG,
    'GET /api/sessions': async () => {
      const entries = validateAccounts(JSON.parse(await fs.readFile(PATHS.accountsConfig, 'utf8')))
        .filter(entry => entry.archive !== true && entry.active !== false);
      const vault = await getVault({ interactive: false }).catch(() => null);
      return { encrypted: hasVault, unlocked: Boolean(vault), sessions: sessionReport(entries, vault) };
    },
    'POST /api/jobs/stop': async ({ body }) => {
      if (typeof body.job_id !== 'string') throw Object.assign(new Error('job_id is required.'), { status: 400 });
      try {
        return await jobs.stop(body.job_id);
      } catch (error) {
        if (!scheduledJobs) throw error;
        return scheduledJobs.stop(body.job_id);
      }
    },
    // ── Context files (YAML) ──────────────────────────────────────────────
    'GET /api/context/files': async () => contextFiles.list(),
    'POST /api/context/read': async ({ body }) => contextFiles.read(body.path),
    'POST /api/context/validate': async ({ body }) => contextFiles.validate(body.path, body.content),
    'POST /api/context/save': async ({ body }) => {
      const validation = await contextFiles.write(body.path, body.content);
      return { saved: true, validation, sync: await syncContext() };
    },
    'POST /api/context/create': async ({ body }) => contextFiles.create(body.kind, String(body.slug ?? '')),
    'POST /api/context/delete': async ({ body }) => ({ ...await contextFiles.remove(body.path), sync: await syncContext() }),
    'POST /api/context/sync': async () => {
      if (!models) throw Object.assign(new Error('Context sync is not available in this process.'), { status: 501 });
      const { updated, skipped, errors, warnings } = await new UserContextRepository(models).sync();
      return { updated, skipped, errors, warnings };
    },
    // Drafts written by the author in the browser (the AI uses draft_create).
    'POST /api/drafts': async ({ body }) => content.createDraft({
      platform: body.platform, account: body.account || undefined, persona: body.persona || undefined,
      text: body.text, notes: body.notes || null, created_by: 'user',
    }),
    // Alerts: what is configured and what is wrong right now (sends nothing).
    'GET /api/notify': async () => {
      const config = await loadNotifyConfig().catch(error => ({ error: error.message }));
      const credentials = await Credentials.open({ interactive: false }).catch(() => new Credentials());
      const { problems } = await runProblemChecks({ db, credentials, config: null });
      return {
        configured: Boolean(config && !config.error),
        error: config?.error ?? null,
        telegram: config?.telegram ? { enabled: config.telegram.enabled, bot: config.telegram.bot } : null,
        discord: config?.discord ? { enabled: config.discord.enabled } : null,
        problems: problems.map(problem => problem.text),
      };
    },
    'POST /api/notify/test': async () => {
      const config = await loadNotifyConfig();
      if (!config) throw Object.assign(new Error('Alerts are not configured: npm run nyra -- notify telegram-chat / notify discord.'), { status: 400 });
      const { channels, problems } = buildChannels(config, await Credentials.open({ interactive: false }));
      const results = [...problems];
      for (const channel of channels) {
        try {
          await channel.send('EANyra: тестове сповіщення з вебінтерфейсу.');
          results.push(`${channel.name}: доставлено`);
        } catch (error) {
          results.push(`${channel.name}: ${error.message}`);
        }
      }
      return { results };
    },
    'GET /api/telegram/drafts': async ({ query }) => {
      const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
      return db.all(`SELECT request_id, account, text, status, error, receipt, created_at, updated_at
        FROM telegram_outbox ORDER BY created_at DESC LIMIT ?`, [limit]);
    },
  };

  const tools = buildTools({ jobs, publications });
  // Same tools and job manager for the browser and for AI clients.
  const mcpSessions = mcp
    ? new McpHttpSessions({ createServer: () => createMcpServer({ tools, log: message => print(`[mcp] ${message}`, 'system') }) })
    : null;
  const server = createWebServer({
    host, port, auth, mode: hasVault ? 'vault' : 'token', tools, routes,
    info: { version: PKG.version, scheduler: schedule, mcp },
    ...(mcpSessions ? {
      mcp: {
        handle: (req, res) => mcpSessions.handle(req, res),
        // Read on every request: the vault may be unlocked after startup.
        token: async () => {
          try {
            return (await Credentials.open({ interactive: false })).mcpToken();
          } catch {
            return '';
          }
        },
      },
    } : {}),
  });

  let scheduler = null;
  let scheduledJobs = null;
  if (schedule) {
    scheduledJobs = new ScrapeJobs({ source: 'scheduler' });
    scheduler = new Scheduler(async () => {
      const job = await scheduledJobs.start({});
      print(`Scheduled collection started: job ${job.job_id}`, 'system');
    });
    await scheduler.start();
    if (hasVault) {
      print('Scheduled runs need the unlocked vault: log in once in the browser, or run `npm run nyra -- vault remember`.', 'info');
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}/`;
  print(`EANyra web UI → ${url}`, 'success');
  if (token) {
    print(`No vault: log in with this one-time access token: ${token}`, 'warning');
  } else {
    print('Log in with your master password.', 'info');
  }
  if (mcpSessions) {
    print(`MCP for AI clients → ${url}mcp (header Authorization: Bearer <token from \`npm run nyra -- mcp token\`>)`, 'info');
  }

  // Graceful: no new requests, collection stops after its current account,
  // in-flight Telegram publications finish.
  const shutdown = async () => {
    scheduler?.stop();
    server.close();
    await logins.closeAll();
    await mcpSessions?.close();
    await Promise.all([
      jobs.shutdown({ timeoutMs: 90_000 }),
      scheduledJobs?.shutdown({ timeoutMs: 90_000 }),
    ]);
    await publications.drain({ timeoutMs: 35_000 });
    await mcpDb.closeDb().catch(() => {});
  };
  return { server, url, shutdown };
}

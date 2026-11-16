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
import { Vault } from '../core/secrets/Vault.js';
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

  const routes = {
    'GET /api/platforms': async () => PLATFORM_CATALOG,
    'GET /api/sessions': async () => {
      const entries = validateAccounts(JSON.parse(await fs.readFile(PATHS.accountsConfig, 'utf8')))
        .filter(entry => entry.archive !== true && entry.active !== false);
      const vault = await getVault({ interactive: false }).catch(() => null);
      return { encrypted: hasVault, unlocked: Boolean(vault), sessions: sessionReport(entries, vault) };
    },
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
  if (schedule) {
    const scheduledJobs = new ScrapeJobs({ source: 'scheduler' });
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

  const shutdown = async () => {
    scheduler?.stop();
    await mcpSessions?.close();
    jobs.close();
    publications.close();
    server.close();
    await mcpDb.closeDb().catch(() => {});
  };
  return { server, url, shutdown };
}

/**
 * Problem alerts: detect → deduplicate → deliver (Telegram bot / Discord).
 * Called after every collection run and by `npm run nyra -- notify check`.
 */

import fs from 'node:fs/promises';

import { PATHS } from '../../config/app.config.js';
import { validateAccounts } from '../../config/accountConfig.js';
import { loadNotifyConfig } from '../../config/notifyConfig.js';
import { sessionReport } from '../secrets/sessionReport.js';
import { telegramChannel, discordChannel } from './channels.js';
import { detectProblems } from './problems.js';
import { Notifier } from './Notifier.js';

export { formatDigest } from './Notifier.js';

/** Enabled channels from the config; secrets come from the vault (or legacy env). */
export function buildChannels(config, credentials, fetchImpl = fetch) {
  const channels = [];
  const problems = [];
  if (config?.telegram?.enabled) {
    try {
      channels.push(telegramChannel({ token: credentials.botToken(config.telegram.bot), chatId: config.telegram.chat_id, fetchImpl }));
    } catch (error) {
      problems.push(`telegram: ${error.message}`);
    }
  }
  if (config?.discord?.enabled) {
    try {
      const url = credentials.vault
        ? credentials.vault.get('discord-webhook', config.discord.webhook)?.url
        : process.env.DISCORD_WEBHOOK_URL;
      channels.push(discordChannel({ url, fetchImpl }));
    } catch (error) {
      problems.push(`discord: ${error.message}`);
    }
  }
  return { channels, problems };
}

/**
 * @param {{ db: import('../services/sql.js').Executor, credentials: import('../secrets/Credentials.js').Credentials,
 *           config?: object|null, accountsConfigPath?: string, fetchImpl?: typeof fetch, now?: () => Date }} opts
 * @returns {Promise<{ configured: boolean, problems: object[], result?: object, setupProblems?: string[] }>}
 */
export async function runProblemChecks({
  db, credentials, config, accountsConfigPath = PATHS.accountsConfig, fetchImpl = fetch, now = () => new Date(),
}) {
  const settings = config === undefined ? await loadNotifyConfig() : config;
  const entries = await fs.readFile(accountsConfigPath, 'utf8')
    .then(raw => validateAccounts(JSON.parse(raw)).filter(e => e.archive !== true && e.active !== false))
    .catch(() => []);
  const rules = settings?.rules ?? { auth_expiring_days: 3, stale_hours: 48, repeat_hours: 24, notify_resolved: true };
  const problems = await detectProblems(db, {
    sessions: sessionReport(entries, credentials?.vault ?? null), rules, now: now(),
  });
  if (!settings) return { configured: false, problems };

  const { channels, problems: setupProblems } = buildChannels(settings, credentials, fetchImpl);
  const result = await new Notifier(db, { channels, rules, now }).notify(problems);
  return { configured: true, problems, result, setupProblems };
}

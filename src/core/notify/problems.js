/**
 * What counts as a problem worth an alert. Each problem has a stable key so
 * the notifier can tell new, ongoing and resolved problems apart.
 *
 *   session:<kind>/<name>   a login is missing, logged out or expired
 *   expiring:twitter/<name> an X login cookie expires within N days
 *   error:<hash>            accounts whose last collection failed (grouped by error)
 *   stale:<platform>/<user> an account not collected successfully for N hours
 *   run-failed              the latest collection run failed entirely
 *   publish:<request_id>    a Telegram post whose delivery is uncertain
 */

import { createHash } from 'node:crypto';

const HOUR = 36e5;
const LABEL = { twitter: 'X', telegram: 'Telegram', github: 'GitHub', linkedin: 'LinkedIn', 'telegram-bot': 'Telegram-бот', 'discord-bot': 'Discord-бот' };

/**
 * @param {import('../services/sql.js').Executor} db
 * @param {{ sessions?: object[], rules: object, now?: Date }} opts
 *   sessions: rows of sessionReport() (empty when the vault is locked)
 * @returns {Promise<{ key: string, text: string }[]>}
 */
export async function detectProblems(db, { sessions = [], rules, now = new Date() }) {
  const problems = [];

  for (const row of sessions) {
    if (!row.accounts.length) continue;
    const label = `${LABEL[row.kind] ?? row.kind} «${row.name}»`;
    const accounts = row.accounts.join(', ');
    if (['MISSING', 'EXPIRED', 'logged out', 'needs the vault'].includes(row.state)) {
      const what = { MISSING: 'немає логіна', EXPIRED: 'логін прострочений', 'logged out': 'вийшов з акаунта', 'needs the vault': 'потрібне сховище' }[row.state];
      problems.push({ key: `session:${row.kind}/${row.name}`, text: `🔑 ${label}: ${what}. Акаунти: ${accounts}` });
      continue;
    }
    const days = Number(row.state.match(/valid (\d+) more day/)?.[1]);
    if (row.kind === 'twitter' && Number.isFinite(days) && days <= rules.auth_expiring_days) {
      problems.push({
        key: `expiring:${row.kind}/${row.name}`,
        text: `⏳ ${label}: логін закінчиться через ${days} дн. Оновіть cookies: npm run import-cookies -- --session ${row.name}`,
      });
    }
  }

  const failing = await db.all(`
    SELECT platform, username, last_error FROM accounts
    WHERE is_active = 1 AND is_archived = 0 AND last_error IS NOT NULL ORDER BY platform, username`);
  const byError = new Map();
  for (const row of failing) {
    const message = String(row.last_error).replace(/^skipped:\s*/i, '').slice(0, 300);
    if (!byError.has(message)) byError.set(message, []);
    byError.get(message).push(`${row.platform}/${row.username}`);
  }
  for (const [message, accounts] of byError) {
    const hash = createHash('sha256').update(message).digest('hex').slice(0, 12);
    problems.push({ key: `error:${hash}`, text: `❗ Збір не вдався: ${message}\nАкаунти: ${accounts.join(', ')}` });
  }

  if (rules.stale_hours > 0) {
    const stale = await db.all(`
      SELECT platform, username, last_scraped_at FROM accounts
      WHERE is_active = 1 AND is_archived = 0 AND last_error IS NULL AND last_scraped_at IS NOT NULL
      ORDER BY platform, username`);
    for (const row of stale) {
      const hours = (now.getTime() - new Date(row.last_scraped_at).getTime()) / HOUR;
      if (hours > rules.stale_hours) {
        problems.push({
          key: `stale:${row.platform}/${row.username}`,
          text: `🕒 ${row.platform}/${row.username}: дані не оновлювались ${Math.round(hours / 24)} дн.`,
        });
      }
    }
  }

  const latest = await db.get('SELECT id, status, error_message FROM scraper_runs ORDER BY started_at DESC, id DESC LIMIT 1');
  if (latest?.status === 'failed') {
    problems.push({ key: 'run-failed', text: `⛔ Останній збір (#${latest.id}) провалився: ${String(latest.error_message ?? '').slice(0, 300)}` });
  }

  const uncertain = await db.all(`
    SELECT request_id, account, updated_at FROM telegram_outbox
    WHERE status IN ('sending', 'unknown') AND updated_at <= ?`, [new Date(now.getTime() - 10 * 60_000).toISOString()]);
  for (const row of uncertain) {
    problems.push({
      key: `publish:${row.request_id}`,
      text: `📨 Публікація в @${row.account} (${row.request_id}): доставка невідома. Перевірте канал; повторно автоматично не надсилається.`,
    });
  }

  return problems;
}

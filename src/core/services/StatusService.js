/**
 * Collection health for every front end (MCP scraper_status, web dashboard).
 *
 * Freshness is measured from successful collection, per platform and per
 * account, not from the latest run: a failed run must not look like fresh data.
 */

import { PLATFORM_CATALOG } from '../../platforms/catalog.js';

const HOUR = 36e5;

export class StatusService {
  /** @param {import('./sql.js').Executor} db */
  constructor(db, { now = () => new Date(), staleAfterHours = 36 } = {}) {
    this.db = db;
    this.now = now;
    this.staleAfterHours = staleAfterHours;
  }

  async overview({ historyLimit = 5 } = {}) {
    const [latest, lastSuccess, history, accounts, activeJob] = await Promise.all([
      this.db.get('SELECT * FROM scraper_runs ORDER BY started_at DESC, id DESC LIMIT 1'),
      this.db.get("SELECT * FROM scraper_runs WHERE status IN ('success', 'partial') ORDER BY finished_at DESC LIMIT 1"),
      this.recentRuns(historyLimit),
      this.accountHealth(),
      this.db.get("SELECT id, status, source, created_at, started_at FROM jobs WHERE type = 'scrape' AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1"),
    ]);

    const failing = accounts.filter(account => account.state === 'error');
    const stale = accounts.filter(account => account.state === 'stale' || account.state === 'never');
    let health = 'unknown';
    if (latest?.status === 'running') health = 'running';
    else if (accounts.length && !failing.length && !stale.length) health = 'ok';
    else if (accounts.length && failing.length === accounts.length) health = 'error';
    else if (accounts.length) health = 'degraded';

    return {
      health,
      data_age_hours: this.#ageHours(lastSuccess?.finished_at),
      last_successful_run_at: lastSuccess?.finished_at ?? null,
      latest_run: latest ?? null,
      active_job: activeJob ?? null,
      platforms: summarizePlatforms(accounts),
      accounts_needing_attention: [...failing, ...stale].map(({ platform, username, state, last_error, last_error_at, age_hours }) => ({
        platform, username, state, age_hours, ...(last_error ? { last_error, last_error_at } : {}),
      })),
      recent_runs: history,
    };
  }

  async recentRuns(limit = 5) {
    return this.db.all(`
      SELECT id, started_at, finished_at, status, accounts_processed, posts_saved, signals_saved, error_message,
             ROUND((JULIANDAY(finished_at) - JULIANDAY(started_at)) * 86400) AS duration_seconds
      FROM scraper_runs ORDER BY started_at DESC, id DESC LIMIT ?`, [limit]);
  }

  /** One row per active account with a derived state: ok, stale, never, error. */
  async accountHealth() {
    const rows = await this.db.all(`
      SELECT id, platform, username, display_name, last_scraped_at, last_attempt_at, last_error, last_error_at
      FROM accounts WHERE is_active = 1 AND is_archived = 0 ORDER BY platform, username`);
    return rows.map(row => {
      const age = this.#ageHours(row.last_scraped_at);
      let state = 'ok';
      if (row.last_error) state = 'error';
      else if (age === null) state = 'never';
      else if (age > this.staleAfterHours) state = 'stale';
      return { ...row, age_hours: age, state };
    });
  }

  /** Per-account outcomes of one run, for drill-down. */
  async runAccounts(runId) {
    return this.db.all(`
      SELECT platform, username, session, status, records_found, records_saved, error, started_at, finished_at
      FROM scraper_run_accounts WHERE run_id = ? ORDER BY id`, [runId]);
  }

  #ageHours(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return null;
    return Math.round((this.now().getTime() - time) / HOUR * 10) / 10;
  }
}

function summarizePlatforms(accounts) {
  const result = {};
  for (const account of accounts) {
    const entry = result[account.platform] ??= {
      display_name: PLATFORM_CATALOG[account.platform]?.displayName ?? account.platform,
      accounts: 0, ok: 0, stale: 0, never: 0, error: 0, freshest_age_hours: null, oldest_age_hours: null,
    };
    entry.accounts++;
    entry[account.state]++;
    if (account.age_hours !== null) {
      entry.freshest_age_hours = entry.freshest_age_hours === null ? account.age_hours : Math.min(entry.freshest_age_hours, account.age_hours);
      entry.oldest_age_hours = entry.oldest_age_hours === null ? account.age_hours : Math.max(entry.oldest_age_hours, account.age_hours);
    }
  }
  return result;
}

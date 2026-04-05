/**
 * src/platforms/github/GithubScraper.js
 *
 * Collects GitHub activity for a single user and returns a flat list
 * of RawGithubEvent objects ready for persistence.
 *
 * Event types collected:
 *
 *   release        — a new release/tag published on any repo
 *   commit_batch   — commits grouped by calendar week (one event per repo per week)
 *   new_repo       — a public repo that was created within the lookback window
 *   readme_change  — README sha changed since last scrape (detected via stored sha)
 *
 * No browser — pure REST API via GithubClient.
 * Rate limiting: GitHub allows 5 000 requests/hour with a PAT.
 * For typical usage (10–20 accounts, daily runs) this is nowhere near the limit.
 *
 * Deduplication happens in GithubEventRepository.saveBatch() via the
 * unique (event_id) constraint — same as PostRepository for tweets.
 */

import { GithubClient, GithubRateLimitError, GithubNotFoundError } from './client.js';
import { print } from '../../shared/utils.js';
import { GITHUB } from '../../config/app.config.js';

// ─── Week helpers ─────────────────────────────────────────────────────────────

/**
 * ISO week key: "2025-W03" — used to group commits into weekly batches.
 * @param {Date} date
 * @returns {string}
 */
function isoWeekKey(date) {
  const d  = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - new Date(Date.UTC(year, 0, 1))) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Start of the Monday of the week containing `date` (UTC).
 * @param {Date} date
 * @returns {Date}
 */
function weekStart(date) {
  const d   = new Date(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ─── GithubScraper ────────────────────────────────────────────────────────────

export class GithubScraper {
  /**
   * @param {string} token                    GitHub PAT
   * @param {Record<string,string>} readmeShas Map of "username/repo" → last known README sha
   */
  constructor(token, readmeShas = {}) {
    this.client     = new GithubClient(token);
    this.readmeShas = readmeShas;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Collect all activity for a GitHub user within the lookback window.
   *
   * @param {string} username  GitHub login (without @)
   * @returns {Promise<RawGithubEvent[]>}
   */
  async scrapeAccount(username) {
    print(`[GitHub] Fetching activity for @${username}`, 'info');

    const since  = this.#lookbackDate();
    const events = [];

    let repos;
    try {
      repos = await this.client.getRepos(username, GITHUB.reposPerAccount);
    } catch (err) {
      if (err instanceof GithubNotFoundError) {
        print(`[GitHub] @${username} not found — skipping.`, 'warning');
        return [];
      }
      throw err;
    }

    for (const repo of repos) {
      // ── New repo ──────────────────────────────────────────────────────────
      if (repo.created_at && new Date(repo.created_at) >= since) {
        events.push({
          event_id:   `new_repo:${repo.full_name}`,
          username,
          repo:       repo.name,
          event_type: 'new_repo',
          title:      repo.name,
          body:       repo.description ?? '',
          url:        repo.html_url,
          occurred_at: new Date(repo.created_at),
          metadata:   null,
          scraped_at:  new Date(),
        });
      }

      // ── Releases ──────────────────────────────────────────────────────────
      let releases = [];
      try {
        releases = await this.client.getReleases(username, repo.name, GITHUB.releasesPerRepo);
      } catch (err) {
        if (!(err instanceof GithubNotFoundError)) throw err;
      }

      for (const rel of releases) {
        if (!rel.published_at || new Date(rel.published_at) < since) continue;
        if (rel.draft) continue;

        events.push({
          event_id:    `release:${repo.full_name}:${rel.id}`,
          username,
          repo:        repo.name,
          event_type:  'release',
          title:       rel.name || rel.tag_name,
          body:        rel.body ?? '',
          url:         rel.html_url,
          occurred_at: new Date(rel.published_at),
          metadata:    JSON.stringify({ tag: rel.tag_name, prerelease: rel.prerelease }),
          scraped_at:  new Date(),
        });
      }

      // ── Commits (grouped by week) ─────────────────────────────────────────
      // Only collect if the repo had activity in our lookback window.
      if (!repo.pushed_at || new Date(repo.pushed_at) < since) continue;

      let commits = [];
      try {
        commits = await this.client.getCommitsSince(
          username, repo.name, since, GITHUB.commitsPerRepo
        );
      } catch (err) {
        if (!(err instanceof GithubNotFoundError)) throw err;
      }

      // Group commits by ISO week
      /** @type {Map<string, { count: number, messages: string[], weekStart: Date }>} */
      const byWeek = new Map();

      for (const c of commits) {
        const date = new Date(c.commit.author.date);
        const key  = isoWeekKey(date);
        if (!byWeek.has(key)) {
          byWeek.set(key, { count: 0, messages: [], weekStart: weekStart(date) });
        }
        const bucket = byWeek.get(key);
        bucket.count++;
        // Keep first line of each commit message (strip multiline noise)
        const firstLine = c.commit.message.split('\n')[0].trim();
        if (bucket.messages.length < GITHUB.commitMessagesPerBatch) {
          bucket.messages.push(firstLine);
        }
      }

      for (const [weekKey, bucket] of byWeek) {
        events.push({
          event_id:    `commit_batch:${repo.full_name}:${weekKey}`,
          username,
          repo:        repo.name,
          event_type:  'commit_batch',
          title:       `${bucket.count} commit${bucket.count !== 1 ? 's' : ''} — week ${weekKey}`,
          body:        bucket.messages.join('\n'),
          url:         `https://github.com/${repo.full_name}/commits`,
          occurred_at: bucket.weekStart,
          metadata:    JSON.stringify({ week: weekKey, count: bucket.count }),
          scraped_at:  new Date(),
        });
      }

      // ── README change ─────────────────────────────────────────────────────
      const readmeKey = `${username}/${repo.name}`;
      const prevSha   = this.readmeShas[readmeKey];

      // Only check repos that have been pushed to recently
      const readme = await this.client.getReadme(username, repo.name);
      if (readme && prevSha && readme.sha !== prevSha) {
        events.push({
          event_id:    `readme_change:${repo.full_name}:${readme.sha}`,
          username,
          repo:        repo.name,
          event_type:  'readme_change',
          title:       `README updated`,
          body:        '',
          url:         readme.html_url,
          occurred_at: new Date(),
          metadata:    JSON.stringify({ prev_sha: prevSha, new_sha: readme.sha }),
          scraped_at:  new Date(),
        });
      }

      // Always update the stored sha for next run (handled by repository)
      if (readme) {
        this.readmeShas[readmeKey] = readme.sha;
      }
    }

    print(`[GitHub] @${username}: ${events.length} event(s) collected.`, 'data');
    return events;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * The earliest date we care about — now minus GITHUB.lookbackDays.
   * @returns {Date}
   */
  #lookbackDate() {
    const d = new Date();
    d.setDate(d.getDate() - GITHUB.lookbackDays);
    return d;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RawGithubEvent
 * @property {string}      event_id     Stable unique key (type:full_name:detail)
 * @property {string}      username     GitHub login
 * @property {string}      repo         Repository name (short, no owner prefix)
 * @property {string}      event_type   'release' | 'commit_batch' | 'new_repo' | 'readme_change'
 * @property {string}      title        Human-readable summary
 * @property {string}      body         Extended content (release notes, commit messages, …)
 * @property {string}      url          Direct link to the event on GitHub
 * @property {Date}        occurred_at  When the event happened
 * @property {string|null} metadata     JSON string with event-type-specific extra fields
 * @property {Date}        scraped_at   When we captured this record
 */
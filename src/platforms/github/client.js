/**
 * src/platforms/github/client.js
 *
 * Thin wrapper around the GitHub REST API v3.
 *
 * All requests go through #request() which handles:
 *   - Authorization header (Bearer token)
 *   - Rate-limit detection (403 / 429 → throws GithubRateLimitError)
 *   - Not-found detection (404 → throws GithubNotFoundError)
 *   - Generic non-2xx → throws Error with status + message
 *
 * Required scopes for the Personal Access Token:
 *   read:user   — profile info
 *   public_repo — repos, releases, commits, README
 */

const BASE_URL = 'https://api.github.com';

// ─── Custom error types ───────────────────────────────────────────────────────

export class GithubRateLimitError extends Error {
  constructor(resetAt) {
    super(`GitHub rate limit hit. Resets at: ${resetAt ?? 'unknown'}`);
    this.name    = 'GithubRateLimitError';
    this.resetAt = resetAt;
  }
}

export class GithubNotFoundError extends Error {
  constructor(path) {
    super(`GitHub resource not found: ${path}`);
    this.name     = 'GithubNotFoundError';
    this.resource = path;
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class GithubClient {
  /**
   * @param {string} token  Personal Access Token (read:user, public_repo)
   */
  constructor(token) {
    if (!token) throw new Error('GithubClient: token is required');
    this.#token = token;
  }

  #token;

  // ── Repos ─────────────────────────────────────────────────────────────────

  /**
   * List public repositories for a user, sorted by push date (newest first).
   *
   * @param {string} username
   * @param {number} [perPage=30]
   * @returns {Promise<GithubRepo[]>}
   */
  async getRepos(username, perPage = 30) {
    return this.#request(
      `/users/${username}/repos?sort=pushed&direction=desc&per_page=${perPage}&type=public`
    );
  }

  // ── Releases ──────────────────────────────────────────────────────────────

  /**
   * List releases for a repo, newest first.
   *
   * @param {string} username
   * @param {string} repo
   * @param {number} [perPage=10]
   * @returns {Promise<GithubRelease[]>}
   */
  async getReleases(username, repo, perPage = 10) {
    return this.#request(`/repos/${username}/${repo}/releases?per_page=${perPage}`);
  }

  // ── Commits ───────────────────────────────────────────────────────────────

  /**
   * List commits on the default branch since a given date.
   *
   * @param {string}      username
   * @param {string}      repo
   * @param {Date|string} since   ISO 8601 / Date — only commits after this timestamp
   * @param {number}      [perPage=100]
   * @returns {Promise<GithubCommit[]>}
   */
  async getCommitsSince(username, repo, since, perPage = 100) {
    const sinceStr = since instanceof Date ? since.toISOString() : since;
    return this.#request(
      `/repos/${username}/${repo}/commits?since=${sinceStr}&per_page=${perPage}`
    );
  }

  // ── README ────────────────────────────────────────────────────────────────

  /**
   * Fetch the README metadata for a repo.
   * Returns null if the repo has no README (404).
   *
   * @param {string} username
   * @param {string} repo
   * @returns {Promise<GithubReadme|null>}
   */
  async getReadme(username, repo) {
    try {
      return await this.#request(`/repos/${username}/${repo}/readme`);
    } catch (err) {
      if (err instanceof GithubNotFoundError) return null;
      throw err;
    }
  }

  // ── Rate limit ────────────────────────────────────────────────────────────

  /**
   * Check current rate limit status without consuming quota.
   *
   * @returns {Promise<{ limit: number, remaining: number, resetAt: Date }>}
   */
  async getRateLimit() {
    const data = await this.#request('/rate_limit');
    const core = data.resources.core;
    return {
      limit:     core.limit,
      remaining: core.remaining,
      resetAt:   new Date(core.reset * 1000),
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Execute a GET request against the GitHub REST API.
   *
   * @param {string} path  API path starting with '/'
   * @returns {Promise<any>}
   */
  async #request(path) {
    const url = `${BASE_URL}${path}`;

    const res = await fetch(url, {
      headers: {
        Authorization:          `Bearer ${this.#token}`,
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent':           'EANyra/1.0',
      },
    });

    if (res.status === 404) {
      throw new GithubNotFoundError(path);
    }

    if (res.status === 403 || res.status === 429) {
      const resetHeader = res.headers.get('x-ratelimit-reset');
      const resetAt     = resetHeader ? new Date(Number(resetHeader) * 1000) : null;
      throw new GithubRateLimitError(resetAt);
    }

    if (!res.ok) {
      let msg = `GitHub API error: ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) msg += ` — ${body.message}`;
      } catch { /* ignore */ }
      throw new Error(msg);
    }

    return res.json();
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GithubRepo
 * @property {number}      id
 * @property {string}      name
 * @property {string}      full_name
 * @property {string|null} description
 * @property {string}      html_url
 * @property {string|null} pushed_at    ISO 8601
 * @property {string|null} created_at   ISO 8601
 * @property {string}      default_branch
 */

/**
 * @typedef {Object} GithubRelease
 * @property {number}  id
 * @property {string}  tag_name
 * @property {string}  name
 * @property {string}  body
 * @property {string}  html_url
 * @property {string}  published_at  ISO 8601
 * @property {boolean} draft
 * @property {boolean} prerelease
 */

/**
 * @typedef {Object} GithubCommit
 * @property {string} sha
 * @property {{ message: string, author: { date: string } }} commit
 * @property {string} html_url
 */

/**
 * @typedef {Object} GithubReadme
 * @property {string} sha           Content hash — compare to detect changes
 * @property {string} download_url
 * @property {string} html_url
 */
import { query, queryOne } from '../db.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Parse media_urls JSON string safely */
function parseMedia(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

/** Format a post row for clean agent consumption */
function formatPost(row) {
  return {
    tweet_id:   row.tweet_id,
    account:    row.username ?? row.account_id,
    text:       row.text,
    lang:       row.lang,
    posted_at:  row.posted_at,
    likes:      row.likes,
    retweets:   row.retweets,
    replies:    row.replies,
    views:      row.views ?? null,
    is_retweet: Boolean(row.is_retweet),
    is_reply:   Boolean(row.is_reply),
    media_urls: parseMedia(row.media_urls),
    url:        row.raw_url,
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────

export const twitterTools = [

  // ── 1. Recent posts ──────────────────────────────────────────────────────
  {
    name: 'twitter_get_recent_posts',
    description:
      'Get the most recent scraped Twitter/X posts. ' +
      'Optionally filter by account username and/or time window. ' +
      'Returns posts sorted newest-first.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Twitter username without @. Omit to get posts from all monitored accounts.',
        },
        limit: {
          type: 'integer',
          description: 'Max number of posts to return (default 20, max 100).',
          default: 20,
        },
        since_hours: {
          type: 'integer',
          description: 'Only return posts from the last N hours. Omit for no time filter.',
        },
        include_retweets: {
          type: 'boolean',
          description: 'Include retweets in results (default false).',
          default: false,
        },
        include_replies: {
          type: 'boolean',
          description: 'Include replies in results (default true).',
          default: true,
        },
      },
    },
    async handler({ account, limit = 20, since_hours, include_retweets = false, include_replies = true }) {
      const cap = Math.min(Number(limit), 100);

      const conditions = ['1=1'];
      const params     = [];

      if (account) {
        conditions.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^@/, ''));
      }
      if (since_hours) {
        conditions.push("p.posted_at >= datetime('now', ? || ' hours')");
        params.push(`-${Number(since_hours)}`);
      }
      if (!include_retweets) {
        conditions.push('p.is_retweet = 0');
      }
      if (!include_replies) {
        conditions.push('p.is_reply = 0');
      }

      params.push(cap);

      const rows = await query(`
        SELECT p.*, a.username
        FROM posts p
        JOIN accounts a ON a.id = p.account_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.posted_at DESC
        LIMIT ?
      `, params);

      return {
        count: rows.length,
        posts: rows.map(formatPost),
      };
    },
  },

  // ── 2. Search posts ──────────────────────────────────────────────────────
  {
    name: 'twitter_search_posts',
    description:
      'Full-text search across scraped Twitter/X post content. ' +
      'Searches the post text field. Case-insensitive. ' +
      'Optionally scoped to a single account.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Search term or phrase to look for in post text.',
        },
        account: {
          type: 'string',
          description: 'Limit search to this username. Omit to search all accounts.',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (default 20, max 100).',
          default: 20,
        },
        since_hours: {
          type: 'integer',
          description: 'Only search posts from the last N hours.',
        },
      },
    },
    async handler({ query: searchQuery, account, limit = 20, since_hours }) {
      const cap = Math.min(Number(limit), 100);

      const conditions = ["LOWER(p.text) LIKE LOWER(?)"];
      const params     = [`%${searchQuery}%`];

      if (account) {
        conditions.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^@/, ''));
      }
      if (since_hours) {
        conditions.push("p.posted_at >= datetime('now', ? || ' hours')");
        params.push(`-${Number(since_hours)}`);
      }

      params.push(cap);

      const rows = await query(`
        SELECT p.*, a.username
        FROM posts p
        JOIN accounts a ON a.id = p.account_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.posted_at DESC
        LIMIT ?
      `, params);

      return {
        search_query: searchQuery,
        count:        rows.length,
        posts:        rows.map(formatPost),
      };
    },
  },

  // ── 3. Trending posts ────────────────────────────────────────────────────
  {
    name: 'twitter_get_trending_posts',
    description:
      'Get top-performing posts ranked by a chosen engagement metric. ' +
      'Useful for finding what content is resonating most.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['likes', 'retweets', 'replies', 'views'],
          description: 'Metric to rank by (default: likes).',
          default: 'likes',
        },
        hours: {
          type: 'integer',
          description: 'Look back N hours (default 24). Use 168 for last week.',
          default: 24,
        },
        account: {
          type: 'string',
          description: 'Limit to a specific account. Omit for all accounts.',
        },
        limit: {
          type: 'integer',
          description: 'Number of top posts to return (default 10, max 50).',
          default: 10,
        },
      },
    },
    async handler({ metric = 'likes', hours = 24, account, limit = 10 }) {
      const allowed = ['likes', 'retweets', 'replies', 'views'];
      const col     = allowed.includes(metric) ? metric : 'likes';
      const cap     = Math.min(Number(limit), 50);

      const conditions = [`p.posted_at >= datetime('now', '-${Number(hours)} hours')`];
      const params     = [];

      if (account) {
        conditions.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^@/, ''));
      }

      // Exclude nulls for views since it's optional
      if (col === 'views') conditions.push('p.views IS NOT NULL');

      params.push(cap);

      const rows = await query(`
        SELECT p.*, a.username
        FROM posts p
        JOIN accounts a ON a.id = p.account_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.${col} DESC
        LIMIT ?
      `, params);

      return {
        ranked_by:   col,
        window_hours: hours,
        count:        rows.length,
        posts:        rows.map(formatPost),
      };
    },
  },

  // ── 4. Account stats ─────────────────────────────────────────────────────
  {
    name: 'twitter_get_account_stats',
    description:
      'Get aggregated engagement statistics for one or all monitored accounts. ' +
      'Returns post counts, totals and averages for likes/retweets/replies/views.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Username to get stats for. Omit for all accounts.',
        },
        hours: {
          type: 'integer',
          description: 'Time window in hours (default 168 = last 7 days). Use 0 for all-time.',
          default: 168,
        },
      },
    },
    async handler({ account, hours = 168 }) {
      const conditions = ['1=1'];
      const params     = [];

      if (hours > 0) {
        conditions.push(`p.posted_at >= datetime('now', '-${Number(hours)} hours')`);
      }
      if (account) {
        conditions.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^@/, ''));
      }

      const rows = await query(`
        SELECT
          a.username,
          a.display_name,
          a.last_scraped_at,
          COUNT(*)                          AS total_posts,
          SUM(CASE WHEN p.is_retweet = 0 AND p.is_reply = 0 THEN 1 ELSE 0 END) AS original_posts,
          SUM(p.is_retweet)                 AS retweet_count,
          SUM(p.is_reply)                   AS reply_count,
          SUM(p.likes)                      AS total_likes,
          SUM(p.retweets)                   AS total_retweets,
          SUM(p.replies)                    AS total_replies,
          SUM(p.views)                      AS total_views,
          ROUND(AVG(p.likes), 1)            AS avg_likes,
          ROUND(AVG(p.retweets), 1)         AS avg_retweets,
          MAX(p.likes)                      AS peak_likes,
          MAX(p.retweets)                   AS peak_retweets
        FROM posts p
        JOIN accounts a ON a.id = p.account_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY a.id
        ORDER BY total_likes DESC
      `, params);

      return {
        window_hours: hours === 0 ? 'all-time' : hours,
        accounts:     rows,
      };
    },
  },

  // ── 5. List accounts ─────────────────────────────────────────────────────
  {
    name: 'twitter_list_accounts',
    description:
      'List all Twitter/X accounts currently monitored by EANyra. ' +
      'Shows active status and last scrape time.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Only return active accounts (default true).',
          default: true,
        },
      },
    },
    async handler({ active_only = true }) {
      const where  = active_only ? 'WHERE a.is_active = 1' : '';
      const rows = await query(`
        SELECT
          a.username,
          a.display_name,
          a.is_active,
          a.last_scraped_at,
          COUNT(p.id) AS total_posts_in_db
        FROM accounts a
        LEFT JOIN posts p ON p.account_id = a.id
        ${where}
        GROUP BY a.id
        ORDER BY a.username ASC
      `);

      return {
        count:    rows.length,
        accounts: rows,
      };
    },
  },
];
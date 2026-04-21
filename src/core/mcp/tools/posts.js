import { query } from '../db.js';

/**
 * src/core/mcp/tools/posts.js
 *
 * Unified tools for the `posts` table — covers all platforms:
 * Twitter/X, LinkedIn, Telegram, Bluesky, and any future platform.
 *
 * Tools:
 *   posts_get      — query posts with rich filtering
 *   posts_search   — full-text search across post content
 *   posts_stats    — aggregated engagement stats per account / platform
 *   accounts_list  — list monitored accounts across all platforms
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMedia(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function formatPost(row) {
  return {
    id:          row.id,
    platform:    row.platform,
    platform_id: row.platform_id,
    account:     row.username  ?? null,
    text:        row.text,
    lang:        row.lang      ?? null,
    posted_at:   row.posted_at,
    likes:       row.likes     ?? 0,
    reposts:     row.reposts   ?? 0,
    replies:     row.replies   ?? 0,
    views:       row.views     ?? null,
    is_repost:   Boolean(row.is_repost),
    is_reply:    Boolean(row.is_reply),
    media_urls:  parseMedia(row.media_urls),
    shared_url:  row.shared_url ?? null,
    raw_url:     row.raw_url    ?? null,
    visibility:  row.visibility ?? null,
    used:        row.used_for_content != null,
  };
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export const postTools = [

  // ── posts_get ─────────────────────────────────────────────────────────────
  {
    name: 'posts_get',
    description:
      'Query published posts from the unified posts table. ' +
      'Covers all platforms: twitter, linkedin, telegram, bluesky, and any future platform. ' +
      '\n\nSelection types:' +
      '\n  "recent"         — newest first (default)' +
      '\n  "top_engagement" — ranked by likes + reposts' +
      '\n  "sample"         — balanced mix: 50% top engagement + 50% recent; best for style calibration' +
      '\n\nAlways excludes reposts. Excludes replies by default.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type:        'string',
          enum:        ['twitter', 'linkedin', 'telegram', 'bluesky'],
          description: 'Filter by platform. Omit to query all platforms.',
        },
        type: {
          type:        'string',
          enum:        ['recent', 'top_engagement', 'sample'],
          description: 'Selection strategy (default: recent).',
          default:     'recent',
        },
        limit: {
          type:        'integer',
          description: 'Max posts to return (default 20, max 100).',
          default:     20,
        },
        lang: {
          type:        'string',
          description: 'Filter by language code, e.g. "uk", "en". Omit for all.',
        },
        account: {
          type:        'string',
          description: 'Filter by account username (without @).',
        },
        since_days: {
          type:        'integer',
          description: 'Only return posts from the last N days.',
        },
        include_replies: {
          type:        'boolean',
          description: 'Include reply posts (default false).',
          default:     false,
        },
        unused_only: {
          type:        'boolean',
          description: 'Only return posts not yet used for content creation (default false).',
          default:     false,
        },
      },
    },
    async handler({
      platform,
      type            = 'recent',
      limit           = 20,
      lang,
      account,
      since_days,
      include_replies = false,
      unused_only     = false,
    } = {}) {
      const cap    = Math.min(Number(limit), 100);
      const conds  = ['p.is_repost = 0'];
      const params = [];

      if (platform) {
        conds.push('p.platform = ?');
        params.push(platform);
      }
      if (lang) {
        conds.push('p.lang = ?');
        params.push(lang);
      }
      if (account) {
        conds.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^@/, ''));
      }
      if (since_days) {
        conds.push("p.posted_at >= datetime('now', ? || ' days')");
        params.push(`-${Number(since_days)}`);
      }
      if (!include_replies) {
        conds.push('p.is_reply = 0');
      }
      if (unused_only) {
        conds.push('p.used_for_content IS NULL');
      }

      const where   = conds.join(' AND ');
      const orderBy = type === 'top_engagement'
        ? 'p.likes + COALESCE(p.reposts, 0) DESC, p.posted_at DESC'
        : 'p.posted_at DESC';

      const SELECT = `
        p.id, p.platform, p.platform_id, p.text, p.lang,
        p.posted_at, p.likes, p.reposts, p.replies, p.views,
        p.is_repost, p.is_reply, p.media_urls,
        p.shared_url, p.raw_url, p.visibility, p.used_for_content,
        a.username`;

      let rows;

      if (type === 'sample') {
        const half = Math.ceil(cap / 2);
        // Build the WHERE clause twice (once per sub-query), params duplicated accordingly
        rows = await query(`
          SELECT DISTINCT ${SELECT}
          FROM   posts p
          JOIN   accounts a ON a.id = p.account_id
          WHERE  ${where}
            AND  p.id IN (
              SELECT id FROM (
                SELECT p2.id
                FROM   posts p2
                JOIN   accounts a2 ON a2.id = p2.account_id
                WHERE  ${where}
                ORDER  BY p2.likes + COALESCE(p2.reposts, 0) DESC
                LIMIT  ?
              )
              UNION
              SELECT id FROM (
                SELECT p3.id
                FROM   posts p3
                JOIN   accounts a3 ON a3.id = p3.account_id
                WHERE  ${where}
                ORDER  BY p3.posted_at DESC
                LIMIT  ?
              )
            )
          ORDER  BY p.posted_at DESC
        `, [...params, ...params, half, ...params, half]);
      } else {
        rows = await query(`
          SELECT ${SELECT}
          FROM   posts p
          JOIN   accounts a ON a.id = p.account_id
          WHERE  ${where}
          ORDER  BY ${orderBy}
          LIMIT  ?
        `, [...params, cap]);
      }

      return {
        count:    rows.length,
        platform: platform ?? 'all',
        type,
        posts:    rows.map(formatPost),
      };
    },
  },

  // ── posts_search ──────────────────────────────────────────────────────────
  {
    name: 'posts_search',
    description:
      'Full-text search across post content from all platforms. ' +
      'Case-insensitive substring match. ' +
      'Optionally scoped to a specific platform or account.',
    inputSchema: {
      type:     'object',
      required: ['query'],
      properties: {
        query: {
          type:        'string',
          description: 'Search term or phrase to find in post text.',
        },
        platform: {
          type:        'string',
          enum:        ['twitter', 'linkedin', 'telegram', 'bluesky'],
          description: 'Limit search to a specific platform. Omit for all.',
        },
        account: {
          type:        'string',
          description: 'Limit search to this username. Omit for all accounts.',
        },
        limit: {
          type:        'integer',
          description: 'Max results to return (default 20, max 100).',
          default:     20,
        },
        since_days: {
          type:        'integer',
          description: 'Only search posts from the last N days.',
        },
      },
    },
    async handler({ query: searchQuery, platform, account, limit = 20, since_days }) {
      const cap    = Math.min(Number(limit), 100);
      const conds  = ['LOWER(p.text) LIKE LOWER(?)'];
      const params = [`%${searchQuery}%`];

      if (platform) {
        conds.push('p.platform = ?');
        params.push(platform);
      }
      if (account) {
        conds.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^@/, ''));
      }
      if (since_days) {
        conds.push("p.posted_at >= datetime('now', ? || ' days')");
        params.push(`-${Number(since_days)}`);
      }
      params.push(cap);

      const rows = await query(`
        SELECT p.id, p.platform, p.platform_id, p.text, p.lang,
               p.posted_at, p.likes, p.reposts, p.replies, p.views,
               p.is_repost, p.is_reply, p.media_urls,
               p.shared_url, p.raw_url, p.visibility, p.used_for_content,
               a.username
        FROM   posts p
        JOIN   accounts a ON a.id = p.account_id
        WHERE  ${conds.join(' AND ')}
        ORDER  BY p.posted_at DESC
        LIMIT  ?
      `, params);

      return {
        search_query: searchQuery,
        count:        rows.length,
        posts:        rows.map(formatPost),
      };
    },
  },

  // ── posts_stats ───────────────────────────────────────────────────────────
  {
    name: 'posts_stats',
    description:
      'Aggregated engagement statistics grouped by account and platform. ' +
      'Returns post counts and totals/averages for likes, reposts, replies, views. ' +
      'Useful for comparing performance across platforms or accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type:        'string',
          enum:        ['twitter', 'linkedin', 'telegram', 'bluesky'],
          description: 'Filter to a specific platform. Omit for all platforms.',
        },
        account: {
          type:        'string',
          description: 'Filter to a specific account username. Omit for all accounts.',
        },
        days: {
          type:        'integer',
          description: 'Time window in days (default 30). Use 0 for all-time.',
          default:     30,
        },
      },
    },
    async handler({ platform, account, days = 30 } = {}) {
      const conds  = ['1=1'];
      const params = [];

      if (days > 0) {
        conds.push("p.posted_at >= datetime('now', ? || ' days')");
        params.push(`-${Number(days)}`);
      }
      if (platform) {
        conds.push('p.platform = ?');
        params.push(platform);
      }
      if (account) {
        conds.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^@/, ''));
      }

      const rows = await query(`
        SELECT
          a.username,
          a.display_name,
          p.platform,
          a.last_scraped_at,
          COUNT(*)                                                              AS total_posts,
          SUM(CASE WHEN p.is_repost = 0 AND p.is_reply = 0 THEN 1 ELSE 0 END) AS original_posts,
          SUM(p.is_repost)                                                      AS repost_count,
          SUM(p.is_reply)                                                       AS reply_count,
          SUM(p.likes)                                                          AS total_likes,
          SUM(p.reposts)                                                        AS total_reposts,
          SUM(p.replies)                                                        AS total_replies,
          SUM(p.views)                                                          AS total_views,
          ROUND(AVG(p.likes),   1)                                              AS avg_likes,
          ROUND(AVG(p.reposts), 1)                                              AS avg_reposts,
          MAX(p.likes)                                                          AS peak_likes,
          MAX(p.reposts)                                                        AS peak_reposts
        FROM   posts p
        JOIN   accounts a ON a.id = p.account_id
        WHERE  ${conds.join(' AND ')}
        GROUP  BY a.id, p.platform
        ORDER  BY total_likes DESC
      `, params);

      return {
        window_days: days === 0 ? 'all-time' : days,
        platform:    platform ?? 'all',
        stats:       rows,
      };
    },
  },

  // ── accounts_list ─────────────────────────────────────────────────────────
  {
    name: 'accounts_list',
    description:
      'List all monitored accounts across all platforms ' +
      '(Twitter/X, GitHub, LinkedIn, Telegram, …). ' +
      'Shows platform, active status, last scrape time, ' +
      'and counts of posts and signals stored for each account.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type:        'string',
          enum:        ['twitter', 'github', 'linkedin', 'telegram', 'bluesky'],
          description: 'Filter by platform. Omit to list all platforms.',
        },
        active_only: {
          type:        'boolean',
          description: 'Only return active accounts (default true).',
          default:     true,
        },
      },
    },
    async handler({ platform, active_only = true } = {}) {
      const conds  = ['1=1'];
      const params = [];

      if (platform) {
        conds.push('a.platform = ?');
        params.push(platform);
      }
      if (active_only) {
        conds.push('a.is_active = 1');
      }

      const rows = await query(`
        SELECT
          a.username,
          a.display_name,
          a.platform,
          a.is_active,
          a.last_scraped_at,
          COUNT(DISTINCT p.id) AS posts_in_db,
          COUNT(DISTINCT s.id) AS signals_in_db
        FROM       accounts a
        LEFT JOIN  posts   p ON p.account_id   = a.id
        LEFT JOIN  signals s ON s.account_id   = a.id
        WHERE      ${conds.join(' AND ')}
        GROUP BY   a.id
        ORDER BY   a.platform ASC, a.username ASC
      `, params);

      return {
        count:    rows.length,
        accounts: rows,
      };
    },
  },
];
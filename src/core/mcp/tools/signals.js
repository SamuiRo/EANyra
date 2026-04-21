import { query, run } from '../db.js';

/**
 * src/core/mcp/tools/signals.js
 *
 * Unified tools for the `signals` table — covers all sources:
 * GitHub (releases, commits, repos, README changes), notes, articles, and future sources.
 *
 * Tools:
 *   signals_get        — query signals with rich filtering
 *   signals_mark_used  — stamp used_for_content after publishing
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSignal(row) {
  let metadata = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { metadata = row.metadata; }
  }

  // Trim body for readability — keeps MCP responses manageable
  const body = row.body && row.body.length > 500
    ? row.body.slice(0, 500) + '\n[… trimmed — full content in DB]'
    : (row.body ?? null);

  return {
    id:          row.id,
    source:      row.source,
    signal_type: row.signal_type,
    account:     row.username    ?? null,
    title:       row.title,
    body,
    url:         row.url         ?? null,
    occurred_at: row.occurred_at ?? null,
    metadata,
    used:        row.used_for_content != null,
    scraped_at:  row.scraped_at,
  };
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export const signalTools = [

  // ── signals_get ───────────────────────────────────────────────────────────
  {
    name: 'signals_get',
    description:
      'Query content signals — raw material for future posts. ' +
      '\n\nSources:' +
      '\n  github  — releases, commit batches, new repos, README changes' +
      '\n  note    — manual ideas or drafts you added yourself' +
      '\n  article — links or articles you want to write about' +
      '\n\nSignal types within github (in priority order):' +
      '\n  release        — most valuable; has version tag and release notes' +
      '\n  commit_batch   — N commits grouped by week' +
      '\n  new_repo       — new repository, includes README if available' +
      '\n  readme_change  — README update; only useful if body has real content' +
      '\n\nBy default returns only unused signals, ordered by priority then date. ' +
      'Pass used_for_content: true to review what has already been used.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type:        'string',
          enum:        ['github', 'note', 'article', 'tool_review', 'news'],
          description: 'Filter by signal source. Omit for all sources.',
        },
        signal_type: {
          type:        'string',
          enum:        ['release', 'commit_batch', 'new_repo', 'readme_change', 'idea', 'draft', 'article'],
          description: 'Filter by signal type. Omit for all types.',
        },
        used_for_content: {
          type:        'boolean',
          description:
            'false (default) — only unused signals. ' +
            'true — only already-used signals. ' +
            'Omit entirely to get both.',
        },
        account: {
          type:        'string',
          description: 'Filter by account username. Omit for all accounts.',
        },
        limit: {
          type:        'integer',
          description: 'Max signals to return (default 30, max 100).',
          default:     30,
        },
        since_days: {
          type:        'integer',
          description:
            'Only return signals from the last N days. ' +
            'Signals with no occurred_at are always included when unused.',
        },
      },
    },
    async handler({
      source,
      signal_type,
      used_for_content,
      account,
      limit      = 30,
      since_days,
    } = {}) {
      const cap    = Math.min(Number(limit), 100);
      const conds  = ['1=1'];
      const params = [];

      if (source) {
        conds.push('s.source = ?');
        params.push(source);
      }
      if (signal_type) {
        conds.push('s.signal_type = ?');
        params.push(signal_type);
      }
      if (used_for_content === true) {
        conds.push('s.used_for_content IS NOT NULL');
      } else if (used_for_content === false) {
        conds.push('s.used_for_content IS NULL');
      }
      if (account) {
        conds.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^@/, ''));
      }
      if (since_days) {
        // Include signals with NULL occurred_at when they are unused
        // so fresh scrapes without timestamps don't get silently dropped
        conds.push(`(
          s.occurred_at >= datetime('now', ? || ' days')
          OR (s.occurred_at IS NULL AND s.used_for_content IS NULL)
        )`);
        params.push(`-${Number(since_days)}`);
      }

      params.push(cap);

      const rows = await query(`
        SELECT s.id, s.source, s.signal_type,
               s.title, s.body, s.url,
               s.occurred_at, s.metadata,
               s.used_for_content, s.scraped_at,
               a.username
        FROM   signals s
        LEFT   JOIN accounts a ON a.id = s.account_id
        WHERE  ${conds.join(' AND ')}
        ORDER  BY
          CASE s.signal_type
            WHEN 'release'       THEN 1
            WHEN 'commit_batch'  THEN 2
            WHEN 'new_repo'      THEN 3
            WHEN 'readme_change' THEN 4
            ELSE 5
          END,
          COALESCE(s.occurred_at, s.scraped_at) DESC
        LIMIT  ?
      `, params);

      return {
        count:   rows.length,
        signals: rows.map(formatSignal),
      };
    },
  },

  // ── signals_mark_used ─────────────────────────────────────────────────────
  {
    name: 'signals_mark_used',
    description:
      'Mark one or more signals as used for content creation. ' +
      'Call this only after the author confirms the post goes live — not speculatively. ' +
      'Stamped signals are excluded from future signals_get() calls by default. ' +
      'Accepts a single id or an array of ids.',
    inputSchema: {
      type:     'object',
      required: ['signal_id'],
      properties: {
        signal_id: {
          description:
            'Signal ID or array of IDs to mark as used. ' +
            'Get IDs from the id field in signals_get results.',
          oneOf: [
            { type: 'integer' },
            { type: 'array', items: { type: 'integer' }, minItems: 1 },
          ],
        },
      },
    },
    async handler({ signal_id } = {}) {
      const ids = Array.isArray(signal_id) ? signal_id : [signal_id];

      if (!ids.length || ids.some(id => !Number.isInteger(Number(id)))) {
        return { error: 'signal_id must be an integer or a non-empty array of integers.' };
      }

      const placeholders = ids.map(() => '?').join(', ');
      const now          = new Date().toISOString();

      const result = await run(
        `UPDATE signals
         SET    used_for_content = ?
         WHERE  id IN (${placeholders})
           AND  used_for_content IS NULL`,
        [now, ...ids],
      );

      return {
        marked:    result.changes,
        ids_sent:  ids,
        timestamp: now,
        message:   result.changes > 0
          ? `Marked ${result.changes} signal(s) as used.`
          : 'No signals updated — already marked or IDs not found.',
      };
    },
  },
];
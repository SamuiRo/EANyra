import { query, queryOne } from '../db.js';

/**
 * MCP tools for user context.
 *
 * context_get — returns user context from the `user_context` table.
 * The agent calls this before generating any content to understand
 * the user's tone, platform rules, and active projects.
 */

export const contextTools = [
  {
    name:        'context_get',
    description:
      'Returns user context: tone/voice, bio per platform, content rules per platform, ' +
      'and active projects with content angles and posting rules. ' +
      'Always call this before generating or suggesting any post content.',
    inputSchema: {
      type:       'object',
      properties: {
        key: {
          type:        'string',
          description:
            'Optional. Return only a specific key: ' +
            '"voice", "bio", "platforms", or "project.<slug>". ' +
            'Omit to get the full context.',
        },
      },
      required: [],
    },
    async handler({ key } = {}) {
      if (key) {
        const row = await queryOne(
          'SELECT value FROM user_context WHERE key = ?',
          [key],
        );
        if (!row) {
          return { error: `Context key "${key}" not found. Run "eanyra context sync" first.` };
        }
        return { key, value: tryParse(row.value, row.value) };
      }

      // Full context: flat keys + active projects from dedicated table
      const rows = await query('SELECT key, value FROM user_context ORDER BY key');

      const ctx = {};
      for (const row of rows) {
        // project.* keys are redundant here — projects come from the table below
        if (row.key.startsWith('project.')) continue;
        ctx[row.key] = tryParse(row.value, row.value);
      }

      const projects = await query(
        `SELECT slug, name, status, description,
                tech_stack, links, content_angles, posting_rules
         FROM projects
         WHERE status = 'active'
         ORDER BY slug`,
      );

      ctx.projects = projects.map(p => ({
        slug:           p.slug,
        name:           p.name,
        status:         p.status,
        description:    p.description,
        tech_stack:     tryParse(p.tech_stack,     []),
        links:          tryParse(p.links,          {}),
        content_angles: tryParse(p.content_angles, []),
        posting_rules:  tryParse(p.posting_rules,  []),
      }));

      return ctx;
    },
  },
];

function tryParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
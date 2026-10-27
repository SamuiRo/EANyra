import fs   from 'node:fs/promises';
import path  from 'node:path';
import { query, queryOne } from './db.js';
import { MCP, PATHS } from '../../config/app.config.js';
import { accountKey, mergePersonaContext } from '../../config/personaConfig.js';
import { validateAccounts } from '../../config/accountConfig.js';
import { loadPersonas, getPersona, personaForAccount } from './personas.js';

/**
 * src/core/mcp/context.js
 *
 * Tools:
 *   personas_list — personas and the accounts each one groups
 *   context_get  — voice, bio, platform rules, active projects; per persona
 *   export_get   — latest export Markdown file as a string
 */

const EXPORTS_DIR = PATHS.exportsDir;

export function buildContextTools() {
  return [...contextTools, ...exportTools];
}

// ── context_get ───────────────────────────────────────────────────────────────

const contextTools = [
  {
    name: 'personas_list',
    description:
      'List the author\'s personas: each groups the accounts that represent one identity or theme ' +
      'across platforms (e.g. a business brand vs. a games/anime account) and has its own voice. ' +
      'Call it first when a request names an account, platform or topic, to pick the persona to write as. ' +
      'Also lists configured accounts that belong to no persona.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler() {
      const personas = await loadPersonas();
      const grouped = new Set(personas.flatMap(entry => entry.accounts.map(accountKey)));
      const accounts = await configuredAccounts();
      return {
        count: personas.length,
        personas: personas.map(entry => ({
          slug:        entry.slug,
          name:        entry.name,
          description: entry.description,
          topics:      entry.topics,
          accounts:    entry.accounts.map(accountKey),
          talks_about_projects: entry.projects === null ? 'all active projects' : entry.projects,
        })),
        accounts_without_persona: accounts.map(accountKey).filter(key => !grouped.has(key)),
        next_step: personas.length
          ? 'Call context_get with persona (or the target account) before writing, and pass the same persona to posts_get for style examples.'
          : 'No personas configured: context_get returns the shared global context for every account.',
      };
    },
  },
  {
    name: 'context_get',
    description:
      'Returns the author\'s context: tone/voice, bio per platform, ' +
      'content rules per platform, and active projects with content angles and posting rules. ' +
      'Always call this before generating or suggesting any post content. ' +
      'The author may run several personas (e.g. a business brand and an anime account), each grouping ' +
      'accounts across platforms with its own voice and topics. When writing for a specific account, pass ' +
      'account (e.g. "twitter/name") or persona: the result is that persona\'s context merged over the ' +
      'global defaults. Never mix the voice or projects of different personas. Without arguments the ' +
      'result lists the available personas.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type:        'string',
          description:
            'Return only a specific key: ' +
            '"voice", "bio", "platforms", "project.<slug>" or "persona.<slug>". ' +
            'Omit to get the full context.',
        },
        persona: {
          type:        'string',
          description: 'Persona slug. Returns the context to write as that persona.',
        },
        account: {
          type:        'string',
          description: 'Target account as "platform/username" (or a username with platform). Resolves its persona.',
        },
        platform: {
          type:        'string',
          description: 'Platform of account when account has no "platform/" prefix.',
        },
      },
    },
    async handler({ key, persona, account, platform } = {}) {
      if (persona || account) {
        const global = await loadGlobalContext();
        const byAccount = account ? await personaForAccount(account, platform) : null;
        if (persona && account && byAccount?.slug !== persona) {
          throw new Error(`Account ${account} does not belong to persona "${persona}"${byAccount ? ` (it belongs to "${byAccount.slug}")` : ''}.`);
        }
        const selected = persona ? await getPersona(persona) : byAccount;
        if (!selected) {
          const personas = await loadPersonas();
          return {
            ...global,
            persona: null,
            note: `Account ${account} is not part of any persona; this is the shared global context.` +
              (personas.length
                ? ' Other accounts have personas with different voices, so ask the user which persona or voice ' +
                  'this account should use before writing for it.'
                : '') +
              ' Add it to instance/context/personas/<slug>.yaml to give it its own voice.',
          };
        }
        return mergePersonaContext(global, selected);
      }

      if (key) {
        const row = await queryOne(
          'SELECT value FROM user_context WHERE key = ?',
          [key],
        );
        if (!row) {
          return {
            error: `Context key "${key}" not found. Run "eanyra context sync" to populate.`,
          };
        }
        return { key, value: tryParse(row.value, row.value) };
      }

      const ctx = await loadGlobalContext();
      const personas = await loadPersonas();
      ctx.personas = personas.map(entry => ({
        slug:        entry.slug,
        name:        entry.name,
        description: entry.description,
        topics:      entry.topics,
        accounts:    entry.accounts.map(accountKey),
      }));
      if (personas.length) {
        ctx.note = 'This is the global context. Before writing for a specific account, call context_get ' +
          'with that account or persona to get its own voice, rules and projects.';
      }
      return ctx;
    },
  },
];

// accounts.json is current even before the next scrape syncs the accounts table.
async function configuredAccounts() {
  try {
    return validateAccounts(JSON.parse(await fs.readFile(PATHS.accountsConfig, 'utf8')))
      .filter(entry => entry.active !== false && entry.archive !== true);
  } catch {
    return query(`SELECT platform, username FROM accounts
      WHERE is_active = 1 AND is_archived = 0 ORDER BY platform, username`);
  }
}

async function loadGlobalContext() {
  const rows = await query('SELECT key, value FROM user_context ORDER BY key');
  const ctx  = {};
  for (const row of rows) {
    // Projects come from the projects table below; personas are listed separately.
    if (row.key.startsWith('project.') || row.key.startsWith('persona.')) continue;
    ctx[row.key] = tryParse(row.value, row.value);
  }

  const projects = await query(`
    SELECT slug, name, status, description,
           tech_stack, links, content_angles, posting_rules
    FROM   projects
    WHERE  status = 'active'
    ORDER  BY slug
  `);

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
}

// ── export_get ────────────────────────────────────────────────────────────────

const exportTools = [
  {
    name: 'export_get',
    description:
      'Return the latest export Markdown file from instance/data/exports/ as a string. ' +
      'Export files are generated by "npm run export" and contain your voice, ' +
      'platform rules, active projects, recent posts, and pending signals — ' +
      'everything needed for a content session in one document. ' +
      'Use as a fast alternative to calling context_get + posts_get + signals_get separately.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type:        'string',
          description:
            'Specific filename to load, e.g. "export-2025-04-01.md". ' +
            'Omit to get the most recent file.',
        },
        max_chars: {
          type:        'integer',
          description: `Truncate content to this many characters (default ${MCP.exportMaxChars}).`,
          default:     MCP.exportMaxChars,
        },
      },
    },
    async handler({ file, max_chars = MCP.exportMaxChars } = {}) {
      let files;
      try {
        const entries = await fs.readdir(EXPORTS_DIR);
        files = entries
          .filter(f => f.startsWith('export-') && f.endsWith('.md'))
          .sort()
          .reverse(); // newest first
      } catch {
        return {
          error:
            `Export directory not found: ${EXPORTS_DIR}. ` +
            'Run "npm run export" first.',
        };
      }

      if (!files.length) {
        return {
          error: 'No export files found in instance/data/exports/. Run "npm run export" to generate one.',
        };
      }

      const target = file ? files.find(f => f === file) : files[0];

      if (!target) {
        return { error: `File "${file}" not found.`, available: files };
      }

      const filePath = path.join(EXPORTS_DIR, target);
      const stat     = await fs.stat(filePath);
      let content    = await fs.readFile(filePath, 'utf-8');

      const truncated = content.length > max_chars;
      if (truncated) {
        content = content.slice(0, max_chars) + '\n\n[… truncated — increase max_chars to see more]';
      }

      return {
        file:            target,
        generated_at:    stat.mtime.toISOString(),
        size_chars:      content.length,
        truncated,
        available_files: files,
        content,
      };
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function tryParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

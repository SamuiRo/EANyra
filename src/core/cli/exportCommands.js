/**
 * src/core/cli/exportCommands.js
 *
 * Registers the `eanyra export` command on the Commander program.
 *
 * Usage:
 *   eanyra export                          # all sections, last 7 days
 *   eanyra export --days 14               # last 14 days
 *   eanyra export --sections twitter,github
 *   eanyra export --unused-only           # only posts not yet exported
 *   eanyra export --no-mark               # don't stamp used_for_content
 *   eanyra export --out ./my-export.md    # custom output path
 *
 * Available sections: context, projects, twitter, linkedin, github
 */

import fs   from 'node:fs/promises';
import path from 'node:path';

import { ExportRepository } from '../teapot/repositories/ExportRepository.js';
import { buildMarkdown }    from '../export/MarkdownExporter.js';
import { PROJECT_ROOT }     from '../../config/app.config.js';
import { print }            from '../../shared/utils.js';

const ALL_SECTIONS  = ['context', 'projects', 'twitter', 'linkedin', 'github'];
const DEFAULT_OUT   = path.join(PROJECT_ROOT, 'data', 'exports');

/**
 * @param {import('commander').Command} program
 * @param {object} models   — Sequelize model map from registerModels()
 */
export function registerExportCommands(program, models) {
  program
    .command('export')
    .description(
      'Export recent social data to a Markdown file for AI-assisted content creation.\n' +
      '  eanyra export                        → all sections, last 7 days\n' +
      '  eanyra export --days 14              → last 14 days\n' +
      '  eanyra export --sections twitter,github\n' +
      '  eanyra export --unused-only          → only posts not yet used\n' +
      '  eanyra export --no-mark              → skip marking posts as used',
    )
    .option(
      '--days <n>',
      'How many days back to include (default: 7)',
      v => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1) throw new Error('--days must be a positive integer');
        return n;
      },
      7,
    )
    .option(
      '--sections <list>',
      `Comma-separated sections to include. Available: ${ALL_SECTIONS.join(', ')}`,
      v => {
        const requested = v.split(',').map(s => s.trim().toLowerCase());
        const invalid   = requested.filter(s => !ALL_SECTIONS.includes(s));
        if (invalid.length) {
          throw new Error(`Unknown section(s): ${invalid.join(', ')}. Available: ${ALL_SECTIONS.join(', ')}`);
        }
        return requested;
      },
    )
    .option('--unused-only', 'Only include posts that have not been exported before', false)
    .option('--no-mark',     'Do not mark exported posts as used (dry-run mode)', false)
    .option(
      '--out <path>',
      `Output file path. Defaults to data/exports/export-YYYY-MM-DD.md`,
    )
    .action(async (opts) => {
      await runExport(models, opts);
    });
}

// ─── Core logic ───────────────────────────────────────────────────────────────

async function runExport(models, opts) {
  const {
    days        = 7,
    sections    = ALL_SECTIONS,
    unusedOnly  = false,
    mark        = true,   // Commander maps --no-mark → mark: false
    out,
  } = opts;

  print(`Starting export — sections: [${sections.join(', ')}], days: ${days}`, 'system');

  const repo        = new ExportRepository(models);
  const generatedAt = new Date();

  // ── Gather data ────────────────────────────────────────────────────────────

  const [context, twitterPosts, linkedinPosts, githubEvents] = await Promise.all([
    (sections.includes('context') || sections.includes('projects'))
      ? repo.getContext()
      : Promise.resolve({}),

    sections.includes('twitter')
      ? repo.getTwitterPosts({ days, unusedOnly })
      : Promise.resolve([]),

    sections.includes('linkedin')
      ? repo.getLinkedinPosts({ days, unusedOnly })
      : Promise.resolve([]),

    sections.includes('github')
      ? repo.getGithubEvents({ days })
      : Promise.resolve([]),
  ]);

  print(
    `Fetched: ${twitterPosts.length} tweets · ${linkedinPosts.length} LinkedIn posts · ${githubEvents.length} GitHub events`,
    'data',
  );

  // ── Build Markdown ─────────────────────────────────────────────────────────

  const markdown = buildMarkdown({
    context,
    twitterPosts,
    linkedinPosts,
    githubEvents,
    days,
    sections,
    generatedAt,
  });

  // ── Write file ─────────────────────────────────────────────────────────────

  const outPath = out
    ? path.resolve(process.cwd(), out)
    : path.join(DEFAULT_OUT, `export-${isoDate(generatedAt)}.md`);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, markdown, 'utf-8');

  print(`Export saved: ${outPath}`, 'success');

  // ── Mark posts as used ─────────────────────────────────────────────────────

  if (mark) {
    const unusedTwitter  = twitterPosts.filter(p => !p.used).map(p => p.id);
    const unusedLinkedin = linkedinPosts.filter(p => !p.used).map(p => p.id);

    if (unusedTwitter.length || unusedLinkedin.length) {
      await repo.markAsUsed({
        twitterIds:  unusedTwitter,
        linkedinIds: unusedLinkedin,
      });
      print(
        `Marked as used: ${unusedTwitter.length} tweets · ${unusedLinkedin.length} LinkedIn posts`,
        'system',
      );
    }
  } else {
    print('--no-mark active: posts were NOT marked as used.', 'warning');
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  printSummary({ twitterPosts, linkedinPosts, githubEvents, outPath });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function printSummary({ twitterPosts, linkedinPosts, githubEvents, outPath }) {
  const tw  = twitterPosts.length;
  const li  = linkedinPosts.length;
  const gh  = githubEvents.length;
  const twN = twitterPosts.filter(p => !p.used).length;
  const liN = linkedinPosts.filter(p => !p.used).length;

  console.log('');
  console.log('─────────────────────────────────────');
  console.log(' Export summary');
  console.log('─────────────────────────────────────');
  console.log(` Twitter:  ${tw} posts (${twN} new)`);
  console.log(` LinkedIn: ${li} posts (${liN} new)`);
  console.log(` GitHub:   ${gh} events`);
  console.log(` File:     ${outPath}`);
  console.log('─────────────────────────────────────');
  console.log('');
  console.log(' Next step: open the file and paste it into your AI chat.');
  console.log(' The system prompt at the bottom tells the AI how to use it.');
  console.log('');
}
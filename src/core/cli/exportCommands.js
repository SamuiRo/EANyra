/**
 * src/core/cli/exportCommands.js
 *
 * Registers the `eanyra export` command on the Commander program.
 *
 * Usage:
 *   eanyra export                           # all sections, last 7 days
 *   eanyra export --days 14                 # last 14 days
 *   eanyra export --sections posts,signals  # specific sections
 *   eanyra export --platform twitter        # only twitter posts
 *   eanyra export --unused-only             # only posts/signals not yet exported
 *   eanyra export --no-mark                 # don't stamp used_for_content
 *   eanyra export --out ./my-export.md      # custom output path
 *
 * Available sections: context, projects, posts, signals
 */

import fs   from 'node:fs/promises';
import path from 'node:path';

import { ExportRepository } from '../teapot/repositories/ExportRepository.js';
import { buildMarkdown }    from '../export/MarkdownExporter.js';
import { PROJECT_ROOT }     from '../../config/app.config.js';
import { print }            from '../../shared/utils.js';

const ALL_SECTIONS  = ['context', 'projects', 'posts', 'signals'];
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
      '  eanyra export --sections posts,signals\n' +
      '  eanyra export --platform twitter     → only twitter posts\n' +
      '  eanyra export --unused-only          → only posts/signals not yet used\n' +
      '  eanyra export --no-mark              → skip marking as used',
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
    .option(
      '--platform <name>',
      'Filter posts by platform (twitter, linkedin, telegram, …)',
    )
    .option('--unused-only', 'Only include posts/signals that have not been exported before', false)
    .option('--no-mark',     'Do not mark exported items as used (dry-run mode)', false)
    .option(
      '--out <path>',
      'Output file path. Defaults to data/exports/export-YYYY-MM-DD.md',
    )
    .action(async (opts) => {
      await runExport(models, opts);
    });
}

// ─── Core logic ───────────────────────────────────────────────────────────────

async function runExport(models, opts) {
  const {
    days       = 7,
    sections   = ALL_SECTIONS,
    platform,
    unusedOnly = false,
    mark       = true,
    out,
  } = opts;

  print(`Starting export — sections: [${sections.join(', ')}], days: ${days}`, 'system');

  const repo        = new ExportRepository(models);
  const generatedAt = new Date();

  // ── Gather data ────────────────────────────────────────────────────────────

  const [context, posts, signals] = await Promise.all([
    (sections.includes('context') || sections.includes('projects'))
      ? repo.getContext()
      : Promise.resolve({}),

    sections.includes('posts')
      ? repo.getPosts({ days, unusedOnly, platform })
      : Promise.resolve([]),

    sections.includes('signals')
      ? repo.getSignals({ days, unusedOnly })
      : Promise.resolve([]),
  ]);

  print(
    `Fetched: ${posts.length} posts · ${signals.length} signals`,
    'data',
  );

  // ── Build Markdown ─────────────────────────────────────────────────────────

  const markdown = buildMarkdown({
    context,
    posts,
    signals,
    days,
    sections,
    generatedAt,
  });

  // ── Write file ─────────────────────────────────────────────────────────────

  const outPath = out
    ? path.resolve(process.cwd(), out)
    : path.join(DEFAULT_OUT, `export-${generatedAt.toISOString().replace('T', '_').replaceAll(":","").substring(0, 19)}.md`);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, markdown, 'utf-8');

  print(`Export saved: ${outPath}`, 'success');

  // ── Mark as used ───────────────────────────────────────────────────────────
  //
  // Only items that were NOT previously used get stamped — this preserves
  // the original first-export timestamp for items that appear in multiple
  // exports (e.g. when using --no-mark for dry runs and then exporting again).
  //
  // We capture the "new" counts BEFORE calling markAsUsed so the summary
  // reflects what was actually new in this export run.

  const newPostIds   = posts.filter(p => !p.used).map(p => p.id);
  const newSignalIds = signals.filter(s => !s.used).map(s => s.id);

  if (mark) {
    if (newPostIds.length || newSignalIds.length) {
      await repo.markAsUsed({
        postIds:   newPostIds,
        signalIds: newSignalIds,
      });
      print(
        `Marked as used: ${newPostIds.length} posts · ${newSignalIds.length} signals`,
        'system',
      );
    }
  } else {
    print('--no-mark active: items were NOT marked as used.', 'warning');
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  printSummary({ posts, signals, newPostIds, newSignalIds, outPath });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function printSummary({ posts, signals, newPostIds, newSignalIds, outPath }) {
  const pTotal = posts.length;
  const pNew   = newPostIds.length;
  const sTotal = signals.length;
  const sNew   = newSignalIds.length;

  // Group posts by platform for the summary line
  const byPlatform = {};
  for (const p of posts) {
    byPlatform[p.platform] = (byPlatform[p.platform] ?? 0) + 1;
  }
  const platformLine = Object.entries(byPlatform)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || 'none';

  console.log('');
  console.log('─────────────────────────────────────');
  console.log(' Export summary');
  console.log('─────────────────────────────────────');
  console.log(` Posts:    ${pTotal} total (${pNew} new)  [${platformLine}]`);
  console.log(` Signals:  ${sTotal} total (${sNew} new)`);
  console.log(` File:     ${outPath}`);
  console.log('─────────────────────────────────────');
  console.log('');
  console.log(' Next step: open the file and paste it into your AI chat.');
  console.log(' The system prompt at the bottom tells the AI how to use it.');
  console.log('');
}
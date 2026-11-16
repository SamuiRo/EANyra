/**
 * eanyra linkedin import <file> --account <username>   put an export in place and import it now
 * eanyra linkedin history [--account <username>]       imported files, new posts, conflicts
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { LINKEDIN, PATHS } from '../../config/app.config.js';
import { normalizeAccount, validateAccounts } from '../../config/accountConfig.js';
import { parseCsvString } from '../../platforms/linkedin/csvParser.js';
import { print } from '../../shared/utils.js';
import database from '../teapot/database.js';
import { ScraperOrchestrator } from '../orchestrator/ScraperOrchestrator.js';
import { LinkedinImportRepository } from '../teapot/repositories/LinkedinImportRepository.js';
import { Credentials } from '../secrets/Credentials.js';

export function registerLinkedinCommands(program, getModels) {
  const linkedin = program.command('linkedin').description('LinkedIn data-export imports');

  linkedin.command('import <file>')
    .description('Copy a Shares.csv from a LinkedIn data export to the account\'s import file and import it now')
    .requiredOption('--account <username>', 'Configured LinkedIn account the export belongs to')
    .action(async (file, { account }) => {
      const username = normalizeAccount(account, 'linkedin');
      const entries = validateAccounts(JSON.parse(await fs.readFile(PATHS.accountsConfig, 'utf8')));
      const entry = entries.find(item => item.platform === 'linkedin' && item.username === username && item.archive !== true);
      if (!entry) throw new Error(`linkedin/${username} is not an active account in accounts.json.`);
      const others = entries.filter(item => item.platform === 'linkedin' && item !== entry && item.archive !== true &&
        (item.import_file ?? LINKEDIN.sharesFile) === (entry.import_file ?? LINKEDIN.sharesFile));
      if (others.length) {
        throw new Error(`linkedin/${username} shares its import file with ${others.map(o => `linkedin/${o.username}`).join(', ')}. ` +
          'Give each account its own "import_file" in accounts.json first.');
      }

      const source = path.resolve(file);
      const header = parseCsvString((await fs.readFile(source, 'utf8')).split(/\r?\n/).slice(0, 2).join('\n'))[0] ?? {};
      for (const column of ['Date', 'ShareLink']) {
        if (!(column in header)) throw new Error(`${source} is not a LinkedIn Shares.csv (missing the ${column} column).`);
      }

      const target = path.join(LINKEDIN.importsDir, entry.import_file ?? LINKEDIN.sharesFile);
      if (path.resolve(target) !== source) {
        await fs.mkdir(LINKEDIN.importsDir, { recursive: true });
        await fs.copyFile(source, target);
        print(`Copied to ${target}.`, 'system');
      }

      const imports = new LinkedinImportRepository(database.sequelize);
      const [before] = await imports.history({ username, limit: 1 });
      const credentials = await Credentials.open({ interactive: false }).catch(() => new Credentials());
      const run = await new ScraperOrchestrator(getModels(), { credentials })
        .run({ platform: 'linkedin', accounts: [username] });
      const [latest] = await imports.history({ username, limit: 1 });
      if (latest && before && latest.id === before.id && run.status === 'success') {
        print(`linkedin/${username}: this export was already imported on ${new Date(latest.imported_at).toISOString().slice(0, 10)}; nothing new.`, 'success');
      } else if (latest) {
        print(`linkedin/${username}: ${latest.status}, ${latest.rows} row(s), ${latest.new_posts} new post(s)` +
          (latest.conflicts ? `, ${latest.conflicts} skipped (belong to another account)` : '') + '.', run.status === 'success' ? 'success' : 'warning');
      } else {
        print(`Run ${run.status}${run.error_message ? `: ${run.error_message}` : ''}.`, run.status === 'success' ? 'success' : 'warning');
      }
      await database.disconnect();
    });

  linkedin.command('history')
    .description('Show imported LinkedIn export files')
    .option('--account <username>', 'Only this account')
    .option('--limit <n>', 'Rows to show', '20')
    .action(async ({ account, limit }) => {
      const rows = await new LinkedinImportRepository(database.sequelize).history({
        username: account ? normalizeAccount(account, 'linkedin') : undefined,
        limit: Math.max(1, Math.min(Number(limit) || 20, 200)),
      });
      if (!rows.length) print('No LinkedIn imports yet.', 'info');
      for (const row of rows) {
        print(`${new Date(row.imported_at).toISOString().slice(0, 16).replace('T', ' ')}  linkedin/${row.username}  ${row.file_name}  ` +
          `${row.status}  rows ${row.rows}, new ${row.new_posts}${row.conflicts ? `, conflicts ${row.conflicts}` : ''}` +
          (row.newest_post_at ? `, newest post ${new Date(row.newest_post_at).toISOString().slice(0, 10)}` : '') +
          (row.error ? `  — ${row.error}` : ''), row.status === 'failed' ? 'error' : 'data');
      }
      await database.disconnect();
    });
}

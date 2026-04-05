import { UserContextRepository } from '../teapot/repositories/UserContextRepository.js';
import { print }                 from '../../shared/utils.js';

/**
 * Register `eanyra context` sub-commands on the Commander program.
 *
 * Commands:
 *   eanyra context sync   – read YAML files → upsert into DB
 *   eanyra context show   – print current DB state (what the agent sees)
 *
 * @param {import('commander').Command} program
 * @param {{ UserContext, Project }}    models
 */
export function registerContextCommands(program, models) {
  const repo = new UserContextRepository(models);

  const ctx = program
    .command('context')
    .description('Manage user context (voice, bio, platforms, projects)');

  // ── eanyra context sync ───────────────────────────────────────────────────
  ctx
    .command('sync')
    .description('Read YAML files from src/context/ and sync into the database')
    .action(async () => {
      print('Syncing context from YAML files…', 'system');

      const { updated, skipped, errors } = await repo.sync();

      if (updated.length) {
        print(`Updated: ${updated.join(', ')}`, 'success');
      }
      if (skipped.length) {
        print(`Skipped: ${skipped.join(', ')}`, 'warning');
      }
      if (errors.length) {
        for (const err of errors) {
          print(`Error: ${err}`, 'error');
        }
      }

      if (!errors.length) {
        print('Context sync complete.', 'success');
      } else {
        print('Context sync finished with errors.', 'warning');
      }
    });

  // ── eanyra context show ───────────────────────────────────────────────────
  ctx
    .command('show')
    .description('Print the current user context from the database')
    .option('-k, --key <key>', 'Show only a specific key (e.g. voice, bio, platforms, project.eanyra)')
    .action(async ({ key } = {}) => {
      if (key) {
        const value = await repo.getKey(key);
        if (value === null) {
          print(`Key "${key}" not found. Run "eanyra context sync" first.`, 'warning');
          return;
        }
        console.log(JSON.stringify(value, null, 2));
        return;
      }

      const all = await repo.getAll();
      if (!Object.keys(all).length) {
        print('No context in database. Run "eanyra context sync" first.', 'warning');
        return;
      }

      console.log(JSON.stringify(all, null, 2));
    });
}
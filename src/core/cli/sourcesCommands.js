/**
 * eanyra sources collect [--persona <slug>]   read persona sources now; new links become signals
 * eanyra sources status  [--persona <slug>]   configured sources and their last outcome
 *
 * A full `eanyra scrape` (and every scheduled run) reads all sources too.
 */

import { print } from '../../shared/utils.js';
import database from '../teapot/database.js';
import { sequelizeExecutor } from '../services/sql.js';
import { SourceCollector } from '../sources/SourceCollector.js';
import { Credentials } from '../secrets/Credentials.js';

export function registerSourcesCommands(program) {
  const sources = program.command('sources').description('Persona sources (GitHub, Reddit, RSS) → signals');

  sources.command('collect')
    .description('Read the configured sources now; every new link becomes a signal of its persona')
    .option('--persona <slug>', 'Only this persona')
    .action(async ({ persona }) => {
      const db = sequelizeExecutor(database.sequelize);
      const personas = await load(db, persona);
      if (!personas.length) {
        print(persona ? `Persona "${persona}" has no sources (or does not exist; run context sync).` : 'No persona has sources.', 'warning');
        await database.disconnect();
        return;
      }
      const credentials = await Credentials.open({ interactive: false }).catch(() => null);
      let githubToken = '';
      try { githubToken = credentials?.githubToken() ?? ''; } catch { /* anonymous search */ }
      const summary = await new SourceCollector(db, { githubToken }).collect(personas);
      for (const group of summary.personas) {
        for (const source of group.sources) {
          print(`${group.persona}  ${source.key}: ${source.error ? `failed — ${source.error}` : `${source.found} read, ${source.saved} new`}`,
            source.error ? 'warning' : 'data');
        }
      }
      print(`${summary.saved} new signal(s) from ${summary.found} link(s)` + (summary.failed ? `; ${summary.failed} source(s) failed` : '') + '.',
        summary.failed ? 'warning' : 'success');
      await database.disconnect();
    });

  sources.command('status')
    .description('Show configured sources and the outcome of their last read')
    .option('--persona <slug>', 'Only this persona')
    .action(async ({ persona }) => {
      const db = sequelizeExecutor(database.sequelize);
      const collector = new SourceCollector(db);
      const personas = await load(db, persona);
      if (!personas.length) print('No persona has sources.', 'info');
      for (const entry of personas) {
        const state = await collector.status(entry.slug);
        for (const source of entry.sources) {
          const last = state[source.key];
          print(`${entry.slug}  ${source.key}  ` + (last
            ? `${last.last_run_at.slice(0, 16).replace('T', ' ')}  ${last.error ? `failed — ${last.error}` : `${last.found} read, ${last.saved} new`}`
            : 'never read'), last?.error ? 'warning' : 'data');
        }
      }
      await database.disconnect();
    });
}

async function load(db, slug) {
  const rows = await db.all("SELECT value FROM user_context WHERE key LIKE 'persona.%' ORDER BY key");
  return rows.map(row => JSON.parse(row.value))
    .filter(persona => (!slug || persona.slug === slug) && persona.sources?.length);
}

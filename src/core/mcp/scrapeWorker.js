import database from '../teapot/database.js';
import { registerModels } from '../teapot/models/index.js';
import { SchemaMigrator } from '../teapot/SchemaMigrator.js';
import { ScraperOrchestrator } from '../orchestrator/ScraperOrchestrator.js';
import { Credentials } from '../secrets/Credentials.js';
import { useVaultKey } from '../secrets/vaultAccess.js';
import { JobStore } from '../services/JobStore.js';
import { sequelizeExecutor } from '../services/sql.js';

process.once('message', async ({ jobId, selection, vaultKey }) => {
  let outcome;
  let jobs = null;
  try {
    useVaultKey(vaultKey);
    await database.connect();
    const models = registerModels(database.sequelize);
    await new SchemaMigrator(database.sequelize).migrate();
    jobs = new JobStore(sequelizeExecutor(database.sequelize));
    if (jobId) await jobs.start(jobId);
    const credentials = await Credentials.open({ interactive: false });
    const result = await new ScraperOrchestrator(models, { credentials }).run(selection);
    outcome = { result };
    if (jobId) await jobs.finish(jobId, { status: result.status === 'running' ? 'failed' : result.status, result: summarize(result), error: result.error_message ?? null });
  } catch (error) {
    outcome = { error: error.message };
    if (jobId && jobs) await jobs.finish(jobId, { status: 'failed', error: error.message }).catch(() => {});
  } finally {
    await database.disconnect().catch(() => {});
  }
  process.send(outcome, () => process.exit(outcome.error ? 1 : 0));
});

function summarize(run) {
  const { id, status, accounts_processed, posts_saved, signals_saved, started_at, finished_at } = run;
  return { run_id: id, status, accounts_processed, posts_saved, signals_saved, started_at, finished_at };
}

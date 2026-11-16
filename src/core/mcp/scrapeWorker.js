import database from '../teapot/database.js';
import { registerModels } from '../teapot/models/index.js';
import { SchemaMigrator } from '../teapot/SchemaMigrator.js';
import { ScraperOrchestrator } from '../orchestrator/ScraperOrchestrator.js';
import { Credentials } from '../secrets/Credentials.js';
import { useVaultKey } from '../secrets/vaultAccess.js';
import { JobStore } from '../services/JobStore.js';
import { sequelizeExecutor } from '../services/sql.js';

// A stop request (IPC { type: 'stop' }, or Ctrl+C reaching the whole console
// group on Windows) finishes the current account, saves sessions, finalizes
// the run and releases the lock instead of dying mid-collection.
const stop = new AbortController();
const requestStop = () => stop.abort();
process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

let started = false;
process.on('message', message => {
  if (message?.type === 'stop') {
    requestStop();
    return;
  }
  if (started) return;
  started = true;
  void run(message);
});

async function run({ jobId, selection, vaultKey }) {
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
    const result = await new ScraperOrchestrator(models, { credentials }).run(selection, { signal: stop.signal });
    outcome = { result };
    if (jobId) await jobs.finish(jobId, { status: result.status === 'running' ? 'failed' : result.status, result: summarize(result), error: result.error_message ?? null });
  } catch (error) {
    outcome = { error: error.message };
    if (jobId && jobs) await jobs.finish(jobId, { status: 'failed', error: error.message }).catch(() => {});
  } finally {
    await database.disconnect().catch(() => {});
  }
  process.send(outcome, () => process.exit(outcome.error ? 1 : 0));
}

function summarize(run) {
  const { id, status, accounts_processed, posts_saved, signals_saved, started_at, finished_at } = run;
  return { run_id: id, status, accounts_processed, posts_saved, signals_saved, started_at, finished_at };
}

/**
 * Applies pending schema migrations for the MCP server.
 *
 * Runs in a child process because the CLI database layer logs to stdout,
 * which is the MCP stdio protocol channel in the parent.
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function migrateInWorker({ timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--run'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, execArgv: [],
    });
    let outcome = null;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('message', message => { outcome = message; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0 && outcome && !outcome.error) resolve(outcome.applied);
      else reject(new Error(outcome?.error ?? `Migration worker exited with ${code}.`));
    });
  });
}

if (process.argv[2] === '--run' && process.send) {
  const { default: database } = await import('../teapot/database.js');
  const { SchemaMigrator } = await import('../teapot/SchemaMigrator.js');
  let outcome;
  try {
    await database.connect();
    outcome = { applied: await new SchemaMigrator(database.sequelize).migrate() };
  } catch (error) {
    outcome = { error: error.message };
  } finally {
    await database.disconnect().catch(() => {});
  }
  process.send(outcome, () => process.exit(outcome.error ? 1 : 0));
}

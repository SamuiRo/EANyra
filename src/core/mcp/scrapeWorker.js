import database from '../teapot/database.js';
import { registerModels } from '../teapot/models/index.js';
import { SchemaMigrator } from '../teapot/SchemaMigrator.js';
import { ScraperOrchestrator } from '../orchestrator/ScraperOrchestrator.js';
import { Credentials } from '../secrets/Credentials.js';
import { useVaultKey } from '../secrets/vaultAccess.js';

process.once('message', async ({ selection, vaultKey }) => {
  let outcome;
  try {
    useVaultKey(vaultKey);
    await database.connect();
    const models = registerModels(database.sequelize);
    await new SchemaMigrator(database.sequelize).migrate();
    const credentials = await Credentials.open({ interactive: false });
    outcome = { result: await new ScraperOrchestrator(models, { credentials }).run(selection) };
  } catch (error) {
    outcome = { error: error.message };
  } finally {
    await database.disconnect().catch(() => {});
  }
  process.send(outcome, () => process.exit(outcome.error ? 1 : 0));
});

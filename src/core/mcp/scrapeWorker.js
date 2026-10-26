import database from '../teapot/database.js';
import { registerModels } from '../teapot/models/index.js';
import { SchemaMigrator } from '../teapot/SchemaMigrator.js';
import { ScraperOrchestrator } from '../orchestrator/ScraperOrchestrator.js';

process.once('message', async selection => {
  let outcome;
  try {
    await database.connect();
    const models = registerModels(database.sequelize);
    await new SchemaMigrator(database.sequelize).migrate();
    outcome = { result: await new ScraperOrchestrator(models).run(selection) };
  } catch (error) {
    outcome = { error: error.message };
  } finally {
    await database.disconnect().catch(() => {});
  }
  process.send(outcome, () => process.exit(outcome.error ? 1 : 0));
});

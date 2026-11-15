import database from '../teapot/database.js';
import { SchemaMigrator } from '../teapot/SchemaMigrator.js';
import { TelegramOutboxRepository } from '../teapot/repositories/TelegramOutboxRepository.js';
import { TelegramPublisher } from '../../platforms/telegram/TelegramPublisher.js';
import { buildGatewayFor } from '../../platforms/telegram/publishGateways.js';
import { Credentials } from '../secrets/Credentials.js';
import { useVaultKey } from '../secrets/vaultAccess.js';

process.once('message', async ({ operation, args, vaultKey }) => {
  let outcome;
  try {
    if (!['prepare', 'publish', 'get', 'targets', 'identity'].includes(operation)) throw new Error('Unsupported Telegram publication operation.');
    useVaultKey(vaultKey);
    await database.connect();
    await new SchemaMigrator(database.sequelize).migrate();
    // Secrets are needed only for operations that reach Telegram.
    const needsSecrets = ['publish', 'identity'].includes(operation);
    const credentials = needsSecrets ? await Credentials.open({ interactive: false }) : null;
    const publisher = new TelegramPublisher({
      outbox: new TelegramOutboxRepository(database.sequelize),
      gatewayFor: credentials ? buildGatewayFor(credentials) : () => { throw new Error('Telegram credentials are not loaded for this operation.'); },
    });
    outcome = { result: await publisher[operation](args) };
  } catch (error) {
    outcome = { error: error.message };
  } finally {
    await database.disconnect().catch(() => {});
  }
  process.send(outcome, () => process.exit(outcome.error ? 1 : 0));
});

import database from '../teapot/database.js';
import { SchemaMigrator } from '../teapot/SchemaMigrator.js';
import { TelegramOutboxRepository } from '../teapot/repositories/TelegramOutboxRepository.js';
import { TelegramPublisher } from '../../platforms/telegram/TelegramPublisher.js';
import { TelegramPublishGateway } from '../../platforms/telegram/TelegramPublishGateway.js';
import { TelegramBotGateway } from '../../platforms/telegram/TelegramBotGateway.js';
import { TELEGRAM } from '../../config/app.config.js';

process.once('message', async ({ operation, args }) => {
  let outcome;
  try {
    if (!['prepare', 'publish', 'get', 'targets', 'identity'].includes(operation)) throw new Error('Unsupported Telegram publication operation.');
    if (!['bot', 'mtproto'].includes(TELEGRAM.publishTransport)) throw new Error('TELEGRAM_PUBLISH_TRANSPORT must be bot or mtproto.');
    await database.connect();
    await new SchemaMigrator(database.sequelize).migrate();
    const gateway = TELEGRAM.publishTransport === 'bot' ? new TelegramBotGateway() : new TelegramPublishGateway();
    const publisher = new TelegramPublisher({
      outbox: new TelegramOutboxRepository(database.sequelize),
      gateway,
    });
    outcome = { result: operation === 'identity' ? await gateway.identity() : await publisher[operation](args) };
  } catch (error) {
    outcome = { error: error.message };
  } finally {
    await database.disconnect().catch(() => {});
  }
  process.send(outcome, () => process.exit(outcome.error ? 1 : 0));
});

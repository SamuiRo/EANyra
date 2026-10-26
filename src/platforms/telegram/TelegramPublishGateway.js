import { TelegramClient } from './TelegramClient.js';
import { buildTelegramMessageUrl } from './TelegramMessageParser.js';

export class TelegramPublishGateway {
  constructor({ clientManager = new TelegramClient() } = {}) {
    this.manager = clientManager;
  }

  async identity() {
    return { transport: 'mtproto', next_action: 'Publishing uses the configured Telegram user session, not a bot. Set TELEGRAM_PUBLISH_TRANSPORT=bot and TELEGRAM_BOT_TOKEN to publish as a bot.' };
  }

  async resolve(account) {
    const client = await this.manager.connect();
    client.floodSleepThreshold = 0;
    const entity = await client.getEntity(account);
    if (entity.className !== 'Channel' || entity.broadcast !== true) {
      throw new Error('Publishing is supported only to broadcast Telegram channels, not private users or groups.');
    }
    if (!entity.creator && !entity.adminRights?.postMessages) {
      throw new Error('The Telegram session lacks permission to publish to this channel.');
    }
    return { client, entity, peer: await client.getInputEntity(entity) };
  }

  async send({ client, entity, peer }, draft) {
    const [{ Api }, { readBigIntFromBuffer }] = await Promise.all([
      import('telegram'), import('telegram/Helpers.js'),
    ]);
    const randomId = readBigIntFromBuffer(Buffer.from(draft.random_id, 'hex'), true, true);
    const result = await client.invoke(new Api.messages.SendMessage({
      peer, message: draft.text, randomId, noWebpage: Boolean(draft.disable_preview),
      // No parsing or splitting: the exact plain text from the preview is sent.
    }));
    const mapping = result.updates?.find(update =>
      update.className === 'UpdateMessageID' && update.randomId?.toString() === randomId.toString());
    const channelPost = result.updates?.find(update =>
      update.className === 'UpdateNewChannelMessage' &&
      update.message?.peerId?.channelId?.toString() === entity.id.toString());
    const messageId = result.className === 'UpdateShortSentMessage'
      ? result.id : (mapping?.id ?? channelPost?.message.id);
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new Error('Telegram accepted the request but returned no identifiable post. Reconcile the channel before any retry.');
    }
    return {
      channel_id: entity.id.toString(), message_id: messageId,
      url: buildTelegramMessageUrl(entity.username ?? `-100${entity.id}`, String(messageId)),
      sent_at: new Date().toISOString(),
    };
  }

  async close() {
    // Also close a partially connected client if authentication failed.
    if (this.manager.client) await this.manager.client.disconnect();
  }
}
